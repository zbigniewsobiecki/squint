/**
 * Assignment Phase: Assign symbols to modules using LLM.
 */

import type { Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase, Module } from '../../../db/database.js';
import type { LlmLogOptions } from '../../llm/_shared/llm-utils.js';
import { completeWithLogging, getErrorMessage, logLlmRequest, logLlmResponse } from '../../llm/_shared/llm-utils.js';
import { isValidModulePath, parseAssignmentCsv } from '../../llm/_shared/module-csv.js';
import {
  buildAssignmentSystemPrompt,
  buildAssignmentUserPrompt,
  toSymbolForAssignment,
} from '../../llm/_shared/module-prompts.js';
import { computeModuleDirectoryHints, resolveModulePath } from '../_shared/module-path-resolver.js';

export interface AssignmentPhaseContext {
  db: IndexDatabase;
  command: Command;
  model: string;
  batchSize: number;
  maxIterations: number;
  dryRun: boolean;
  isJson: boolean;
  verbose: boolean;
  llmLogOptions: LlmLogOptions;
}

export interface AssignmentResult {
  assigned: number;
  fuzzy: number;
  invalidPath: number;
  notFound: number;
}

/**
 * Execute the symbol assignment phase.
 */
export async function runAssignmentPhase(ctx: AssignmentPhaseContext): Promise<void> {
  const { db, command, model, batchSize, maxIterations, dryRun, isJson, verbose, llmLogOptions } = ctx;

  if (!isJson) {
    command.log('');
    command.log(chalk.bold('Phase 2: Symbol Assignment'));
  }

  // Get all modules
  const modules = db.modules.getAll();
  if (modules.length === 0) {
    if (isJson) {
      command.log(JSON.stringify({ error: 'No modules found. Run tree phase first.' }));
    } else {
      command.log(chalk.yellow('No modules found. Run tree phase first.'));
    }
    return;
  }

  // Build module path lookup
  const moduleByPath = new Map(modules.map((m) => [m.fullPath, m]));

  // Get unassigned symbols
  const unassignedSymbols = db.modules.getUnassigned();
  if (unassignedSymbols.length === 0) {
    if (isJson) {
      command.log(JSON.stringify({ message: 'All symbols already assigned' }));
    } else {
      command.log(chalk.green('  All symbols already assigned.'));
    }
    return;
  }

  if (!isJson) {
    command.log(chalk.gray(`  Unassigned symbols: ${unassignedSymbols.length}`));
    command.log(chalk.gray(`  Available modules: ${modules.length}`));
  }

  const systemPrompt = buildAssignmentSystemPrompt();

  // Auto-adjust max iterations to ensure every symbol gets at least one LLM attempt
  const neededIterations = Math.ceil(unassignedSymbols.length / batchSize);
  const effectiveMaxIterations = Math.max(maxIterations, neededIterations);
  if (effectiveMaxIterations > maxIterations && !isJson) {
    command.log(
      chalk.gray(
        `  Auto-adjusted max iterations: ${maxIterations} → ${effectiveMaxIterations} (to cover all ${unassignedSymbols.length} symbols)`
      )
    );
  }

  let totalAssigned = 0;
  let iteration = 0;
  const allAssignments: Array<{ symbolId: number; modulePath: string }> = [];
  let directoryHints: Map<number, string[]> | undefined;

  // Process in batches
  for (let i = 0; i < unassignedSymbols.length && iteration < effectiveMaxIterations; i += batchSize) {
    iteration++;
    const batch = unassignedSymbols.slice(i, i + batchSize);
    const symbolsForAssignment = batch.map(toSymbolForAssignment);

    // Recompute directory hints every 5 batches (first batch has no hints — no symbols assigned yet)
    if (!dryRun && iteration > 1 && (iteration - 1) % 5 === 0) {
      directoryHints = computeModuleDirectoryHints(db.modules.getAllWithMembers());
    }

    if (verbose && !isJson) {
      command.log(chalk.gray(`  Batch ${iteration}: ${batch.length} symbols...`));
    }

    const userPrompt = buildAssignmentUserPrompt(modules, symbolsForAssignment, directoryHints);

    try {
      logLlmRequest(command, `runAssignmentPhase-batch${iteration}`, systemPrompt, userPrompt, llmLogOptions);

      const response = await completeWithLogging({
        model,
        systemPrompt,
        userPrompt,
        temperature: 0,
        command,
        isJson,
        iteration: { current: iteration, max: effectiveMaxIterations },
      });

      logLlmResponse(command, `runAssignmentPhase-batch${iteration}`, response, llmLogOptions);

      const { assignments, errors } = parseAssignmentCsv(response);

      if (errors.length > 0 && verbose && !isJson) {
        command.log(chalk.yellow(`    Parse warnings: ${errors.length}`));
      }

      // Validate and apply assignments
      const result = applyParsedAssignments(assignments, moduleByPath, db, dryRun, allAssignments);
      totalAssigned += result.assigned;

      if (!isJson && (result.invalidPath > 0 || result.notFound > 0 || result.fuzzy > 0)) {
        const parts: string[] = [];
        if (result.fuzzy > 0) parts.push(`${result.fuzzy} fuzzy-resolved`);
        if (result.invalidPath > 0) parts.push(`${result.invalidPath} invalid-path`);
        if (result.notFound > 0) parts.push(`${result.notFound} not-found`);
        command.log(chalk.yellow(`    Batch ${iteration}: ${parts.join(', ')}`));
      }

      // Detect omitted symbols and retry once
      const returnedIds = new Set(assignments.map((a) => a.symbolId));
      const omittedSymbols = batch.filter((s) => !returnedIds.has(s.id));

      if (omittedSymbols.length > 0 && omittedSymbols.length <= batchSize / 2) {
        const retrySymbols = omittedSymbols.map(toSymbolForAssignment);
        const retryUserPrompt = buildAssignmentUserPrompt(modules, retrySymbols, directoryHints);

        try {
          const retryResponse = await completeWithLogging({
            model,
            systemPrompt,
            userPrompt: retryUserPrompt,
            temperature: 0,
            command,
            isJson,
            iteration: { current: iteration, max: effectiveMaxIterations },
          });

          const { assignments: retryAssignments } = parseAssignmentCsv(retryResponse);
          const retryResult = applyParsedAssignments(retryAssignments, moduleByPath, db, dryRun, allAssignments);
          totalAssigned += retryResult.assigned;

          if (verbose && !isJson) {
            command.log(chalk.gray(`    Retry: ${omittedSymbols.length} omitted → ${retryResult.assigned} assigned`));
          }
        } catch {
          // Retry failed — will be caught by coverage gate or fallback
        }
      }

      if (!isJson && !verbose) {
        process.stdout.write(chalk.gray('.'));
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (!isJson) {
        command.log(chalk.red(`  Batch ${iteration} failed: ${message}`));
      }
    }
  }

  if (!isJson && !verbose) {
    command.log(''); // New line after dots
  }

  if (dryRun) {
    if (isJson) {
      command.log(
        JSON.stringify(
          {
            phase: 'assign',
            dryRun: true,
            proposedAssignments: allAssignments,
            totalAssigned,
          },
          null,
          2
        )
      );
    } else {
      command.log(chalk.gray(`  Would assign ${totalAssigned} symbols`));
    }
    return;
  }

  if (!isJson) {
    command.log(chalk.green(`  Assigned ${totalAssigned} symbols`));
  }
}

/**
 * Validate and apply parsed assignment rows.
 * Returns counts of assigned, fuzzy-resolved, invalid-path, and not-found assignments.
 */
export function applyParsedAssignments(
  assignments: Array<{ symbolId: number; modulePath: string }>,
  moduleByPath: Map<string, Module>,
  db: IndexDatabase,
  dryRun: boolean,
  allAssignments: Array<{ symbolId: number; modulePath: string }>
): AssignmentResult {
  let assigned = 0;
  let fuzzy = 0;
  let invalidPath = 0;
  let notFound = 0;

  for (const assignment of assignments) {
    if (!isValidModulePath(assignment.modulePath)) {
      invalidPath++;
      continue;
    }

    let targetModule = moduleByPath.get(assignment.modulePath);
    if (!targetModule) {
      targetModule = resolveModulePath(assignment.modulePath, moduleByPath);
      if (targetModule) {
        fuzzy++;
      } else {
        notFound++;
        continue;
      }
    }

    if (!dryRun) {
      db.modules.assignSymbol(assignment.symbolId, targetModule.id);
    }
    allAssignments.push({ symbolId: assignment.symbolId, modulePath: targetModule.fullPath });
    assigned++;
  }

  return { assigned, fuzzy, invalidPath, notFound };
}

export interface CoverageGateContext {
  db: IndexDatabase;
  command: Command;
  model: string;
  batchSize: number;
  maxUnassignedPct: number;
  maxGateRetries: number;
  isJson: boolean;
  llmLogOptions: LlmLogOptions;
}

/**
 * Coverage gate: check unassigned symbol % and run catch-up passes if needed.
 */
export async function runAssignmentCoverageGate(ctx: CoverageGateContext): Promise<void> {
  const { db, command, model, batchSize, maxUnassignedPct, maxGateRetries, isJson } = ctx;

  const stats = db.modules.getStats();
  const total = stats.assigned + stats.unassigned;
  if (total === 0) return;

  let unassignedPct = (stats.unassigned / total) * 100;

  if (unassignedPct <= maxUnassignedPct) return;

  if (!isJson) {
    command.log('');
    command.log(
      chalk.yellow(
        `  ${unassignedPct.toFixed(1)}% symbols still unassigned (threshold: ${maxUnassignedPct}%), running catch-up passes`
      )
    );
  }

  const modules = db.modules.getAll();
  const moduleByPath = new Map(modules.map((m) => [m.fullPath, m]));

  const relaxedSystemPrompt = `You are a software architect assigning symbols to modules.
Each symbol must be assigned to exactly ONE module path.

## Your Task
These symbols were difficult to assign in prior passes. Use your best judgment.
If none of the existing modules fit perfectly, assign to the closest parent module.

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
type,symbol_id,module_path
assignment,42,project.frontend.screens.login
\`\`\`

## Guidelines
- Every symbol must be assigned to exactly one module
- Module paths must match existing modules in the tree
- Prefer more specific modules, but if unsure use the closest parent
- Consider the file path as a strong hint
- CRITICAL: Output exactly one assignment row for every symbol listed. Do not skip any.`;

  for (let retry = 0; retry < maxGateRetries; retry++) {
    const unassigned = db.modules.getUnassigned();
    if (unassigned.length === 0) break;

    const currentPct = (unassigned.length / total) * 100;
    if (currentPct <= maxUnassignedPct) break;

    if (!isJson) {
      command.log(chalk.gray(`  Catch-up pass ${retry + 1}/${maxGateRetries}: ${unassigned.length} symbols remaining`));
    }

    let passAssigned = 0;
    let passFuzzy = 0;
    let passInvalidPath = 0;
    let passNotFound = 0;
    let passErrors = 0;

    for (let i = 0; i < unassigned.length; i += batchSize) {
      const batch = unassigned.slice(i, i + batchSize);
      const symbolsForAssignment = batch.map(toSymbolForAssignment);
      const userPrompt = buildAssignmentUserPrompt(modules, symbolsForAssignment);

      try {
        const response = await completeWithLogging({
          model,
          systemPrompt: relaxedSystemPrompt,
          userPrompt,
          temperature: 0,
          command,
          isJson,
          iteration: { current: retry + 1, max: maxGateRetries },
        });

        const { assignments } = parseAssignmentCsv(response);
        for (const assignment of assignments) {
          if (!isValidModulePath(assignment.modulePath)) {
            passInvalidPath++;
            continue;
          }

          let targetModule = moduleByPath.get(assignment.modulePath);
          if (!targetModule) {
            targetModule = resolveModulePath(assignment.modulePath, moduleByPath);
            if (targetModule) {
              passFuzzy++;
            } else {
              passNotFound++;
              continue;
            }
          }

          db.modules.assignSymbol(assignment.symbolId, targetModule.id);
          passAssigned++;
        }
      } catch (error) {
        passErrors++;
        const message = getErrorMessage(error);
        if (!isJson) {
          command.log(chalk.red(`    Catch-up batch error: ${message}`));
        }
      }
    }

    if (!isJson) {
      const parts: string[] = [`${passAssigned} assigned`];
      if (passFuzzy > 0) parts.push(`${passFuzzy} fuzzy-resolved`);
      if (passInvalidPath > 0) parts.push(`${passInvalidPath} invalid-path`);
      if (passNotFound > 0) parts.push(`${passNotFound} not-found`);
      if (passErrors > 0) parts.push(`${passErrors} errors`);
      command.log(chalk.gray(`  Pass ${retry + 1} summary: ${parts.join(', ')}`));
    }

    // Early exit: no progress this pass
    if (passAssigned === 0) {
      if (!isJson) {
        command.log(chalk.yellow('  No progress this pass — stopping early'));
      }
      break;
    }

    // Re-check
    const updatedStats = db.modules.getStats();
    unassignedPct = (updatedStats.unassigned / total) * 100;
    if (unassignedPct <= maxUnassignedPct) {
      if (!isJson) {
        command.log(chalk.green(`  Coverage gate passed: ${unassignedPct.toFixed(1)}% unassigned`));
      }
      return;
    }
  }

  if (!isJson) {
    const finalStats = db.modules.getStats();
    const finalPct = (finalStats.unassigned / total) * 100;
    command.log(
      chalk.yellow(`  Coverage gate: ${finalPct.toFixed(1)}% still unassigned after ${maxGateRetries} retries`)
    );
  }
}
