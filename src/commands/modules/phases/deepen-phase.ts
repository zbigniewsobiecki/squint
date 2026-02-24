/**
 * Deepen Phase: Split large modules into sub-modules.
 */

import type { Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../../db/database.js';
import type { LlmLogOptions } from '../../llm/_shared/llm-utils.js';
import { completeWithLogging, getErrorMessage, logLlmRequest, logLlmResponse } from '../../llm/_shared/llm-utils.js';
import { parseAssignmentCsv, parseDeepenCsv } from '../../llm/_shared/module-csv.js';
import {
  type AncestorSymbolGroup,
  type ModuleForDeepening,
  type NewSubModuleInfo,
  buildBranchPushdownSystemPrompt,
  buildDeepenSystemPrompt,
  buildDeepenUserPrompt,
  buildRebalanceSystemPrompt,
  buildRebalanceUserPrompt,
} from '../../llm/_shared/module-prompts.js';
import { buildCohortVotes, findAssignmentTarget, isTestFile } from '../_shared/cohort-voter.js';
import { resolveModulePath } from '../_shared/module-path-resolver.js';

export interface DeepenPhaseContext {
  db: IndexDatabase;
  command: Command;
  model: string;
  threshold: number;
  maxDepth: number;
  dryRun: boolean;
  isJson: boolean;
  verbose: boolean;
  llmLogOptions: LlmLogOptions;
  maxModules: number;
}

/**
 * Phase 3: Deepen large modules by splitting them into sub-modules.
 * Step 1: Rebalance branch modules (has children + direct members) — no new modules created.
 * Step 2: Split leaf modules (largest first) — consumes module budget.
 */
export async function runDeepenPhase(ctx: DeepenPhaseContext): Promise<void> {
  const { db, command, model, threshold, maxDepth, dryRun, isJson, verbose, llmLogOptions, maxModules } = ctx;

  if (!isJson) {
    command.log('');
    command.log(chalk.bold('Phase 3: Module Deepening'));
  }

  let totalNewModules = 0;
  let totalReassignments = 0;
  let totalRebalanced = 0;

  // Step 1: Rebalance branch modules (no new modules, no budget spent)
  if (!dryRun) {
    const branchModules = db.modules.getBranchModulesWithDirectMembers(threshold);
    if (branchModules.length > 0 && !isJson) {
      command.log(chalk.gray(`  Rebalancing ${branchModules.length} branch modules with direct members`));
    }
    for (const mod of branchModules) {
      if (verbose && !isJson) {
        command.log(chalk.gray(`    Rebalancing ${mod.fullPath} (${mod.members.length} direct members)...`));
      }

      // Get existing children paths
      const children = db.modules.getChildren(mod.id);
      const childPaths = children.map((c) => c.fullPath);

      if (childPaths.length === 0) continue;

      try {
        const rebalanced = await rebalanceAncestorSymbols({
          db,
          command,
          model,
          deepenedModulePath: mod.fullPath,
          newSubModulePaths: childPaths,
          isJson,
          verbose,
          llmLogOptions,
          includeSelf: true, // Push branch's own members to children
        });
        totalRebalanced += rebalanced;
      } catch (error) {
        const message = getErrorMessage(error);
        if (!isJson) {
          command.log(chalk.red(`    Failed to rebalance ${mod.fullPath}: ${message}`));
        }
      }
    }
  }

  // Step 2: Split leaf modules (budget consumed)
  const maxIterations = 5; // Safety limit to prevent infinite loops
  let iteration = 0;
  let hitModuleLimit = false;

  while (iteration < maxIterations && !hitModuleLimit) {
    iteration++;

    // Query leaf modules exceeding threshold (largest first)
    const allLargeLeaves = dryRun
      ? db.modules.getModulesExceedingThreshold(threshold)
      : db.modules.getLeafModulesExceedingThreshold(threshold);

    // Filter out modules already at max depth
    const largeLeaves = allLargeLeaves.filter((m) => m.depth < maxDepth);
    if (largeLeaves.length < allLargeLeaves.length && verbose && !isJson) {
      command.log(
        chalk.gray(`  Skipped ${allLargeLeaves.length - largeLeaves.length} modules at max depth ${maxDepth}`)
      );
    }

    if (largeLeaves.length === 0) {
      if (verbose && !isJson) {
        command.log(chalk.gray(`  Iteration ${iteration}: All leaf modules under threshold or at max depth`));
      }
      break;
    }

    if (!isJson) {
      command.log(chalk.gray(`  Iteration ${iteration}: ${largeLeaves.length} leaf modules exceed threshold`));
    }

    // Process each large leaf module
    for (const mod of largeLeaves) {
      if (hitModuleLimit) break;

      if (verbose && !isJson) {
        command.log(chalk.gray(`    Splitting ${mod.fullPath} (${mod.members.length} members)...`));
      }

      // Build prompt data
      const moduleForDeepening: ModuleForDeepening = {
        id: mod.id,
        fullPath: mod.fullPath,
        name: mod.name,
        members: mod.members.map((m) => ({
          definitionId: m.definitionId,
          name: m.name,
          kind: m.kind,
          filePath: m.filePath,
          isExported: m.isExported,
        })),
      };

      try {
        const deepenSystemPrompt = buildDeepenSystemPrompt();
        const deepenUserPrompt = buildDeepenUserPrompt(moduleForDeepening);
        logLlmRequest(command, `runDeepenPhase-${mod.fullPath}`, deepenSystemPrompt, deepenUserPrompt, llmLogOptions);

        const response = await completeWithLogging({
          model,
          systemPrompt: deepenSystemPrompt,
          userPrompt: deepenUserPrompt,
          temperature: 0,
          command,
          isJson,
        });

        logLlmResponse(command, `runDeepenPhase-${mod.fullPath}`, response, llmLogOptions);

        // Parse response
        const { newModules, reassignments, errors } = parseDeepenCsv(response);

        if (errors.length > 0 && verbose && !isJson) {
          command.log(chalk.yellow(`      Parse warnings: ${errors.length}`));
          for (const err of errors.slice(0, 3)) {
            command.log(chalk.gray(`        ${err}`));
          }
        }

        if (newModules.length === 0) {
          if (verbose && !isJson) {
            command.log(chalk.yellow(`      No sub-modules proposed for ${mod.fullPath}`));
          }
          continue;
        }

        if (dryRun) {
          if (verbose && !isJson) {
            command.log(chalk.gray(`      Would create ${newModules.length} sub-modules`));
            for (const sub of newModules) {
              command.log(chalk.cyan(`        ${mod.fullPath}.${sub.slug}: ${sub.name}`));
            }
          }
          totalNewModules += newModules.length;
          totalReassignments += reassignments.length;
          continue;
        }

        // Create sub-modules
        const createdSubModulePaths: string[] = [];
        for (const subMod of newModules) {
          if (maxModules > 0 && db.modules.getCount() >= maxModules) {
            if (!isJson) {
              command.log(chalk.yellow(`  Reached max-modules limit (${maxModules}), stopping module creation`));
            }
            hitModuleLimit = true;
            break;
          }

          const parent = db.modules.getByPath(subMod.parentPath);
          if (!parent) {
            if (verbose && !isJson) {
              command.log(chalk.yellow(`      Parent not found: ${subMod.parentPath}`));
            }
            continue;
          }

          try {
            // isTest is inherited from parent in ModuleRepository.insert()
            db.modules.insert(parent.id, subMod.slug, subMod.name, subMod.description);
            totalNewModules++;
            createdSubModulePaths.push(`${subMod.parentPath}.${subMod.slug}`);
          } catch (error) {
            if (verbose && !isJson) {
              const message = getErrorMessage(error);
              command.log(chalk.yellow(`      Failed to create ${subMod.slug}: ${message}`));
            }
          }
        }

        // Reassign symbols to new sub-modules
        for (const reassignment of reassignments) {
          const targetModule = db.modules.getByPath(reassignment.targetModulePath);
          if (!targetModule) {
            if (verbose && !isJson) {
              command.log(chalk.yellow(`      Target module not found: ${reassignment.targetModulePath}`));
            }
            continue;
          }

          db.modules.assignSymbol(reassignment.definitionId, targetModule.id);
          totalReassignments++;
        }

        // Rebalance ancestor symbols into new sub-modules
        if (createdSubModulePaths.length > 0 && !hitModuleLimit) {
          const rebalanced = await rebalanceAncestorSymbols({
            db,
            command,
            model,
            deepenedModulePath: mod.fullPath,
            newSubModulePaths: createdSubModulePaths,
            isJson,
            verbose,
            llmLogOptions,
          });
          totalRebalanced += rebalanced;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (!isJson) {
          command.log(chalk.red(`    Failed to process ${mod.fullPath}: ${message}`));
        }
      }
    }
  }

  if (iteration >= maxIterations && !isJson) {
    command.log(chalk.yellow(`  Warning: Reached max iterations (${maxIterations})`));
  }

  // Deterministic fallback: push remaining branch members to children by file/directory cohort
  if (!dryRun) {
    const fallbackPushed = pushdownBranchMembersFallback(db, command, isJson, verbose);
    if (fallbackPushed > 0) {
      totalRebalanced += fallbackPushed;
    }
  }

  if (dryRun) {
    if (isJson) {
      command.log(
        JSON.stringify({
          phase: 'deepen',
          dryRun: true,
          proposedNewModules: totalNewModules,
          proposedReassignments: totalReassignments,
        })
      );
    } else {
      command.log(chalk.gray(`  Would create ${totalNewModules} sub-modules`));
      command.log(chalk.gray(`  Would reassign ${totalReassignments} symbols`));
    }
  } else if (!isJson) {
    command.log(chalk.green(`  Created ${totalNewModules} sub-modules`));
    command.log(chalk.green(`  Reassigned ${totalReassignments} symbols`));
    if (totalRebalanced > 0) {
      command.log(chalk.green(`  Rebalanced ${totalRebalanced} symbols from ancestors`));
    }
  }
}

export interface RebalanceContext {
  db: IndexDatabase;
  command: Command;
  model: string;
  deepenedModulePath: string;
  newSubModulePaths: string[];
  isJson: boolean;
  verbose: boolean;
  llmLogOptions: LlmLogOptions;
  includeSelf?: boolean;
}

/**
 * Rebalance symbols from ancestor modules into newly created sub-modules.
 * Walks up from the deepened module collecting symbols from ancestors,
 * then asks the LLM if any should be moved into the new sub-structure.
 * Returns the number of symbols rebalanced.
 */
export async function rebalanceAncestorSymbols(ctx: RebalanceContext): Promise<number> {
  const {
    db,
    command,
    model,
    deepenedModulePath,
    newSubModulePaths,
    isJson,
    verbose,
    llmLogOptions,
    includeSelf = false,
  } = ctx;

  // Walk up from the deepened module to collect ancestor paths (excluding root "project")
  const segments = deepenedModulePath.split('.');
  const ancestorPaths: string[] = [];

  // Include the module's own path for branch pushdown
  if (includeSelf) {
    ancestorPaths.push(deepenedModulePath);
  }

  for (let i = segments.length - 1; i >= 1; i--) {
    const ancestorPath = segments.slice(0, i).join('.');
    if (ancestorPath === 'project') break; // don't rebalance from root
    ancestorPaths.push(ancestorPath);
  }

  if (ancestorPaths.length === 0) return 0;

  // Collect symbols from each ancestor
  const ancestorSymbols: AncestorSymbolGroup[] = [];
  for (const p of ancestorPaths) {
    const mod = db.modules.getByPath(p);
    if (!mod) continue;
    const symbols = db.modules.getSymbols(mod.id);
    if (symbols.length === 0) continue;
    ancestorSymbols.push({ moduleId: mod.id, modulePath: p, symbols });
  }

  if (ancestorSymbols.length === 0) return 0;

  const totalSymbols = ancestorSymbols.reduce((sum, g) => sum + g.symbols.length, 0);
  if (verbose && !isJson) {
    command.log(
      chalk.gray(`      Rebalancing: ${totalSymbols} ancestor symbols across ${ancestorSymbols.length} modules`)
    );
  }

  // Build info about new sub-modules
  const newSubModules: NewSubModuleInfo[] = [];
  for (const subPath of newSubModulePaths) {
    const mod = db.modules.getByPath(subPath);
    if (!mod) continue;
    newSubModules.push({ path: mod.fullPath, name: mod.name, description: mod.description });
  }

  if (newSubModules.length === 0) return 0;

  // Call LLM for rebalancing — use aggressive prompt for branch pushdown
  const systemPrompt = includeSelf ? buildBranchPushdownSystemPrompt() : buildRebalanceSystemPrompt();
  const userPrompt = buildRebalanceUserPrompt(ancestorSymbols, newSubModules);

  logLlmRequest(command, `rebalance-${deepenedModulePath}`, systemPrompt, userPrompt, llmLogOptions);

  try {
    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      command,
      isJson,
    });

    logLlmResponse(command, `rebalance-${deepenedModulePath}`, response, llmLogOptions);

    const { assignments, errors } = parseAssignmentCsv(response);

    if (errors.length > 0 && verbose && !isJson) {
      command.log(chalk.yellow(`      Rebalance parse warnings: ${errors.length}`));
    }

    // Apply reassignments — only allow moves into the new sub-structure
    const validSubPaths = new Set(newSubModulePaths);
    const subModuleByPath = new Map<string, { id: number; fullPath: string }>();
    for (const p of newSubModulePaths) {
      const mod = db.modules.getByPath(p);
      if (mod) subModuleByPath.set(p, { id: mod.id, fullPath: mod.fullPath });
    }
    let rebalanced = 0;

    for (const assignment of assignments) {
      let targetModule: { id: number; fullPath: string } | undefined;

      if (validSubPaths.has(assignment.modulePath)) {
        targetModule = subModuleByPath.get(assignment.modulePath);
      } else {
        // Fuzzy resolve constrained to the deepened module prefix
        targetModule = resolveModulePath(assignment.modulePath, subModuleByPath, deepenedModulePath);
      }

      if (!targetModule) {
        if (verbose && !isJson) {
          command.log(
            chalk.yellow(`      Rebalance: skipping move to ${assignment.modulePath} (not a new sub-module)`)
          );
        }
        continue;
      }

      db.modules.assignSymbol(assignment.symbolId, targetModule.id);
      rebalanced++;
    }

    if (rebalanced > 0 && verbose && !isJson) {
      command.log(chalk.gray(`      Rebalanced ${rebalanced} symbols from ancestors`));
    }

    return rebalanced;
  } catch (error) {
    const message = getErrorMessage(error);
    if (verbose && !isJson) {
      command.log(chalk.yellow(`      Rebalance failed: ${message}`));
    }
    return 0;
  }
}

