import { Flags } from '@oclif/core';
import chalk from 'chalk';

import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import type { LlmLogOptions } from '../llm/_shared/llm-utils.js';
import { assignByFileCohortFallback } from './_shared/fallback-assignment.js';
import {
  consolidateFileCohesion,
  enforceBaseClassRule,
  runAssignmentCoverageGate,
  runAssignmentPhase,
} from './phases/assignment-phase.js';
import { runDeepenPhase } from './phases/deepen-phase.js';
import { runTreePhase } from './phases/tree-phase.js';

export default class ModulesGenerate extends BaseLlmCommand {
  static override description = 'Create module tree structure and assign symbols using LLM';

  static override examples = [
    '<%= config.bin %> modules generate',
    '<%= config.bin %> modules generate --phase tree --dry-run',
    '<%= config.bin %> modules generate --phase assign --batch-size 30',
    '<%= config.bin %> modules generate --force',
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
      default: 200,
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
      await runTreePhase({
        db,
        command: this,
        model: flags.model as string,
        dryRun,
        isJson,
        verbose,
        llmLogOptions,
        maxModules,
      });
    }

    // Phase 2: Symbol Assignment
    if (phase === 'all' || phase === 'assign') {
      await runAssignmentPhase({
        db,
        command: this,
        model: flags.model as string,
        batchSize: flags['batch-size'] as number,
        maxIterations: flags['max-iterations'] as number,
        dryRun,
        isJson,
        verbose,
        llmLogOptions,
      });

      // Coverage gate: check unassigned % and run catch-up passes if needed
      if (!dryRun) {
        await runAssignmentCoverageGate({
          db,
          command: this,
          model: flags.model as string,
          batchSize: flags['batch-size'] as number,
          maxUnassignedPct: flags['max-unassigned-pct'] as number,
          maxGateRetries: flags['max-gate-retries'] as number,
          isJson,
          llmLogOptions,
        });
      }

      // Deterministic fallback for symbols LLM couldn't assign
      if (!dryRun) {
        const remaining = db.modules.getUnassigned();
        if (remaining.length > 0) {
          const fallbackCount = assignByFileCohortFallback(db, this, isJson, verbose);
          if (fallbackCount > 0 && !isJson) {
            this.log(chalk.green(`  Deterministic fallback: assigned ${fallbackCount} remaining symbols`));
          }
        }
      }

      // Consolidate file cohesion: reassign minority symbols so same-file symbols share a module
      if (!dryRun) {
        consolidateFileCohesion({ db, command: this, isJson });
        enforceBaseClassRule({ db, command: this, isJson, verbose });
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
        await runDeepenPhase({
          db,
          command: this,
          model: flags.model as string,
          threshold: deepenThreshold,
          maxDepth: flags['max-depth'] as number,
          dryRun,
          isJson,
          verbose,
          llmLogOptions,
          maxModules,
        });

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
}
