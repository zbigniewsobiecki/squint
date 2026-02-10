import { Flags } from '@oclif/core';
import chalk from 'chalk';

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
  buildDeepenSystemPrompt,
  buildDeepenUserPrompt,
  buildRebalanceSystemPrompt,
  buildRebalanceUserPrompt,
  buildTreeSystemPrompt,
  buildTreeUserPrompt,
  toSymbolForAssignment,
} from './_shared/module-prompts.js';

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

    // Check existing modules
    const existingModuleCount = db.getModuleCount();

    if (!incremental) {
      if (
        !this.checkExistingAndClear(ctx, {
          entityName: 'Modules',
          existingCount: existingModuleCount,
          force: flags.force as boolean,
          clearFn: () => db.clearModules(),
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

      // Prune empty leaf modules after assignment
      if (!dryRun) {
        const pruned = db.pruneEmptyLeafModules();
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
          const pruned = db.pruneEmptyLeafModules();
          if (pruned > 0 && !isJson) {
            this.log(chalk.green(`  Pruned ${pruned} empty leaf modules after deepening`));
          }
        }
      }
    }

    // Assign color indices for consistent cross-view coloring
    if (!dryRun) {
      db.assignColorIndices();
    }

    // Final stats
    if (!dryRun) {
      const stats = db.getModuleStats();
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
      db.ensureRootModule();
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
      if (maxModules > 0 && db.getModuleCount() >= maxModules) {
        if (!isJson) {
          this.log(chalk.yellow(`  Reached max-modules limit (${maxModules}), stopping module creation`));
        }
        break;
      }

      const parent = db.getModuleByPath(mod.parentPath);
      if (!parent) {
        if (verbose && !isJson) {
          this.log(chalk.yellow(`  Skipping ${mod.slug}: parent ${mod.parentPath} not found`));
        }
        continue;
      }

      try {
        db.insertModule(parent.id, mod.slug, mod.name, mod.description, mod.isTest);
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
    const modules = db.getAllModules();
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
    const unassignedSymbols = db.getUnassignedSymbols();
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

    let totalAssigned = 0;
    let iteration = 0;
    const allAssignments: Array<{ symbolId: number; modulePath: string }> = [];
    let directoryHints: Map<number, string[]> | undefined;

    // Process in batches
    for (let i = 0; i < unassignedSymbols.length && iteration < maxIterations; i += batchSize) {
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
          iteration: { current: iteration, max: maxIterations },
        });

        logLlmResponse(this, `runAssignmentPhase-batch${iteration}`, response, llmLogOptions);

        const { assignments, errors } = parseAssignmentCsv(response);

        if (errors.length > 0 && verbose && !isJson) {
          this.log(chalk.yellow(`    Parse warnings: ${errors.length}`));
        }

        // Validate and collect assignments
        let batchFuzzy = 0;
        let batchInvalidPath = 0;
        let batchNotFound = 0;

        for (const assignment of assignments) {
          if (!isValidModulePath(assignment.modulePath)) {
            batchInvalidPath++;
            continue;
          }

          let targetModule = moduleByPath.get(assignment.modulePath);
          if (!targetModule) {
            targetModule = this.resolveModulePath(assignment.modulePath, moduleByPath);
            if (targetModule) {
              batchFuzzy++;
            } else {
              batchNotFound++;
              continue;
            }
          }

          if (!dryRun) {
            db.assignSymbolToModule(assignment.symbolId, targetModule.id);
          }
          allAssignments.push({ symbolId: assignment.symbolId, modulePath: targetModule.fullPath });
          totalAssigned++;
        }

        if (!isJson && (batchInvalidPath > 0 || batchNotFound > 0 || batchFuzzy > 0)) {
          const parts: string[] = [];
          if (batchFuzzy > 0) parts.push(`${batchFuzzy} fuzzy-resolved`);
          if (batchInvalidPath > 0) parts.push(`${batchInvalidPath} invalid-path`);
          if (batchNotFound > 0) parts.push(`${batchNotFound} not-found`);
          this.log(chalk.yellow(`    Batch ${iteration}: ${parts.join(', ')}`));
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
    const stats = db.getModuleStats();
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

    const modules = db.getAllModules();
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
- Consider the file path as a strong hint`;

    for (let retry = 0; retry < maxGateRetries; retry++) {
      const unassigned = db.getUnassignedSymbols();
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

            db.assignSymbolToModule(assignment.symbolId, targetModule.id);
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
      const updatedStats = db.getModuleStats();
      unassignedPct = (updatedStats.unassigned / total) * 100;
      if (unassignedPct <= maxUnassignedPct) {
        if (!isJson) {
          this.log(chalk.green(`  Coverage gate passed: ${unassignedPct.toFixed(1)}% unassigned`));
        }
        return;
      }
    }

    if (!isJson) {
      const finalStats = db.getModuleStats();
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
      const branchModules = db.getBranchModulesWithDirectMembers(threshold);
      if (branchModules.length > 0 && !isJson) {
        this.log(chalk.gray(`  Rebalancing ${branchModules.length} branch modules with direct members`));
      }
      for (const mod of branchModules) {
        if (verbose && !isJson) {
          this.log(chalk.gray(`    Rebalancing ${mod.fullPath} (${mod.members.length} direct members)...`));
        }

        // Get existing children paths
        const children = db.getModuleChildren(mod.id);
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
            llmLogOptions
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
    let iteration = 0;
    let hitModuleLimit = false;

    while (iteration < maxIterations && !hitModuleLimit) {
      iteration++;

      // Query leaf modules exceeding threshold (largest first)
      const largeLeaves = dryRun
        ? db.getModulesExceedingThreshold(threshold)
        : db.getLeafModulesExceedingThreshold(threshold);

      if (largeLeaves.length === 0) {
        if (verbose && !isJson) {
          this.log(chalk.gray(`  Iteration ${iteration}: All leaf modules under threshold`));
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
            if (maxModules > 0 && db.getModuleCount() >= maxModules) {
              if (!isJson) {
                this.log(chalk.yellow(`  Reached max-modules limit (${maxModules}), stopping module creation`));
              }
              hitModuleLimit = true;
              break;
            }

            const parent = db.getModuleByPath(subMod.parentPath);
            if (!parent) {
              if (verbose && !isJson) {
                this.log(chalk.yellow(`      Parent not found: ${subMod.parentPath}`));
              }
              continue;
            }

            try {
              // isTest is inherited from parent in ModuleRepository.insert()
              db.insertModule(parent.id, subMod.slug, subMod.name, subMod.description);
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
            const targetModule = db.getModuleByPath(reassignment.targetModulePath);
            if (!targetModule) {
              if (verbose && !isJson) {
                this.log(chalk.yellow(`      Target module not found: ${reassignment.targetModulePath}`));
              }
              continue;
            }

            db.assignSymbolToModule(reassignment.definitionId, targetModule.id);
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
    llmLogOptions: LlmLogOptions
  ): Promise<number> {
    // Walk up from the deepened module to collect ancestor paths (excluding root "project")
    const segments = deepenedModulePath.split('.');
    const ancestorPaths: string[] = [];
    for (let i = segments.length - 1; i >= 1; i--) {
      const ancestorPath = segments.slice(0, i).join('.');
      if (ancestorPath === 'project') break; // don't rebalance from root
      ancestorPaths.push(ancestorPath);
    }

    if (ancestorPaths.length === 0) return 0;

    // Collect symbols from each ancestor
    const ancestorSymbols: AncestorSymbolGroup[] = [];
    for (const path of ancestorPaths) {
      const mod = db.getModuleByPath(path);
      if (!mod) continue;
      const symbols = db.getModuleSymbols(mod.id);
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
      const mod = db.getModuleByPath(subPath);
      if (!mod) continue;
      newSubModules.push({ path: mod.fullPath, name: mod.name, description: mod.description });
    }

    if (newSubModules.length === 0) return 0;

    // Call LLM for rebalancing
    const systemPrompt = buildRebalanceSystemPrompt();
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
        const mod = db.getModuleByPath(p);
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

        db.assignSymbolToModule(assignment.symbolId, targetModule.id);
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
    for (const mod of db.getAllModulesWithMembers()) {
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
   * Build context for tree generation from database.
   */
  private buildTreeContext(
    db: ReturnType<typeof import('../_shared/index.js').openDatabase> extends Promise<infer T> ? T : never,
    maxModules?: number
  ): TreeGenerationContext {
    // Get all annotated symbols
    const allSymbols = db.getUnassignedSymbols();

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