/**
 * Deterministic fallback: push direct members of branch modules to their children
 * using file/directory cohort voting. Loops until no more progress.
 */
export function pushdownBranchMembersFallback(
  db: IndexDatabase,
  command: Command,
  isJson: boolean,
  verbose: boolean
): number {
  let totalPushed = 0;
  let progress = true;

  while (progress) {
    progress = false;
    const branchModules = db.modules.getBranchModulesWithDirectMembers(0);
    if (branchModules.length === 0) break;

    for (const branch of branchModules) {
      const children = db.modules.getChildren(branch.id);
      if (children.length === 0) continue;

      // Build file/directory vote maps from children's members
      const childrenWithMembers = children.map((child) => ({
        id: child.id,
        members: db.modules.getMemberInfo(child.id),
      }));

      const { fileMajority, dirMajority } = buildCohortVotes(childrenWithMembers);
      const childById = new Map(children.map((c) => [c.id, { id: c.id, isTest: c.isTest }]));

      for (const member of branch.members) {
        const symIsTest = isTestFile(member.filePath);
        const target = findAssignmentTarget(member.filePath, fileMajority, dirMajority, childById, symIsTest);

        // Tier 3: Single child — move unconditionally
        let targetChildId = target?.moduleId;
        if (targetChildId === undefined && children.length === 1) {
          const child = children[0];
          if (!symIsTest || child.isTest) {
            targetChildId = child.id;
          }
        }

        if (targetChildId !== undefined) {
          db.modules.assignSymbol(member.definitionId, targetChildId);
          totalPushed++;
          progress = true;
        }
      }
    }
  }

  if (totalPushed > 0 && verbose && !isJson) {
    command.log(chalk.gray(`  Branch pushdown fallback: ${totalPushed} symbols pushed to children`));
  }

  return totalPushed;
}
