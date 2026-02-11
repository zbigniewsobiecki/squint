import { Flags } from '@oclif/core';
import chalk from 'chalk';

import path from 'node:path';

import type { Module } from '../../db/database.js';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from './_shared/base-llm-command.js';
import {
  type LlmLogOptions,
  completeWithLogging,
  getErrorMessage,
  logLlmRequest,
  logLlmResponse,
} from './_shared/llm-utils.js';
import { isValidModulePath, parseAssignmentCsv, parseDeepenCsv, parseTreeCsv } from './_shared/module-csv.js';
import {
  type AncestorSymbolGroup,
  type DirectoryInfo,
  type DomainSummary,
  type ModuleForDeepening,
  type NewSubModuleInfo,
  type TreeGenerationContext,
  buildAssignmentSystemPrompt,
  buildAssignmentUserPrompt,
  buildBranchPushdownSystemPrompt,
  buildDeepenSystemPrompt,
  buildDeepenUserPrompt,
  buildRebalanceSystemPrompt,
  buildRebalanceUserPrompt,
  buildTreeSystemPrompt,
  buildTreeUserPrompt,
  isTestFile,
  toSymbolForAssignment,
} from './_shared/module-prompts.js';
import { checkModuleAssignments } from './_shared/verify/coverage-checker.js';

export default class Modules extends BaseLlmCommand {
  static override description = 'Create module tree structure and assign symbols using LLM';

