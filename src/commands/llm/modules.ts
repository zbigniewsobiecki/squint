import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';

import { SharedFlags, openDatabase } from '../_shared/index.js';
import { type LlmLogOptions, getErrorMessage, logLlmRequest, logLlmResponse } from './_shared/llm-utils.js';
import { isValidModulePath, parseAssignmentCsv, parseDeepenCsv, parseTreeCsv } from './_shared/module-csv.js';
import {
  type DomainSummary,
  type ModuleForDeepening,
  type TreeGenerationContext,
  buildAssignmentSystemPrompt,
  buildAssignmentUserPrompt,
  buildDeepenSystemPrompt,
  buildDeepenUserPrompt,
  buildTreeSystemPrompt,
  buildTreeUserPrompt,
  toSymbolForAssignment,
} from './_shared/module-prompts.js';

export default class Modules extends Command {
  static override description = 'Create module tree structure and assign symbols using LLM';

  static override examples = [
    '<%= config.bin %> llm modules',
    '<%= config.bin %> llm modules --phase tree --dry-run',
    '<%= config.bin %> llm modules --phase assign --batch-size 30',
    '<%= config.bin %> llm modules --force',
  ];

  static override flags = {
    database: SharedFlags.database,
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
    model: Flags.string({
      default: 'openrouter:google/gemini-2.5-flash',
      description: 'LLM model to use',
    }),
    'dry-run': Flags.boolean({
      default: false,
      description: 'Show proposed changes without persisting',
    }),
    force: Flags.boolean({
      default: false,
      description: 'Clear existing modules and start fresh',
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
    'max-gate-retries': Flags.integer({
      default: 3,
      description: 'Maximum retry attempts when assignment gate fails',
    }),
    json: SharedFlags.json,
    verbose: Flags.boolean({
      default: false,
      description: 'Show detailed progress',
    }),
    'show-llm-requests': Flags.boolean({
      description: 'Show LLM request prompts',
      default: false,
    }),
    'show-llm-responses': Flags.boolean({
      description: 'Show LLM response text',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Modules);

    const db = await openDatabase(flags.database, this);
    const dryRun = flags['dry-run'];
    const isJson = flags.json;
    const verbose = flags.verbose;
    const phase = flags.phase;
    const incremental = flags.incremental;
    const llmLogOptions: LlmLogOptions = {
      showRequests: flags['show-llm-requests'],
      showResponses: flags['show-llm-responses'],
      isJson,
    };

    try {
      // Check existing modules
      const existingModuleCount = db.getModuleCount();

      if (existingModuleCount > 0 && !flags.force && !incremental) {
        if (isJson) {
          this.log(
            JSON.stringify({
              error: 'Modules already exist',
              moduleCount: existingModuleCount,
              hint: 'Use --force to recreate or --incremental to assign unassigned symbols',
            })
          );
        } else {
          this.log(chalk.yellow(`${existingModuleCount} modules already exist.`));
          this.log(chalk.gray('Use --force to recreate or --incremental to assign unassigned symbols.'));
        }
        return;
      }

      // Clear modules if force is specified
      if (flags.force && existingModuleCount > 0) {
        if (!dryRun) {
          db.clearModules();
          if (!isJson) {
            this.log(chalk.gray(`Cleared ${existingModuleCount} existing modules.`));
          }
        }
      }

      // Phase 1: Tree Structure Generation
      if ((phase === 'all' || phase === 'tree') && !incremental) {
        await this.runTreePhase(db, flags, dryRun, isJson, verbose, llmLogOptions);
      }

      // Phase 2: Symbol Assignment
      if (phase === 'all' || phase === 'assign') {
        await this.runAssignmentPhase(db, flags, dryRun, isJson, verbose, llmLogOptions);

        // Coverage gate: check unassigned % and run catch-up passes if needed
        if (!dryRun) {
          const maxUnassignedPct = flags['max-unassigned-pct'];
          const maxGateRetries = flags['max-gate-retries'];
          await this.runAssignmentCoverageGate(db, flags, maxUnassignedPct, maxGateRetries, isJson, verbose);
        }

        // Phase 3: Deepening (automatic after assignment, unless disabled)
        const deepenThreshold = flags['deepen-threshold'];
        if (deepenThreshold > 0) {
          await this.runDeepenPhase(db, flags, deepenThreshold, dryRun, isJson, verbose, llmLogOptions);
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
    } finally {
      db.close();
    }
  }

  /**
   * Phase 1: Generate the module tree structure.
   */
  private async runTreePhase(
    db: ReturnType<typeof openDatabase> extends Promise<infer T> ? T : never,
    flags: { model: string; 'dry-run': boolean },
    dryRun: boolean,
    isJson: boolean,
    verbose: boolean,
    llmLogOptions: LlmLogOptions
  ): Promise<void> {
    if (!isJson) {
      this.log(chalk.bold('Phase 1: Tree Structure Generation'));
    }

    // Ensure root module exists
    if (!dryRun) {
      db.ensureRootModule();
    }

    // Gather context for the LLM
    const context = this.buildTreeContext(db);

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
    const response = await LLMist.complete(userPrompt, {
      model: flags.model,
      systemPrompt,
      temperature: 0,
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
    db: ReturnType<typeof openDatabase> extends Promise<infer T> ? T : never,
    flags: { model: string; 'batch-size': number; 'max-iterations': number },
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

    const batchSize = flags['batch-size'];
    const maxIterations = flags['max-iterations'];
    const systemPrompt = buildAssignmentSystemPrompt();

    let totalAssigned = 0;
    let iteration = 0;
    const allAssignments: Array<{ symbolId: number; modulePath: string }> = [];

    // Process in batches
    for (let i = 0; i < unassignedSymbols.length && iteration < maxIterations; i += batchSize) {
      iteration++;
      const batch = unassignedSymbols.slice(i, i + batchSize);
      const symbolsForAssignment = batch.map(toSymbolForAssignment);

      if (verbose && !isJson) {
        this.log(chalk.gray(`  Batch ${iteration}: ${batch.length} symbols...`));
      }

      const userPrompt = buildAssignmentUserPrompt(modules, symbolsForAssignment);

      try {
        logLlmRequest(this, `runAssignmentPhase-batch${iteration}`, systemPrompt, userPrompt, llmLogOptions);

        const response = await LLMist.complete(userPrompt, {
          model: flags.model,
          systemPrompt,
          temperature: 0,
        });

        logLlmResponse(this, `runAssignmentPhase-batch${iteration}`, response, llmLogOptions);

        const { assignments, errors } = parseAssignmentCsv(response);

        if (errors.length > 0 && verbose && !isJson) {
          this.log(chalk.yellow(`    Parse warnings: ${errors.length}`));
        }

        // Validate and collect assignments
        for (const assignment of assignments) {
          if (!isValidModulePath(assignment.modulePath)) {
            if (verbose && !isJson) {
              this.log(chalk.yellow(`    Invalid path: ${assignment.modulePath}`));
            }
            continue;
          }

          const targetModule = moduleByPath.get(assignment.modulePath);
          if (!targetModule) {
            if (verbose && !isJson) {
              this.log(chalk.yellow(`    Module not found: ${assignment.modulePath}`));
            }
            continue;
          }

          if (!dryRun) {
            db.assignSymbolToModule(assignment.symbolId, targetModule.id);
          }
          allAssignments.push(assignment);
          totalAssigned++;
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
    db: ReturnType<typeof openDatabase> extends Promise<infer T> ? T : never,
    flags: { model: string; 'batch-size': number },
    maxUnassignedPct: number,
    maxGateRetries: number,
    isJson: boolean,
    verbose: boolean
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
    const batchSize = flags['batch-size'];

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

      if (!isJson && verbose) {
        this.log(chalk.gray(`  Catch-up pass ${retry + 1}/${maxGateRetries}: ${unassigned.length} symbols remaining`));
      }

      for (let i = 0; i < unassigned.length; i += batchSize) {
        const batch = unassigned.slice(i, i + batchSize);
        const symbolsForAssignment = batch.map(toSymbolForAssignment);
        const userPrompt = buildAssignmentUserPrompt(modules, symbolsForAssignment);

        try {
          const response = await LLMist.complete(userPrompt, {
            model: flags.model,
            systemPrompt: relaxedSystemPrompt,
            temperature: 0,
          });

          const { assignments } = parseAssignmentCsv(response);
          for (const assignment of assignments) {
            if (!isValidModulePath(assignment.modulePath)) continue;
            const targetModule = moduleByPath.get(assignment.modulePath);
            if (!targetModule) continue;
            db.assignSymbolToModule(assignment.symbolId, targetModule.id);
          }
        } catch {
          // Continue with next batch on failure
        }
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
   */
  private async runDeepenPhase(
    db: ReturnType<typeof openDatabase> extends Promise<infer T> ? T : never,
    flags: { model: string },
    threshold: number,
    dryRun: boolean,
    isJson: boolean,
    verbose: boolean,
    llmLogOptions: LlmLogOptions
  ): Promise<void> {
    if (!isJson) {
      this.log('');
      this.log(chalk.bold('Phase 3: Module Deepening'));
    }

    const maxIterations = 5; // Safety limit to prevent infinite loops
    let iteration = 0;
    let totalNewModules = 0;
    let totalReassignments = 0;

    while (iteration < maxIterations) {
      iteration++;

      // Query modules exceeding threshold
      const largeModules = db.getModulesExceedingThreshold(threshold);

      if (largeModules.length === 0) {
        if (verbose && !isJson) {
          this.log(chalk.gray(`  Iteration ${iteration}: All modules under threshold`));
        }
        break;
      }

      if (!isJson) {
        this.log(chalk.gray(`  Iteration ${iteration}: ${largeModules.length} modules exceed threshold`));
      }

      // Process each large module
      for (const mod of largeModules) {
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

          const response = await LLMist.complete(deepenUserPrompt, {
            model: flags.model,
            systemPrompt: deepenSystemPrompt,
            temperature: 0,
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
          for (const subMod of newModules) {
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
    }
  }

  /**
   * Build context for tree generation from database.
   */
  private buildTreeContext(
    db: ReturnType<typeof openDatabase> extends Promise<infer T> ? T : never
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

    // Get unique directory paths
    const directories = new Set<string>();
    for (const sym of allSymbols) {
      const parts = sym.filePath.split('/');
      let path = '';
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        directories.add(path);
      }
    }

    const directoryStructure = Array.from(directories).sort();

    return {
      totalSymbolCount: allSymbols.length,
      domains,
      directoryStructure,
    };
  }
}
