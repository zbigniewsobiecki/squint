import type { Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../../db/database-facade.js';
import type { Module, ModuleCallEdge, ModuleWithMembers } from '../../../db/schema.js';
import type { LlmOptions } from '../../llm/_shared/base-llm-command.js';
import { parseRow } from '../../llm/_shared/csv-utils.js';
import { completeWithLogging } from '../../llm/_shared/llm-utils.js';
import {
  type ProcessGroups,
  getCrossProcessGroupPairs,
  getProcessGroupLabel,
} from '../../llm/_shared/process-utils.js';
import { gateInferredInteraction } from './interaction-gates.js';

export interface InferredInteraction {
  fromModuleId: number;
  toModuleId: number;
  reason: string;
  confidence?: 'high' | 'medium';
}

/**
 * Infer cross-process interactions between modules in different process groups.
 * Uses import graph connectivity (union-find) to detect process boundaries,
 * then asks LLM to identify runtime connections between separate processes.
 */
export async function inferCrossProcessInteractions(
  db: IndexDatabase,
  processGroups: ProcessGroups,
  existingEdges: ModuleCallEdge[],
  model: string,
  command: Command,
  isJson: boolean,
  llmOptions: LlmOptions
): Promise<InferredInteraction[]> {
  if (processGroups.groupCount < 2) {
    command.log(chalk.gray('  Single process group — no cross-process inference needed'));
    return [];
  }

  const modules = db.modules.getAll();
  const modulesWithMembers = db.modules.getAllWithMembers();

  // Build existing edge lookup to avoid duplicates
  const existingPairs = new Set(existingEdges.map((e) => `${e.fromModuleId}->${e.toModuleId}`));

  // Also include existing interactions (both AST and already-inferred)
  const existingInteractions = db.interactions.getAll();
  for (const interaction of existingInteractions) {
    existingPairs.add(`${interaction.fromModuleId}->${interaction.toModuleId}`);
  }

  // Build members lookup for enriched prompt
  const membersMap = new Map(modulesWithMembers.map((m) => [m.id, m]));

  const allResults: InferredInteraction[] = [];
  const crossProcessPairs = getCrossProcessGroupPairs(processGroups);

  for (const [groupA, groupB] of crossProcessPairs) {
    const labelA = getProcessGroupLabel(groupA);
    const labelB = getProcessGroupLabel(groupB);

    const systemPrompt = buildCrossProcessSystemPrompt();
    const userPrompt = buildCrossProcessUserPrompt(
      groupA,
      groupB,
      labelA,
      labelB,
      existingEdges,
      modules,
      membersMap,
      db
    );

    if (llmOptions.showLlmRequests) {
      command.log(chalk.cyan('='.repeat(60)));
      command.log(chalk.cyan(`LLM REQUEST - inferCrossProcessInteractions (${labelA} <-> ${labelB})`));
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

    const results = parseLogicalInteractionCSV(response, modules, existingPairs, db);
    allResults.push(...results);
  }

  return allResults;
}

/**
 * Build system prompt for cross-process inference.
 */
function buildCrossProcessSystemPrompt(): string {
  return `You identify LOGICAL runtime connections between modules in separate processes.
These modules have NO import connectivity — they communicate via runtime protocols
(HTTP/REST, gRPC, WebSocket, IPC, message queues, CLI invocation, file I/O, etc.).

For each connection:
- Identify the SOURCE module (the one initiating the call/request)
- Identify the TARGET module (the one handling/receiving)
- Describe the communication mechanism and purpose

Use entity/name matching to pair modules:
- "useAccounts" (process A) likely calls "accountController" (process B)
- Match by entity name, action verbs, and module descriptions

Only report connections with medium or high confidence.

## Output Format
\`\`\`csv
from_module_path,to_module_path,reason,confidence
project.frontend.hooks.useAccounts,project.backend.api.controllers,"Account data hooks call account API controllers via HTTP",high
\`\`\`

Confidence levels:
- high: Names/patterns strongly suggest connection
- medium: Context supports it but names don't match exactly
- Skip low confidence - only report likely connections

DO NOT report:
- Connections within the same process group (those are visible via static analysis)
- Utility modules (logging, config, etc.)
- Shared type definitions (no runtime interaction)

## Architecture Constraints
- In client-server architectures, the CLIENT (frontend/app/sdk) initiates requests.
  Backend modules do NOT push to specific frontend components.
- Dev-time modules (CLI scripts, seed scripts, migrations) have NO runtime callers.
  Do NOT connect production modules to dev-time utilities.
- A realistic cross-process call surface has 3-8 callers per target, not dozens.
  If you find yourself connecting most modules in one group to a single target, stop.`;
}

/**
 * Build user prompt for cross-process inference between two process groups.
 * Includes member names for entity pattern matching.
 */
function buildCrossProcessUserPrompt(
  groupA: Module[],
  groupB: Module[],
  labelA: string,
  labelB: string,
  existingEdges: ModuleCallEdge[],
  allModules: Module[],
  membersMap: Map<number, ModuleWithMembers>,
  db: IndexDatabase
): string {
  const parts: string[] = [];

  const MAX_MEMBERS = 8;
  const KIND_PRIORITY: Record<string, number> = { function: 0, class: 1, variable: 2 };

  const formatMembers = (moduleId: number): string => {
    const modWithMembers = membersMap.get(moduleId);
    if (!modWithMembers || modWithMembers.members.length === 0) return '';
    const sorted = [...modWithMembers.members].sort(
      (a, b) => (KIND_PRIORITY[a.kind] ?? 3) - (KIND_PRIORITY[b.kind] ?? 3)
    );
    const shown = sorted.slice(0, MAX_MEMBERS);
    const memberList = shown.map((m) => `${m.name} (${m.kind})`).join(', ');
    const extra = sorted.length > MAX_MEMBERS ? ` (+${sorted.length - MAX_MEMBERS} more)` : '';
    return `\n  Members: ${memberList}${extra}`;
  };

  const groupAIds = new Set(groupA.map((m) => m.id));
  const groupBIds = new Set(groupB.map((m) => m.id));

  const BOUNDARY_PATTERNS =
    /\b(router|controller|handler|hook|client|endpoint|api|gateway|service|provider|adapter|facade|proxy|middleware)\b/i;

  const detectBoundaryModules = (group: Module[]): Module[] => {
    return group.filter((m) => {
      // Check module name/path
      if (BOUNDARY_PATTERNS.test(m.fullPath) || BOUNDARY_PATTERNS.test(m.name)) return true;
      // Check member names
      const modWithMembers = membersMap.get(m.id);
      if (modWithMembers) {
        return modWithMembers.members.some((member) => BOUNDARY_PATTERNS.test(member.name));
      }
      return false;
    });
  };

  const formatBoundaryHints = (boundaryModules: Module[], label: string): string[] => {
    if (boundaryModules.length === 0) return [];
    const hints: string[] = [];
    hints.push(`\nLikely boundary modules in "${label}":`);
    for (const m of boundaryModules.slice(0, 10)) {
      hints.push(`  * ${m.fullPath}`);
    }
    return hints;
  };

  parts.push(`## Process Group: "${labelA}" (${groupA.length} modules)`);
  for (const m of groupA) {
    parts.push(`- ${m.fullPath}: "${m.name}"${m.description ? ` - ${m.description}` : ''}${formatMembers(m.id)}`);
  }
  const boundaryA = detectBoundaryModules(groupA);
  parts.push(...formatBoundaryHints(boundaryA, labelA));

  parts.push('');
  parts.push(`## Process Group: "${labelB}" (${groupB.length} modules)`);
  for (const m of groupB) {
    parts.push(`- ${m.fullPath}: "${m.name}"${m.description ? ` - ${m.description}` : ''}${formatMembers(m.id)}`);
  }
  const boundaryB = detectBoundaryModules(groupB);
  parts.push(...formatBoundaryHints(boundaryB, labelB));

  parts.push('');
  parts.push('## Existing AST-Detected Cross-Process Connections (for reference)');
  const crossProcessEdges = existingEdges.filter((e) => {
    const fromInA = groupAIds.has(e.fromModuleId);
    const fromInB = groupBIds.has(e.fromModuleId);
    const toInA = groupAIds.has(e.toModuleId);
    const toInB = groupBIds.has(e.toModuleId);
    return (fromInA && toInB) || (fromInB && toInA);
  });

  if (crossProcessEdges.length === 0) {
    parts.push('(None detected - this is why we need inference!)');
  } else {
    for (const e of crossProcessEdges) {
      const from = allModules.find((m) => m.id === e.fromModuleId);
      const to = allModules.find((m) => m.id === e.toModuleId);
      if (from && to) {
        parts.push(`- ${from.fullPath} → ${to.fullPath}`);
      }
    }
  }

  // Contract context (if available)
  if (db.contracts.getCount() > 0) {
    const allGroupIds = new Set([...groupAIds, ...groupBIds]);
    const contractMatched = db.interactions.getBySource('contract-matched');
    const relevantMatched = contractMatched.filter(
      (i) => allGroupIds.has(i.fromModuleId) && allGroupIds.has(i.toModuleId)
    );

    if (relevantMatched.length > 0) {
      parts.push('');
      parts.push('## Contract-Matched Connections (already resolved)');
      // Group by protocol
      const byProtocol = new Map<string, string[]>();
      for (const i of relevantMatched) {
        // Extract protocol from semantic (format: "protocol: key1, key2; ...")
        const match = i.semantic?.match(/^(\w+):/);
        const protocol = match ? match[1] : 'unknown';
        const existing = byProtocol.get(protocol) ?? [];
        existing.push(`${i.fromModulePath} → ${i.toModulePath}`);
        byProtocol.set(protocol, existing);
      }
      for (const [protocol, connections] of byProtocol) {
        parts.push(`- ${protocol}: ${connections.length} contracts`);
      }
    }

    const unmatchedContracts = db.contracts.getUnmatchedContracts();
    const relevantUnmatched = unmatchedContracts.filter((c) =>
      c.participants.some((p) => p.moduleId !== null && allGroupIds.has(p.moduleId))
    );
    if (relevantUnmatched.length > 0) {
      parts.push('');
      parts.push('## Unmatched Contracts (may need inference)');
      for (const c of relevantUnmatched.slice(0, 10)) {
        const roles = c.participants.map((p) => p.role).join(', ');
        parts.push(`- ${c.protocol}:${c.normalizedKey} (${roles})`);
      }
    }

    parts.push('');
    parts.push('Focus inference on connections NOT already covered by contracts.');
  } else {
    parts.push('');
    parts.push('Identify runtime connections between these two process groups.');
  }

  return parts.join('\n');
}

/**
 * Parse the LLM response CSV into inferred interactions.
 */
function parseLogicalInteractionCSV(
  response: string,
  modules: Module[],
  existingPairs: Set<string>,
  db: IndexDatabase
): InferredInteraction[] {
  const results: InferredInteraction[] = [];
  const moduleByPath = new Map(modules.map((m) => [m.fullPath, m]));

  const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/);
  const csv = csvMatch ? csvMatch[1] : response;

  for (const line of csv.split('\n')) {
    if (!line.trim() || line.startsWith('from_module')) continue;

    const fields = parseRow(line);
    if (!fields || fields.length < 4) continue;

    const [fromPath, toPath, reason, confidenceStr] = fields;

    const fromModule = moduleByPath.get(fromPath.trim());
    const toModule = moduleByPath.get(toPath.trim());

    if (!fromModule || !toModule) continue;

    const normalizedConfidence = confidenceStr.trim().toLowerCase();
    if (normalizedConfidence === 'low') continue;

    // Apply structural gating
    const gate = gateInferredInteraction(fromModule, toModule, existingPairs, db);
    if (!gate.pass) continue;

    const confidence: 'high' | 'medium' = normalizedConfidence === 'high' ? 'high' : 'medium';

    results.push({
      fromModuleId: fromModule.id,
      toModuleId: toModule.id,
      reason: reason?.replace(/"/g, '').trim() ?? 'LLM inferred connection',
      confidence,
    });

    // Mark as processed to avoid duplicates within this batch
    existingPairs.add(`${fromModule.id}->${toModule.id}`);
  }

  return results;
}