  static override examples = [
    '<%= config.bin %> llm modules',
    '<%= config.bin %> llm modules --phase tree --dry-run',
    '<%= config.bin %> llm modules --phase assign --batch-size 30',
    '<%= config.bin %> llm modules --force',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    verify: Flags.boolean({
      description: 'Verify existing module assignments instead of creating new ones',
      default: false,
    }),
    fix: Flags.boolean({
      description: 'Auto-fix structural issues found during verification (e.g., move test symbols to test modules)',
      default: false,
    }),
    'max-gate-retries': Flags.integer({
      default: 3,
      description: 'Maximum retry attempts when assignment gate fails',
    }),
    phase: Flags.string({
      options: ['all', 'tree', 'assign'],
      default: 'all',
      description: 'Which phase to run: tree (structure), assign (symbols), or all',
    }),
    'batch-size': Flags.integer({
      default: 20,
      description: 'Symbols per LLM call during assignment phase',
    }),
    'max-iterations': Flags.integer({
      default: 100,
      description: 'Maximum LLM iterations for assignment phase',
    }),
    incremental: Flags.boolean({
      default: false,
      description: 'Only assign unassigned symbols (skip tree generation)',
    }),
    'deepen-threshold': Flags.integer({
      default: 10,
      description: 'Min members before splitting a module (0 to disable deepening)',
    }),
    'max-unassigned-pct': Flags.integer({
      default: 5,
      description: 'Maximum % of symbols allowed to remain unassigned',
    }),
    'max-depth': Flags.integer({
      default: 7,
      description: 'Maximum module tree depth (prevents over-nesting during deepening)',
    }),
    'max-modules': Flags.integer({
      default: 0,
      description: 'Maximum total modules allowed (0 = unlimited)',
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, verbose } = ctx;
    const phase = flags.phase as string;
    const incremental = flags.incremental as boolean;
    const llmLogOptions: LlmLogOptions = {
      showRequests: ctx.llmOptions.showLlmRequests,
      showResponses: ctx.llmOptions.showLlmResponses,
      isJson,
    };

    // Verify mode: run verification instead of assignment
    if (flags.verify) {
      this.runModuleVerify(ctx, flags);
      return;
    }

    // Check existing modules
    const existingModuleCount = db.modules.getCount();

    if (!incremental) {
      if (
        !this.checkExistingAndClear(ctx, {
          entityName: 'Modules',
          existingCount: existingModuleCount,
          force: flags.force as boolean,
          clearFn: () => db.modules.clear(),
          forceHint: 'Use --force to recreate or --incremental to assign unassigned symbols',
        })
      ) {
        return;
      }
    }

    const maxModules = flags['max-modules'] as number;

    // Phase 1: Tree Structure Generation
    if ((phase === 'all' || phase === 'tree') && !incremental) {
      await this.runTreePhase(db, flags, dryRun, isJson, verbose, llmLogOptions, maxModules);
    }

    // Phase 2: Symbol Assignment
    if (phase === 'all' || phase === 'assign') {
      await this.runAssignmentPhase(db, flags, dryRun, isJson, verbose, llmLogOptions);

      // Coverage gate: check unassigned % and run catch-up passes if needed
      if (!dryRun) {
        const maxUnassignedPct = flags['max-unassigned-pct'] as number;
        const maxGateRetries = flags['max-gate-retries'] as number;
        await this.runAssignmentCoverageGate(db, flags, maxUnassignedPct, maxGateRetries, isJson, verbose);
      }

      // Deterministic fallback for symbols LLM couldn't assign
      if (!dryRun) {
        const remaining = db.modules.getUnassigned();
        if (remaining.length > 0) {
          const fallbackCount = this.assignByFileCohortFallback(db, isJson, verbose);
          if (fallbackCount > 0 && !isJson) {
            this.log(chalk.green(`  Deterministic fallback: assigned ${fallbackCount} remaining symbols`));
          }
        }
      }

      // Prune empty leaf modules after assignment
      if (!dryRun) {
        const pruned = db.modules.pruneEmptyLeaves();
        if (pruned > 0 && !isJson) {
          this.log(chalk.green(`  Pruned ${pruned} empty leaf modules`));
        }
      }

      // Phase 3: Deepening (automatic after assignment, unless disabled)
      const deepenThreshold = flags['deepen-threshold'] as number;
      if (deepenThreshold > 0) {
        await this.runDeepenPhase(db, flags, deepenThreshold, dryRun, isJson, verbose, llmLogOptions, maxModules);

        // Prune any modules emptied by reassignment during deepening
        if (!dryRun) {
          const pruned = db.modules.pruneEmptyLeaves();
          if (pruned > 0 && !isJson) {
            this.log(chalk.green(`  Pruned ${pruned} empty leaf modules after deepening`));
          }
        }
      }
    }

    // Assign color indices for consistent cross-view coloring
    if (!dryRun) {
      db.modules.assignColorIndices();
    }

    // Final stats
    if (!dryRun) {
      const stats = db.modules.getStats();
      if (isJson) {
        this.log(JSON.stringify(stats));
      } else {
        this.log('');
        this.log(chalk.green('Module tree complete.'));
        this.log(chalk.gray(`  Modules: ${stats.moduleCount}`));
        this.log(chalk.gray(`  Assigned symbols: ${stats.assigned}`));
        this.log(chalk.gray(`  Unassigned symbols: ${stats.unassigned}`));
      }
    }
  }

  /**
   * Phase 1: Generate the module tree structure.
   */
  private async runTreePhase(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    flags: Record<string, unknown>,
    dryRun: boolean,
    isJson: boolean,
    verbose: boolean,
    llmLogOptions: LlmLogOptions,
    maxModules: number
  ): Promise<void> {
    if (!isJson) {
      this.log(chalk.bold('Phase 1: Tree Structure Generation'));
    }

    // Ensure root module exists
    if (!dryRun) {
      db.modules.ensureRoot();
    }

    // Gather context for the LLM
    const context = this.buildTreeContext(db, maxModules);

    if (context.totalSymbolCount === 0) {
      if (isJson) {
        this.log(JSON.stringify({ error: 'No symbols found in database' }));
      } else {
        this.log(chalk.yellow('No symbols found in database.'));
      }
      return;
    }

    if (!isJson && verbose) {
      this.log(chalk.gray(`  Total symbols: ${context.totalSymbolCount}`));
      this.log(chalk.gray(`  Domains found: ${context.domains.length}`));
    }

    // Build prompts
    const systemPrompt = buildTreeSystemPrompt();
    const userPrompt = buildTreeUserPrompt(context);

    if (verbose && !isJson) {
      this.log(chalk.gray('  Calling LLM for tree structure...'));
    }

    logLlmRequest(this, 'runTreePhase', systemPrompt, userPrompt, llmLogOptions);

    // Call LLM
    const response = await completeWithLogging({
      model: flags.model as string,
      systemPrompt,
      userPrompt,
      temperature: 0,
      command: this,
      isJson,
    });

    logLlmResponse(this, 'runTreePhase', response, llmLogOptions);

    // Parse response
    const { modules: parsedModules, errors } = parseTreeCsv(response);

    if (errors.length > 0 && !isJson) {
      this.log(chalk.yellow(`  Parse warnings: ${errors.length}`));
      if (verbose) {
        for (const err of errors.slice(0, 5)) {
          this.log(chalk.gray(`    ${err}`));
        }
      }
    }

    if (parsedModules.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ error: 'No modules parsed from LLM response', parseErrors: errors }));
      } else {
        this.log(chalk.red('No modules parsed from LLM response.'));
      }
      return;
    }

    if (dryRun) {
      if (isJson) {
        this.log(
          JSON.stringify(
            {
              phase: 'tree',
              dryRun: true,
              proposedModules: parsedModules,
              parseErrors: errors,
            },
            null,
            2
          )
        );
      } else {
        this.log(chalk.gray(`  Proposed modules: ${parsedModules.length}`));
        this.log('');
        for (const mod of parsedModules) {
          const fullPath = `${mod.parentPath}.${mod.slug}`;
          this.log(chalk.cyan(`  ${fullPath}: ${mod.name}`));
          if (mod.description) {
            this.log(chalk.gray(`    ${mod.description}`));
          }
        }
      }
      return;
    }

    // Insert modules in order (parent before child)
    // Sort by parentPath length to ensure parents are created first
    const sortedModules = [...parsedModules].sort((a, b) => {
      const aDepth = a.parentPath.split('.').length;
      const bDepth = b.parentPath.split('.').length;
      return aDepth - bDepth;
    });

    let insertedCount = 0;
    for (const mod of sortedModules) {
      if (maxModules > 0 && db.modules.getCount() >= maxModules) {
        if (!isJson) {
          this.log(chalk.yellow(`  Reached max-modules limit (${maxModules}), stopping module creation`));
        }
        break;
      }

      const parent = db.modules.getByPath(mod.parentPath);
      if (!parent) {
        if (verbose && !isJson) {
          this.log(chalk.yellow(`  Skipping ${mod.slug}: parent ${mod.parentPath} not found`));
        }
        continue;
      }

      try {
        db.modules.insert(parent.id, mod.slug, mod.name, mod.description, mod.isTest);
        insertedCount++;
      } catch (error) {
        if (verbose && !isJson) {
          const message = getErrorMessage(error);
          this.log(chalk.yellow(`  Failed to insert ${mod.slug}: ${message}`));
        }
      }
    }

    if (!isJson) {
      this.log(chalk.green(`  Created ${insertedCount} modules`));
    }
  }

  /**
   * Phase 2: Assign symbols to modules.
   */
  private async runAssignmentPhase(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    flags: Record<string, unknown>,
    dryRun: boolean,
    isJson: boolean,
    verbose: boolean,
    llmLogOptions: LlmLogOptions
  ): Promise<void> {
    if (!isJson) {
      this.log('');
      this.log(chalk.bold('Phase 2: Symbol Assignment'));
    }

    // Get all modules
    const modules = db.modules.getAll();
    if (modules.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ error: 'No modules found. Run tree phase first.' }));
      } else {
        this.log(chalk.yellow('No modules found. Run tree phase first.'));
      }
      return;
    }

    // Build module path lookup
    const moduleByPath = new Map(modules.map((m) => [m.fullPath, m]));

    // Get unassigned symbols
    const unassignedSymbols = db.modules.getUnassigned();
    if (unassignedSymbols.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ message: 'All symbols already assigned' }));
      } else {
        this.log(chalk.green('  All symbols already assigned.'));
      }
      return;
    }

    if (!isJson) {
      this.log(chalk.gray(`  Unassigned symbols: ${unassignedSymbols.length}`));
      this.log(chalk.gray(`  Available modules: ${modules.length}`));
    }

    const batchSize = flags['batch-size'] as number;
    const maxIterations = flags['max-iterations'] as number;
    const systemPrompt = buildAssignmentSystemPrompt();

    // Auto-adjust max iterations to ensure every symbol gets at least one LLM attempt
    const neededIterations = Math.ceil(unassignedSymbols.length / batchSize);
    const effectiveMaxIterations = Math.max(maxIterations, neededIterations);
    if (effectiveMaxIterations > maxIterations && !isJson) {
      this.log(
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
        directoryHints = this.computeModuleDirectoryHints(db);
      }

      if (verbose && !isJson) {
        this.log(chalk.gray(`  Batch ${iteration}: ${batch.length} symbols...`));
      }

      const userPrompt = buildAssignmentUserPrompt(modules, symbolsForAssignment, directoryHints);

      try {
        logLlmRequest(this, `runAssignmentPhase-batch${iteration}`, systemPrompt, userPrompt, llmLogOptions);

        const response = await completeWithLogging({
          model: flags.model as string,
          systemPrompt,
          userPrompt,
          temperature: 0,
          command: this,
          isJson,
          iteration: { current: iteration, max: effectiveMaxIterations },
        });

        logLlmResponse(this, `runAssignmentPhase-batch${iteration}`, response, llmLogOptions);

        const { assignments, errors } = parseAssignmentCsv(response);

        if (errors.length > 0 && verbose && !isJson) {
          this.log(chalk.yellow(`    Parse warnings: ${errors.length}`));
        }

        // Validate and apply assignments
        const result = this.applyParsedAssignments(assignments, moduleByPath, db, dryRun, allAssignments);
        totalAssigned += result.assigned;

        if (!isJson && (result.invalidPath > 0 || result.notFound > 0 || result.fuzzy > 0)) {
          const parts: string[] = [];
          if (result.fuzzy > 0) parts.push(`${result.fuzzy} fuzzy-resolved`);
          if (result.invalidPath > 0) parts.push(`${result.invalidPath} invalid-path`);
          if (result.notFound > 0) parts.push(`${result.notFound} not-found`);
          this.log(chalk.yellow(`    Batch ${iteration}: ${parts.join(', ')}`));
        }

        // Detect omitted symbols and retry once
        const returnedIds = new Set(assignments.map((a) => a.symbolId));
        const omittedSymbols = batch.filter((s) => !returnedIds.has(s.id));

        if (omittedSymbols.length > 0 && omittedSymbols.length <= batchSize / 2) {
          const retrySymbols = omittedSymbols.map(toSymbolForAssignment);
          const retryUserPrompt = buildAssignmentUserPrompt(modules, retrySymbols, directoryHints);

          try {
            const retryResponse = await completeWithLogging({
              model: flags.model as string,
              systemPrompt,
              userPrompt: retryUserPrompt,
              temperature: 0,
              command: this,
              isJson,
              iteration: { current: iteration, max: effectiveMaxIterations },
            });

            const { assignments: retryAssignments } = parseAssignmentCsv(retryResponse);
            const retryResult = this.applyParsedAssignments(retryAssignments, moduleByPath, db, dryRun, allAssignments);
            totalAssigned += retryResult.assigned;

            if (verbose && !isJson) {
              this.log(chalk.gray(`    Retry: ${omittedSymbols.length} omitted → ${retryResult.assigned} assigned`));
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
          this.log(chalk.red(`  Batch ${iteration} failed: ${message}`));
        }
      }
    }

    if (!isJson && !verbose) {
      this.log(''); // New line after dots
    }

    if (dryRun) {
      if (isJson) {
        this.log(
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
        this.log(chalk.gray(`  Would assign ${totalAssigned} symbols`));
      }
      return;
    }

    if (!isJson) {
      this.log(chalk.green(`  Assigned ${totalAssigned} symbols`));
    }
  }

  /**
   * Coverage gate: check unassigned symbol % and run catch-up passes if needed.
   */
  private async runAssignmentCoverageGate(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    flags: Record<string, unknown>,
    maxUnassignedPct: number,
    maxGateRetries: number,
    isJson: boolean,
    _verbose: boolean
  ): Promise<void> {
    const stats = db.modules.getStats();
    const total = stats.assigned + stats.unassigned;
    if (total === 0) return;

    let unassignedPct = (stats.unassigned / total) * 100;

    if (unassignedPct <= maxUnassignedPct) return;

    if (!isJson) {
      this.log('');
      this.log(
        chalk.yellow(
          `  ${unassignedPct.toFixed(1)}% symbols still unassigned (threshold: ${maxUnassignedPct}%), running catch-up passes`
        )
      );
    }

    const modules = db.modules.getAll();
    const moduleByPath = new Map(modules.map((m) => [m.fullPath, m]));
    const batchSize = flags['batch-size'] as number;

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
        this.log(chalk.gray(`  Catch-up pass ${retry + 1}/${maxGateRetries}: ${unassigned.length} symbols remaining`));
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
            model: flags.model as string,
            systemPrompt: relaxedSystemPrompt,
            userPrompt,
            temperature: 0,
            command: this,
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
              targetModule = this.resolveModulePath(assignment.modulePath, moduleByPath);
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
            this.log(chalk.red(`    Catch-up batch error: ${message}`));
          }
        }
      }

      if (!isJson) {
        const parts: string[] = [`${passAssigned} assigned`];
        if (passFuzzy > 0) parts.push(`${passFuzzy} fuzzy-resolved`);
        if (passInvalidPath > 0) parts.push(`${passInvalidPath} invalid-path`);
        if (passNotFound > 0) parts.push(`${passNotFound} not-found`);
        if (passErrors > 0) parts.push(`${passErrors} errors`);
        this.log(chalk.gray(`  Pass ${retry + 1} summary: ${parts.join(', ')}`));
      }

      // Early exit: no progress this pass
      if (passAssigned === 0) {
        if (!isJson) {
          this.log(chalk.yellow('  No progress this pass \u2014 stopping early'));
        }
        break;
      }

      // Re-check
      const updatedStats = db.modules.getStats();
      unassignedPct = (updatedStats.unassigned / total) * 100;
      if (unassignedPct <= maxUnassignedPct) {
        if (!isJson) {
          this.log(chalk.green(`  Coverage gate passed: ${unassignedPct.toFixed(1)}% unassigned`));
        }
        return;
      }
    }

    if (!isJson) {
      const finalStats = db.modules.getStats();
      const finalPct = (finalStats.unassigned / total) * 100;
      this.log(
        chalk.yellow(`  Coverage gate: ${finalPct.toFixed(1)}% still unassigned after ${maxGateRetries} retries`)
      );
    }
  }

  /**
   * Phase 3: Deepen large modules by splitting them into sub-modules.
   * Step 1: Rebalance branch modules (has children + direct members) — no new modules created.
   * Step 2: Split leaf modules (largest first) — consumes module budget.
   */
  private async runDeepenPhase(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    flags: Record<string, unknown>,
    threshold: number,
    dryRun: boolean,
    isJson: boolean,
    verbose: boolean,
    llmLogOptions: LlmLogOptions,
    maxModules: number
  ): Promise<void> {
    if (!isJson) {
      this.log('');
      this.log(chalk.bold('Phase 3: Module Deepening'));
    }

    let totalNewModules = 0;
    let totalReassignments = 0;
    let totalRebalanced = 0;

    // Step 1: Rebalance branch modules (no new modules, no budget spent)
    if (!dryRun) {
      const branchModules = db.modules.getBranchModulesWithDirectMembers(threshold);
      if (branchModules.length > 0 && !isJson) {
        this.log(chalk.gray(`  Rebalancing ${branchModules.length} branch modules with direct members`));
      }
      for (const mod of branchModules) {
        if (verbose && !isJson) {
          this.log(chalk.gray(`    Rebalancing ${mod.fullPath} (${mod.members.length} direct members)...`));
        }

        // Get existing children paths
        const children = db.modules.getChildren(mod.id);
        const childPaths = children.map((c) => c.fullPath);

        if (childPaths.length === 0) continue;

        try {
          const rebalanced = await this.rebalanceAncestorSymbols(
            db,
            mod.fullPath,
            childPaths,
            flags,
            isJson,
            verbose,
            llmLogOptions,
            true // includeSelf: push branch's own members to children
          );
          totalRebalanced += rebalanced;
        } catch (error) {
          const message = getErrorMessage(error);
          if (!isJson) {
            this.log(chalk.red(`    Failed to rebalance ${mod.fullPath}: ${message}`));
          }
        }
      }
    }

    // Step 2: Split leaf modules (budget consumed)
    const maxIterations = 5; // Safety limit to prevent infinite loops
    const maxDepth = flags['max-depth'] as number;
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
        this.log(
          chalk.gray(`  Skipped ${allLargeLeaves.length - largeLeaves.length} modules at max depth ${maxDepth}`)
        );
      }

      if (largeLeaves.length === 0) {
        if (verbose && !isJson) {
          this.log(chalk.gray(`  Iteration ${iteration}: All leaf modules under threshold or at max depth`));
        }
        break;
      }

      if (!isJson) {
        this.log(chalk.gray(`  Iteration ${iteration}: ${largeLeaves.length} leaf modules exceed threshold`));
      }

      // Process each large leaf module
      for (const mod of largeLeaves) {
        if (hitModuleLimit) break;

        if (verbose && !isJson) {
          this.log(chalk.gray(`    Splitting ${mod.fullPath} (${mod.members.length} members)...`));
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
          logLlmRequest(this, `runDeepenPhase-${mod.fullPath}`, deepenSystemPrompt, deepenUserPrompt, llmLogOptions);

          const response = await completeWithLogging({
            model: flags.model as string,
            systemPrompt: deepenSystemPrompt,
            userPrompt: deepenUserPrompt,
            temperature: 0,
            command: this,
            isJson,
          });

          logLlmResponse(this, `runDeepenPhase-${mod.fullPath}`, response, llmLogOptions);

          // Parse response
          const { newModules, reassignments, errors } = parseDeepenCsv(response);

          if (errors.length > 0 && verbose && !isJson) {
            this.log(chalk.yellow(`      Parse warnings: ${errors.length}`));
            for (const err of errors.slice(0, 3)) {
              this.log(chalk.gray(`        ${err}`));
            }
          }

          if (newModules.length === 0) {
            if (verbose && !isJson) {
              this.log(chalk.yellow(`      No sub-modules proposed for ${mod.fullPath}`));
            }
            continue;
          }

          if (dryRun) {
            if (verbose && !isJson) {
              this.log(chalk.gray(`      Would create ${newModules.length} sub-modules`));
              for (const sub of newModules) {
                this.log(chalk.cyan(`        ${mod.fullPath}.${sub.slug}: ${sub.name}`));
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
                this.log(chalk.yellow(`  Reached max-modules limit (${maxModules}), stopping module creation`));
              }
              hitModuleLimit = true;
              break;
            }

            const parent = db.modules.getByPath(subMod.parentPath);
            if (!parent) {
              if (verbose && !isJson) {
                this.log(chalk.yellow(`      Parent not found: ${subMod.parentPath}`));
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
                this.log(chalk.yellow(`      Failed to create ${subMod.slug}: ${message}`));
              }
            }
          }

          // Reassign symbols to new sub-modules
          for (const reassignment of reassignments) {
            const targetModule = db.modules.getByPath(reassignment.targetModulePath);
            if (!targetModule) {
              if (verbose && !isJson) {
                this.log(chalk.yellow(`      Target module not found: ${reassignment.targetModulePath}`));
              }
              continue;
            }

            db.modules.assignSymbol(reassignment.definitionId, targetModule.id);
            totalReassignments++;
          }

          // Rebalance ancestor symbols into new sub-modules
          if (createdSubModulePaths.length > 0 && !hitModuleLimit) {
            const rebalanced = await this.rebalanceAncestorSymbols(
              db,
              mod.fullPath,
              createdSubModulePaths,
              flags,
              isJson,
              verbose,
              llmLogOptions
            );
            totalRebalanced += rebalanced;
          }
        } catch (error) {
          const message = getErrorMessage(error);
          if (!isJson) {
            this.log(chalk.red(`    Failed to process ${mod.fullPath}: ${message}`));
          }
        }
      }
    }

    if (iteration >= maxIterations && !isJson) {
      this.log(chalk.yellow(`  Warning: Reached max iterations (${maxIterations})`));
    }

    // Deterministic fallback: push remaining branch members to children by file/directory cohort
    if (!dryRun) {
      const fallbackPushed = this.pushdownBranchMembersFallback(db, isJson, verbose);
      if (fallbackPushed > 0) {
        totalRebalanced += fallbackPushed;
      }
    }

    if (dryRun) {
      if (isJson) {
        this.log(
          JSON.stringify({
            phase: 'deepen',
            dryRun: true,
            proposedNewModules: totalNewModules,
            proposedReassignments: totalReassignments,
          })
        );
      } else {
        this.log(chalk.gray(`  Would create ${totalNewModules} sub-modules`));
        this.log(chalk.gray(`  Would reassign ${totalReassignments} symbols`));
      }
    } else if (!isJson) {
      this.log(chalk.green(`  Created ${totalNewModules} sub-modules`));
      this.log(chalk.green(`  Reassigned ${totalReassignments} symbols`));
      if (totalRebalanced > 0) {
        this.log(chalk.green(`  Rebalanced ${totalRebalanced} symbols from ancestors`));
      }
    }
  }

  /**
   * Rebalance symbols from ancestor modules into newly created sub-modules.
   * Walks up from the deepened module collecting symbols from ancestors,
   * then asks the LLM if any should be moved into the new sub-structure.
   * Returns the number of symbols rebalanced.
   */
  private async rebalanceAncestorSymbols(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    deepenedModulePath: string,
    newSubModulePaths: string[],
    flags: Record<string, unknown>,
    isJson: boolean,
    verbose: boolean,
    llmLogOptions: LlmLogOptions,
    includeSelf = false
  ): Promise<number> {
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
    for (const path of ancestorPaths) {
      const mod = db.modules.getByPath(path);
      if (!mod) continue;
      const symbols = db.modules.getSymbols(mod.id);
      if (symbols.length === 0) continue;
      ancestorSymbols.push({ moduleId: mod.id, modulePath: path, symbols });
    }

    if (ancestorSymbols.length === 0) return 0;

    const totalSymbols = ancestorSymbols.reduce((sum, g) => sum + g.symbols.length, 0);
    if (verbose && !isJson) {
      this.log(
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

    logLlmRequest(this, `rebalance-${deepenedModulePath}`, systemPrompt, userPrompt, llmLogOptions);

    try {
      const response = await completeWithLogging({
        model: flags.model as string,
        systemPrompt,
        userPrompt,
        temperature: 0,
        command: this,
        isJson,
      });

      logLlmResponse(this, `rebalance-${deepenedModulePath}`, response, llmLogOptions);

      const { assignments, errors } = parseAssignmentCsv(response);

      if (errors.length > 0 && verbose && !isJson) {
        this.log(chalk.yellow(`      Rebalance parse warnings: ${errors.length}`));
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
          targetModule = this.resolveModulePath(assignment.modulePath, subModuleByPath, deepenedModulePath);
        }

        if (!targetModule) {
          if (verbose && !isJson) {
            this.log(chalk.yellow(`      Rebalance: skipping move to ${assignment.modulePath} (not a new sub-module)`));
          }
          continue;
        }

        db.modules.assignSymbol(assignment.symbolId, targetModule.id);
        rebalanced++;
      }

      if (rebalanced > 0 && verbose && !isJson) {
        this.log(chalk.gray(`      Rebalanced ${rebalanced} symbols from ancestors`));
      }

      return rebalanced;
    } catch (error) {
      const message = getErrorMessage(error);
      if (verbose && !isJson) {
        this.log(chalk.yellow(`      Rebalance failed: ${message}`));
      }
      return 0;
    }
  }

  /**
   * Validate and apply parsed assignment rows.
   * Returns counts of assigned, fuzzy-resolved, invalid-path, and not-found assignments.
   */
  private applyParsedAssignments(
    assignments: Array<{ symbolId: number; modulePath: string }>,
    moduleByPath: Map<string, Module>,
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    dryRun: boolean,
    allAssignments: Array<{ symbolId: number; modulePath: string }>
  ): { assigned: number; fuzzy: number; invalidPath: number; notFound: number } {
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
        targetModule = this.resolveModulePath(assignment.modulePath, moduleByPath);
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

  /**
   * Resolve a module path against the lookup map.
   * Tries exact match first, then falls back to matching by final segment(s).
   * Returns undefined if no match or ambiguous (multiple candidates).
   */
  private resolveModulePath<T extends { id: number; fullPath: string }>(
    path: string,
    moduleByPath: Map<string, T>,
    constrainPrefix?: string
  ): T | undefined {
    // Exact match
    const exact = moduleByPath.get(path);
    if (exact) return exact;

    // Fuzzy: match by final segment(s)
    const segments = path.split('.');
    const candidates: T[] = [];

    for (const [fullPath, mod] of moduleByPath) {
      if (constrainPrefix && !fullPath.startsWith(constrainPrefix)) continue;
      const fullSegments = fullPath.split('.');
      // Check if the path's segments match the tail of the full path
      if (fullSegments.length >= segments.length) {
        const tail = fullSegments.slice(fullSegments.length - segments.length);
        if (tail.every((s, i) => s === segments[i])) {
          candidates.push(mod);
        }
      }
    }

    // Only return if exactly one candidate (avoid ambiguity)
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /**
   * Compute directory hints for each module based on current member file paths.
   * Returns the top 3 directories per module by member count.
   */
  private computeModuleDirectoryHints(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never
  ): Map<number, string[]> {
    const hints = new Map<number, string[]>();
    for (const mod of db.modules.getAllWithMembers()) {
      if (mod.members.length === 0) continue;
      const dirCounts = new Map<string, number>();
      for (const m of mod.members) {
        const dir = m.filePath.split('/').slice(0, -1).join('/');
        if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }
      hints.set(
        mod.id,
        Array.from(dirCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([dir]) => dir)
      );
    }
    return hints;
  }

  /**
   * Deterministic fallback: assign remaining unassigned symbols using file/directory cohort majority.
   * Tier 1: If other symbols in the same file are assigned to a module, assign there.
   * Tier 2: If other symbols in the same directory are assigned to a module, assign there.
   *         Walks up parent directories if no match at the immediate level.
   * Test-file guard: test file symbols only assigned to test modules.
   */
  private assignByFileCohortFallback(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    isJson: boolean,
    verbose: boolean
  ): number {
    const allModulesWithMembers = db.modules.getAllWithMembers();
    const allModules = db.modules.getAll();
    const moduleById = new Map(allModules.map((m) => [m.id, m]));

    // Build per-file and per-directory module counts from assigned symbols
    const fileModuleCounts = new Map<string, Map<number, number>>();
    const dirModuleCounts = new Map<string, Map<number, number>>();

    for (const mod of allModulesWithMembers) {
      for (const member of mod.members) {
        // Per-file counts
        let fileCounts = fileModuleCounts.get(member.filePath);
        if (!fileCounts) {
          fileCounts = new Map();
          fileModuleCounts.set(member.filePath, fileCounts);
        }
        fileCounts.set(mod.id, (fileCounts.get(mod.id) ?? 0) + 1);

        // Per-directory counts
        const dir = path.dirname(member.filePath);
        if (dir) {
          let dirCounts = dirModuleCounts.get(dir);
          if (!dirCounts) {
            dirCounts = new Map();
            dirModuleCounts.set(dir, dirCounts);
          }
          dirCounts.set(mod.id, (dirCounts.get(mod.id) ?? 0) + 1);
        }
      }
    }

    // Resolve majority module per file
    const fileMajority = new Map<string, { moduleId: number; count: number }>();
    for (const [filePath, moduleCounts] of fileModuleCounts) {
      let bestModuleId = -1;
      let bestCount = 0;
      for (const [moduleId, count] of moduleCounts) {
        if (count > bestCount) {
          bestModuleId = moduleId;
          bestCount = count;
        }
      }
      if (bestModuleId >= 0) {
        fileMajority.set(filePath, { moduleId: bestModuleId, count: bestCount });
      }
    }

    // Resolve majority module per directory
    const dirMajority = new Map<string, { moduleId: number; count: number }>();
    for (const [dir, moduleCounts] of dirModuleCounts) {
      let bestModuleId = -1;
      let bestCount = 0;
      for (const [moduleId, count] of moduleCounts) {
        if (count > bestCount) {
          bestModuleId = moduleId;
          bestCount = count;
        }
      }
      if (bestModuleId >= 0) {
        dirMajority.set(dir, { moduleId: bestModuleId, count: bestCount });
      }
    }

    const unassigned = db.modules.getUnassigned();
    let tier1Count = 0;
    let tier2Count = 0;
    const stillUnassigned: typeof unassigned = [];

    for (const sym of unassigned) {
      const symIsTest = isTestFile(sym.filePath);

      // Tier 1: Same-file majority
      const fileMaj = fileMajority.get(sym.filePath);
      if (fileMaj) {
        const mod = moduleById.get(fileMaj.moduleId);
        if (mod && (!symIsTest || mod.isTest)) {
          db.modules.assignSymbol(sym.id, fileMaj.moduleId);
          tier1Count++;
          continue;
        }
      }

      // Tier 2: Same-directory majority, walking up parent dirs
      let dir = path.dirname(sym.filePath);
      let assigned = false;
      while (dir && dir !== '.' && dir !== '/') {
        const dirMaj = dirMajority.get(dir);
        if (dirMaj) {
          const mod = moduleById.get(dirMaj.moduleId);
          if (mod && (!symIsTest || mod.isTest)) {
            db.modules.assignSymbol(sym.id, dirMaj.moduleId);
            tier2Count++;
            assigned = true;
            break;
          }
        }
        dir = path.dirname(dir);
      }

      if (!assigned) {
        stillUnassigned.push(sym);
      }
    }

    if (verbose && !isJson) {
      this.log(chalk.gray('  Deterministic fallback:'));
      this.log(chalk.gray(`    Tier 1 (file cohort): ${tier1Count} assigned`));
      this.log(chalk.gray(`    Tier 2 (directory cohort): ${tier2Count} assigned`));
      if (stillUnassigned.length > 0) {
        this.log(chalk.gray(`    Still unassigned: ${stillUnassigned.length}`));
      }
    }

    return tier1Count + tier2Count;
  }

  /**
   * Deterministic fallback: push direct members of branch modules to their children
   * using file/directory cohort voting. Loops until no more progress.
   */
  private pushdownBranchMembersFallback(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
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
        const fileVotes = new Map<string, Map<number, number>>();
        const dirVotes = new Map<string, Map<number, number>>();

        for (const child of children) {
          const childMembers = db.modules.getMemberInfo(child.id);
          for (const member of childMembers) {
            // File votes
            let fv = fileVotes.get(member.filePath);
            if (!fv) {
              fv = new Map();
              fileVotes.set(member.filePath, fv);
            }
            fv.set(child.id, (fv.get(child.id) ?? 0) + 1);

            // Directory votes
            const dir = path.dirname(member.filePath);
            if (dir) {
              let dv = dirVotes.get(dir);
              if (!dv) {
                dv = new Map();
                dirVotes.set(dir, dv);
              }
              dv.set(child.id, (dv.get(child.id) ?? 0) + 1);
            }
          }
        }

        // Resolve majority child per file
        const fileMajority = new Map<string, number>();
        for (const [filePath, votes] of fileVotes) {
          let bestId = -1;
          let bestCount = 0;
          for (const [childId, count] of votes) {
            if (count > bestCount) {
              bestId = childId;
              bestCount = count;
            }
          }
          if (bestId >= 0) fileMajority.set(filePath, bestId);
        }

        // Resolve majority child per directory
        const dirMajority = new Map<string, number>();
        for (const [dir, votes] of dirVotes) {
          let bestId = -1;
          let bestCount = 0;
          for (const [childId, count] of votes) {
            if (count > bestCount) {
              bestId = childId;
              bestCount = count;
            }
          }
          if (bestId >= 0) dirMajority.set(dir, bestId);
        }

        const childById = new Map(children.map((c) => [c.id, c]));

        for (const member of branch.members) {
          const symIsTest = isTestFile(member.filePath);
          let targetChildId: number | undefined;

          // Tier 1: Same-file majority
          const fileTarget = fileMajority.get(member.filePath);
          if (fileTarget !== undefined) {
            const child = childById.get(fileTarget);
            if (child && (!symIsTest || child.isTest)) {
              targetChildId = fileTarget;
            }
          }

          // Tier 2: Same-directory majority (walk up)
          if (targetChildId === undefined) {
            let dir = path.dirname(member.filePath);
            while (dir && dir !== '.' && dir !== '/') {
              const dirTarget = dirMajority.get(dir);
              if (dirTarget !== undefined) {
                const child = childById.get(dirTarget);
                if (child && (!symIsTest || child.isTest)) {
                  targetChildId = dirTarget;
                  break;
                }
              }
              dir = path.dirname(dir);
            }
          }

          // Tier 3: Single child — move unconditionally
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
      this.log(chalk.gray(`  Branch pushdown fallback: ${totalPushed} symbols pushed to children`));
    }

    return totalPushed;
  }

  /**
   * Run module assignment verification checks.
   */
  private runModuleVerify(ctx: LlmContext, flags: Record<string, unknown>): void {
    const { db, isJson, dryRun } = ctx;
    const shouldFix = flags.fix as boolean;

    if (!isJson) {
      this.log(chalk.bold('Module Assignment Verification'));
      this.log('');
    }

    const result = checkModuleAssignments(db);

    if (!isJson) {
      const warningIssues = result.issues.filter((i) => i.severity === 'warning');
      const infoIssues = result.issues.filter((i) => i.severity === 'info');

      if (warningIssues.length > 0) {
        this.log(chalk.yellow(`  Warnings (${warningIssues.length}):`));
        for (const issue of warningIssues.slice(0, 30)) {
          this.log(`    ${chalk.yellow('WARN')} [${issue.category}] ${issue.message}`);
        }
        if (warningIssues.length > 30) {
          this.log(chalk.gray(`    ... and ${warningIssues.length - 30} more`));
        }
        this.log('');
      }

      if (infoIssues.length > 0) {
        this.log(chalk.gray(`  Info (${infoIssues.length}):`));
        for (const issue of infoIssues.slice(0, 20)) {
          this.log(`    ${chalk.gray('INFO')} [${issue.category}] ${issue.message}`);
        }
        if (infoIssues.length > 20) {
          this.log(chalk.gray(`    ... and ${infoIssues.length - 20} more`));
        }
        this.log('');
      }

      if (result.passed) {
        this.log(chalk.green('  \u2713 All module assignments passed verification'));
      } else {
        this.log(chalk.red(`  \u2717 Verification failed: ${result.stats.structuralIssueCount} structural issues`));
      }
    }

    // Auto-fix: move test symbols to nearest test module
    if (shouldFix && !dryRun) {
      const testInProdIssues = result.issues.filter((i) => i.fixData?.action === 'move-to-test-module');
      if (testInProdIssues.length > 0) {
        // Find a test module to move symbols to
        const modules = db.modules.getAll();
        const testModules = modules.filter((m) => m.isTest);

        if (testModules.length === 0) {
          if (!isJson) {
            this.log(chalk.yellow('  No test modules found — cannot auto-fix test-in-production issues'));
          }
        } else {
          // Use deepest test module as default target
          const targetModule = testModules.sort((a, b) => b.depth - a.depth)[0];
          let fixed = 0;
          for (const issue of testInProdIssues) {
            if (issue.definitionId) {
              db.modules.assignSymbol(issue.definitionId, targetModule.id);
              fixed++;
            }
          }
          if (!isJson) {
            this.log(chalk.green(`  Fixed: moved ${fixed} test symbols to '${targetModule.fullPath}'`));
          }
        }
      }
    }

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    }
  }

  /**
   * Build context for tree generation from database.
   */
  private buildTreeContext(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    maxModules?: number
  ): TreeGenerationContext {
    // Get all annotated symbols
    const allSymbols = db.modules.getUnassigned();

    // Aggregate by domain
    const domainMap = new Map<
      string,
      {
        count: number;
        symbols: Array<{ name: string; kind: string; role: string | null }>;
      }
    >();

    for (const sym of allSymbols) {
      const domains = sym.domain ?? ['untagged'];
      for (const domain of domains) {
        const existing = domainMap.get(domain) ?? { count: 0, symbols: [] };
        existing.count++;
        if (existing.symbols.length < 10) {
          existing.symbols.push({ name: sym.name, kind: sym.kind, role: sym.role });
        }
        domainMap.set(domain, existing);
      }
    }

    // Convert to DomainSummary array, sorted by count
    const domains: DomainSummary[] = Array.from(domainMap.entries())
      .map(([domain, data]) => ({
        domain,
        count: data.count,
        sampleSymbols: data.symbols,
      }))
      .sort((a, b) => b.count - a.count);

    // Count symbols per leaf directory
    const dirCounts = new Map<string, number>();
    for (const sym of allSymbols) {
      const dir = sym.filePath.split('/').slice(0, -1).join('/');
      if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    // Build DirectoryInfo[] — include all ancestor directories too, with cumulative counts
    const allDirs = new Set<string>();
    for (const sym of allSymbols) {
      const parts = sym.filePath.split('/');
      let path = '';
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        allDirs.add(path);
      }
    }

    const directoryStructure: DirectoryInfo[] = Array.from(allDirs)
      .sort()
      .map((dir) => ({
        path: dir,
        symbolCount: dirCounts.get(dir) ?? 0,
      }));

    return {
      totalSymbolCount: allSymbols.length,
      domains,
      directoryStructure,
      maxModules: maxModules && maxModules > 0 ? maxModules : undefined,
    };
  }
}
