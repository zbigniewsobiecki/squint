import type { Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../../db/database-facade.js';
import type { Module } from '../../../db/schema.js';
import type { LlmOptions } from '../../llm/_shared/base-llm-command.js';
import { parseRow } from '../../llm/_shared/csv-utils.js';
import { completeWithLogging } from '../../llm/_shared/llm-utils.js';
import { type ProcessGroups, areSameProcess, getProcessDescription } from '../../llm/_shared/process-utils.js';
import type { InferredInteraction } from './cross-process-inferrer.js';
import { gateInferredInteraction } from './interaction-gates.js';

/**
 * Run coverage validation loop: find uncovered module pairs and use targeted LLM inference
 * to fill gaps until coverage meets the minimum threshold or retries are exhausted.
 */
export async function runCoverageInference(
  db: IndexDatabase,
  processGroups: ProcessGroups,
  model: string,
  command: Command,
  isJson: boolean,
  verbose: boolean,
  llmOptions: LlmOptions,
  opts: { minRelCoverage: number; maxGateRetries: number }
): Promise<void> {
  const allModules = db.modules.getAll();
  const moduleMap = new Map(allModules.map((m) => [m.id, m]));
  for (let attempt = 0; attempt < opts.maxGateRetries; attempt++) {
    const coverageCheck = db.interactionAnalysis.getRelationshipCoverage();
    const breakdown = db.interactionAnalysis.getRelationshipCoverageBreakdown();

    if (coverageCheck.coveragePercent >= opts.minRelCoverage || breakdown.noCallEdge === 0) {
      break;
    }

    if (!isJson) {
      if (attempt === 0) {
        command.log('');
        command.log(chalk.bold('Step 4: Coverage Validation (Targeted Inference)'));
      }
      command.log(
        chalk.gray(
          `  Coverage: ${coverageCheck.coveragePercent.toFixed(1)}% (target: ${opts.minRelCoverage}%), ${breakdown.noCallEdge} uncovered pairs`
        )
      );
    }

    const uncoveredPairs = db.interactionAnalysis.getUncoveredModulePairs();
    if (uncoveredPairs.length === 0) break;

    // Pre-filter: partition into auto-skip, auto-flip, and needs-llm
    const needsLlm: typeof uncoveredPairs = [];
    let autoSkipCount = 0;

    for (const pair of uncoveredPairs) {
      const fromMod = moduleMap.get(pair.fromModuleId);
      const toMod = moduleMap.get(pair.toModuleId);

      if (!fromMod || !toMod) {
        autoSkipCount++;
        continue;
      }

      // Cross-process pairs ALWAYS go to LLM (they communicate via runtime protocols)
      if (!areSameProcess(pair.fromModuleId, pair.toModuleId, processGroups)) {
        needsLlm.push(pair);
        continue;
      }

      // Same-layer: check import paths
      const hasForwardImports = db.interactions.hasModuleImportPath(pair.fromModuleId, pair.toModuleId);

      if (hasForwardImports) {
        // Has forward imports → send to LLM for confirmation
        needsLlm.push(pair);
        continue;
      }

      // No forward imports for same-layer pair
      const hasReverseAst = db.interactionAnalysis.hasReverseInteraction(pair.fromModuleId, pair.toModuleId);
      if (hasReverseAst) {
        // Direction confusion: reverse AST interaction exists → auto-skip
        if (verbose && !isJson) {
          command.log(chalk.gray(`  Auto-skip (reversed): ${pair.fromPath} → ${pair.toPath}`));
        }
        autoSkipCount++;
        continue;
      }

      const hasReverseImports = db.interactions.hasModuleImportPath(pair.toModuleId, pair.fromModuleId);
      if (hasReverseImports) {
        // No forward, but reverse imports → direction confusion, auto-skip
        if (verbose && !isJson) {
          command.log(chalk.gray(`  Auto-skip (reverse imports): ${pair.fromPath} → ${pair.toPath}`));
        }
        autoSkipCount++;
        continue;
      }

      // No imports in either direction for same-layer → auto-skip
      autoSkipCount++;
      if (verbose && !isJson) {
        command.log(chalk.gray(`  Auto-skip (no imports): ${pair.fromPath} → ${pair.toPath}`));
      }
    }

    if (!isJson && autoSkipCount > 0) {
      command.log(chalk.gray(`  Pre-filtered: ${autoSkipCount} pairs auto-skipped, ${needsLlm.length} sent to LLM`));
    }

    if (needsLlm.length === 0) break;

    const targetedResults = await inferTargetedInteractions(
      db,
      needsLlm,
      moduleMap,
      processGroups,
      model,
      command,
      isJson,
      llmOptions
    );

    let targetedCount = 0;
    for (const ti of targetedResults) {
      try {
        // Derive symbols from imports or relationship annotations
        const importedSymbols = db.interactions.getModuleImportedSymbols(ti.fromModuleId, ti.toModuleId);
        let symbols: string[];
        if (importedSymbols.length > 0) {
          symbols = importedSymbols.map((s) => s.name);
        } else {
          symbols = db.interactionAnalysis.getRelationshipSymbolsForPair(ti.fromModuleId, ti.toModuleId);
        }

        db.interactions.upsert(ti.fromModuleId, ti.toModuleId, {
          semantic: ti.reason,
          source: 'llm-inferred',
          pattern: 'business',
          symbols: symbols.length > 0 ? symbols : undefined,
          weight: 1,
          confidence: ti.confidence ?? 'medium',
        });
        targetedCount++;
      } catch {
        // Skip duplicates
      }
    }

    if (!isJson) {
      command.log(chalk.green(`  Pass ${attempt + 1}: Added ${targetedCount} targeted interactions`));
    }

    if (targetedCount === 0) break;
  }
}

/**
 * Infer targeted interactions for specific uncovered module pairs.
 * These are module pairs with symbol-level relationships but no detected interaction.
 * Prompt is enriched with module descriptions, import evidence, and relationship details.
 */
async function inferTargetedInteractions(
  db: IndexDatabase,
  uncoveredPairs: Array<{
    fromModuleId: number;
    toModuleId: number;
    fromPath: string;
    toPath: string;
    relationshipCount: number;
  }>,
  moduleMap: Map<number, Module>,
  processGroups: ProcessGroups,
  model: string,
  command: Command,
  isJson: boolean,
  llmOptions: LlmOptions
): Promise<InferredInteraction[]> {
  if (uncoveredPairs.length === 0) return [];

  const systemPrompt = `You are reviewing module pairs that have symbol-level relationships but no detected interaction.
For each pair, determine if a real runtime interaction exists and describe it.

PRECISION OVER RECALL — when in doubt, SKIP. Only CONFIRM connections where you can identify a concrete data flow from a specific source member to a specific target member.

## Decision Rules (CRITICAL)
- If "Forward imports: NONE" AND "Process: same-process" → SKIP (no static dependency exists)
- If "Reverse AST interaction: YES" → SKIP (the relationship direction is reversed; the reverse is already detected)
- If "Forward imports: YES" → CONFIRM is likely valid
- If "Process: separate-process" → use module descriptions and relationship semantics to decide
- When in doubt about same-process pairs with no imports → SKIP (trust static analysis)

## Output Format
\`\`\`csv
from_module_path,to_module_path,action,reason
project.backend.services.billing,project.backend.data.models.transaction,CONFIRM,"Billing service records transaction status on completion"
project.shared.types,project.backend.models,SKIP,"Shared type definitions, no runtime interaction"
\`\`\`

For each pair:
- CONFIRM if a real interaction exists (provide a semantic description as reason)
- SKIP if it's an artifact (shared types, transitive dependency, test-only, or no static evidence)`;

  // Pre-fetch purposes for all member definitions to avoid N individual queries
  const allModuleIds = new Set(uncoveredPairs.flatMap((p) => [p.fromModuleId, p.toModuleId]));
  const memberDefIds: number[] = [];
  for (const modId of allModuleIds) {
    const symbols = db.modules.getSymbols(modId);
    for (const s of symbols.slice(0, 5)) {
      memberDefIds.push(s.id);
    }
  }
  const memberPurposeMap = db.metadata.getValuesByKey(memberDefIds, 'purpose');

  // Build enriched pair descriptions
  const pairDescriptions = uncoveredPairs
    .map((p, i) => {
      const fromMod = moduleMap.get(p.fromModuleId);
      const toMod = moduleMap.get(p.toModuleId);

      // Module descriptions
      const fromDesc = fromMod ? `${fromMod.name}${fromMod.description ? ` - ${fromMod.description}` : ''}` : '';
      const toDesc = toMod ? `${toMod.name}${toMod.description ? ` - ${toMod.description}` : ''}` : '';

      // Process info
      const processDesc = getProcessDescription(p.fromModuleId, p.toModuleId, processGroups);

      // Import evidence
      const hasForwardImports = db.interactions.hasModuleImportPath(p.fromModuleId, p.toModuleId);
      const hasReverseImports = db.interactions.hasModuleImportPath(p.toModuleId, p.fromModuleId);
      const forwardImportStr = hasForwardImports ? 'YES' : 'NONE';
      const reverseImportStr = hasReverseImports ? 'YES' : 'NONE';

      // Reverse AST interaction
      const hasReverseAst = db.interactionAnalysis.hasReverseInteraction(p.fromModuleId, p.toModuleId);

      // Relationship details
      const relDetails = db.interactionAnalysis.getRelationshipDetailsForModulePair(p.fromModuleId, p.toModuleId);

      let desc = `${i + 1}. ${p.fromPath} → ${p.toPath}`;
      if (fromDesc) desc += `\n   From: "${fromDesc}"`;
      if (toDesc) desc += `\n   To: "${toDesc}"`;
      desc += `\n   Process: ${processDesc}`;
      desc += `\n   Forward imports: ${forwardImportStr} | Reverse imports: ${reverseImportStr} | Reverse AST interaction: ${hasReverseAst ? 'YES' : 'NO'}`;

      if (relDetails.length > 0) {
        desc += `\n   Relationship symbols (${relDetails.length}):`;
        for (const rd of relDetails.slice(0, 5)) {
          desc += `\n     - ${rd.fromName} → ${rd.toName}: "${rd.semantic}"`;
        }
        if (relDetails.length > 5) {
          desc += `\n     (+${relDetails.length - 5} more)`;
        }
      }

      // Key members with purposes
      const fromMembers = db.modules.getSymbols(p.fromModuleId).slice(0, 5);
      const toMembers = db.modules.getSymbols(p.toModuleId).slice(0, 5);
      if (fromMembers.length > 0) {
        desc += '\n   Source members:';
        for (const m of fromMembers) {
          const purpose = memberPurposeMap.get(m.id);
          desc += `\n     - ${m.name} (${m.kind})${purpose ? ` — ${purpose}` : ''}`;
        }
      }
      if (toMembers.length > 0) {
        desc += '\n   Target members:';
        for (const m of toMembers) {
          const purpose = memberPurposeMap.get(m.id);
          desc += `\n     - ${m.name} (${m.kind})${purpose ? ` — ${purpose}` : ''}`;
        }
      }

      return desc;
    })
    .join('\n');

  const userPrompt = `## Module Pairs to Evaluate (${uncoveredPairs.length})

${pairDescriptions}

Evaluate each pair and output CONFIRM or SKIP in CSV format.`;

  if (llmOptions.showLlmRequests) {
    command.log(chalk.cyan('='.repeat(60)));
    command.log(chalk.cyan('LLM REQUEST - inferTargetedInteractions'));
    command.log(chalk.gray(systemPrompt));
    command.log(chalk.gray(userPrompt));
  }

  const response = await completeWithLogging({
    model,
    systemPrompt,
    userPrompt,
    temperature: 0,
    maxTokens: 8192,
    command,
    isJson,
  });

  if (llmOptions.showLlmResponses) {
    command.log(chalk.green('='.repeat(60)));
    command.log(chalk.green('LLM RESPONSE'));
    command.log(chalk.gray(response));
  }

  // Parse response
  const results: InferredInteraction[] = [];
  const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/);
  const csv = csvMatch ? csvMatch[1] : response;

  const pairByPaths = new Map(uncoveredPairs.map((p) => [`${p.fromPath}|${p.toPath}`, p]));
  const moduleByPath = new Map(Array.from(moduleMap.values()).map((m) => [m.fullPath, m]));

  // Build existingInteractionPairs for gating
  const existingInteractions = db.interactions.getAll();
  const existingInteractionPairs = new Set(existingInteractions.map((i) => `${i.fromModuleId}->${i.toModuleId}`));

  for (const line of csv.split('\n')) {
    if (!line.trim() || line.startsWith('from_module')) continue;

    const fields = parseRow(line);
    if (!fields || fields.length < 4) continue;

    const [fromPath, toPath, action, reason] = fields;

    if (action.trim().toUpperCase() !== 'CONFIRM') continue;

    const pair = pairByPaths.get(`${fromPath.trim()}|${toPath.trim()}`);
    if (!pair) continue;

    const fromModule = moduleByPath.get(pair.fromPath);
    const toModule = moduleByPath.get(pair.toPath);
    if (!fromModule || !toModule) continue;

    // Apply structural gating
    const gate = gateInferredInteraction(fromModule, toModule, existingInteractionPairs, db);
    if (!gate.pass) continue;

    results.push({
      fromModuleId: pair.fromModuleId,
      toModuleId: pair.toModuleId,
      reason: reason?.replace(/"/g, '').trim() ?? 'Targeted inference',
      confidence: 'medium',
    });
  }

  return results;
}
