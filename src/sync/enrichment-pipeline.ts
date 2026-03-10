import chalk from 'chalk';
import ContractsExtract from '../commands/contracts/extract.js';
import FeaturesGenerate from '../commands/features/generate.js';
import FlowsGenerate from '../commands/flows/generate.js';
import InteractionsGenerate from '../commands/interactions/generate.js';
import ModulesGenerate from '../commands/modules/generate.js';
import RelationshipsAnnotate from '../commands/relationships/annotate.js';
import SymbolsAnnotate from '../commands/symbols/annotate.js';
import { IndexDatabase } from '../db/database-facade.js';
import type { DirtyLayer } from '../db/schema.js';

export type EnrichmentMode = 'none' | 'incremental' | 'full';

export interface EnrichmentContext {
  dbPath: string;
  model: string;
  unassignedCount: number;
  hasModules: boolean;
  verbose: boolean;
}

export interface EnrichmentStep {
  name: string;
  layer?: DirtyLayer;
  skip?: (ctx: EnrichmentContext, db: IndexDatabase) => boolean;
  run: (ctx: EnrichmentContext, llmFlags: string[], db: IndexDatabase) => Promise<void>;
}

/**
 * Unified enrichment pipeline for incremental and full enrichment.
 * Eliminates duplicate try/catch blocks by defining steps as data.
 */
export class EnrichmentPipeline {
  private warnings: string[] = [];

  constructor(private logger: (msg: string) => void) {}

  /**
   * Run enrichment based on mode.
   */
  async run(mode: EnrichmentMode, ctx: EnrichmentContext): Promise<void> {
    this.logger(chalk.blue(`Running LLM enrichment (strategy: ${mode})...`));

    // Strategy: 'none' — drain all dirty, skip enrichment
    if (mode === 'none') {
      this.drainAllLayers(ctx.dbPath);
      this.logger(chalk.green.bold('Enrichment skipped (strategy: none).'));
      return;
    }

    // Strategy: 'full' — drain all dirty, run all commands with --force
    if (mode === 'full') {
      this.drainAllLayers(ctx.dbPath);
      await this.runFullEnrichment(ctx);
      this.finish();
      return;
    }

    // Strategy: 'incremental' — run the incremental pipeline with layer skipping
    await this.runIncrementalEnrichment(ctx);
    this.finish();
  }

  /**
   * Run incremental enrichment with layer-by-layer dirty checking.
   */
  private async runIncrementalEnrichment(ctx: EnrichmentContext): Promise<void> {
    const db = new IndexDatabase(ctx.dbPath);
    try {
      // Clean stale annotations for modified definitions
      this.cleanStaleAnnotations(db, ctx.verbose);

      const steps = this.buildIncrementalSteps();
      const llmFlags = ['-d', ctx.dbPath, '--model', ctx.model];

      for (const step of steps) {
        if (step.skip?.(ctx, db)) {
          if (ctx.verbose && step.layer) {
            this.logger(chalk.gray(`  ${step.layer} (skipped — no dirty entries)`));
          }
          continue;
        }

        await this.executeStep(step, ctx, llmFlags, db);
      }

      // Drain modules AFTER interactions (interactions reads the modules dirty set)
      db.syncDirty.drain('modules');
    } finally {
      db.close();
    }
  }

  /**
   * Run full enrichment with --force on all commands.
   */
  private async runFullEnrichment(ctx: EnrichmentContext): Promise<void> {
    const steps = this.buildFullSteps();
    const llmFlags = ['-d', ctx.dbPath, '--model', ctx.model];
    const db = new IndexDatabase(ctx.dbPath);

    try {
      for (const step of steps) {
        if (step.skip?.(ctx, db)) {
          continue;
        }

        await this.executeStep(step, ctx, llmFlags, db);
      }
    } finally {
      db.close();
    }
  }

  /**
   * Execute a single enrichment step with error handling.
   */
  private async executeStep(
    step: EnrichmentStep,
    ctx: EnrichmentContext,
    llmFlags: string[],
    db: IndexDatabase
  ): Promise<void> {
    try {
      this.logger(chalk.gray(`  ${step.name}...`));
      await step.run(ctx, llmFlags, db);
      if (step.layer) {
        db.syncDirty.drain(step.layer);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const warning = `${step.name} warning: ${msg}`;
      this.logger(chalk.yellow(`  ${warning}`));
      this.warnings.push(warning);
    }
  }

  /**
   * Build incremental enrichment steps.
   */
  private buildIncrementalSteps(): EnrichmentStep[] {
    return [
      {
        name: 'Annotating symbols',
        layer: 'metadata',
        run: async (_ctx, llmFlags) => {
          await SymbolsAnnotate.run(['--aspect', 'purpose', '--aspect', 'domain', '--aspect', 'pure', ...llmFlags]);
        },
      },
      {
        name: 'Annotating relationships',
        layer: 'relationships',
        run: async (_ctx, llmFlags) => {
          await RelationshipsAnnotate.run(llmFlags);
        },
      },
      {
        name: 'Assigning new definitions to modules',
        skip: (ctx, db) =>
          !this.shouldRunLayer(db, 'modules', ctx.verbose) || ctx.unassignedCount === 0 || !ctx.hasModules,
        run: async (_ctx, llmFlags) => {
          await ModulesGenerate.run(['--incremental', '--phase', 'assign', '--deepen-threshold', '0', ...llmFlags]);
        },
      },
      {
        name: 'Extracting contracts',
        layer: 'contracts',
        skip: (ctx, db) => !this.shouldRunLayer(db, 'contracts', ctx.verbose) || !ctx.hasModules,
        run: async (_ctx, llmFlags) => {
          await ContractsExtract.run(['--force', ...llmFlags]);
        },
      },
      {
        name: 'Generating interactions (incremental)',
        layer: 'interactions',
        skip: (ctx, db) => !this.shouldRunLayer(db, 'interactions', ctx.verbose),
        run: async (_ctx, llmFlags) => {
          await InteractionsGenerate.run(['--incremental', ...llmFlags]);
        },
      },
      {
        name: 'Regenerating flows (incremental)',
        layer: 'flows',
        skip: (ctx, db) => !this.shouldRunLayer(db, 'flows', ctx.verbose) || !ctx.hasModules,
        run: async (_ctx, llmFlags) => {
          await FlowsGenerate.run(['--incremental', ...llmFlags]);
        },
      },
      {
        name: 'Regenerating features',
        layer: 'features',
        skip: (ctx) => !ctx.hasModules,
        run: async (_ctx, llmFlags) => {
          await FeaturesGenerate.run(['--force', ...llmFlags]);
        },
      },
    ];
  }

  /**
   * Build full enrichment steps.
   */
  private buildFullSteps(): EnrichmentStep[] {
    return [
      {
        name: 'Annotating symbols',
        run: async (_ctx, llmFlags) => {
          await SymbolsAnnotate.run(['--aspect', 'purpose', '--aspect', 'domain', '--aspect', 'pure', ...llmFlags]);
        },
      },
      {
        name: 'Annotating relationships',
        run: async (_ctx, llmFlags) => {
          await RelationshipsAnnotate.run(llmFlags);
        },
      },
      {
        name: 'Assigning new definitions to modules',
        skip: (ctx) => ctx.unassignedCount === 0 || !ctx.hasModules,
        run: async (_ctx, llmFlags) => {
          await ModulesGenerate.run(['--incremental', '--phase', 'assign', '--deepen-threshold', '0', ...llmFlags]);
        },
      },
      {
        name: 'Extracting contracts',
        skip: (ctx) => !ctx.hasModules,
        run: async (_ctx, llmFlags) => {
          await ContractsExtract.run(['--force', ...llmFlags]);
        },
      },
      {
        name: 'Generating interactions',
        run: async (_ctx, llmFlags) => {
          await InteractionsGenerate.run(['--force', ...llmFlags]);
        },
      },
      {
        name: 'Regenerating flows',
        skip: (ctx) => !ctx.hasModules,
        run: async (_ctx, llmFlags) => {
          await FlowsGenerate.run(['--force', ...llmFlags]);
        },
      },
      {
        name: 'Regenerating features',
        skip: (ctx) => !ctx.hasModules,
        run: async (_ctx, llmFlags) => {
          await FeaturesGenerate.run(['--force', ...llmFlags]);
        },
      },
    ];
  }

  /**
   * Delete purpose/domain/pure metadata and relationship annotations
   * for definitions that were modified (not just added).
   */
  private cleanStaleAnnotations(db: IndexDatabase, verbose: boolean): void {
    const dirtyEntries = db.syncDirty.getDirty('metadata');
    const modifiedDefIds = dirtyEntries.filter((e) => e.reason === 'modified').map((e) => e.entityId);

    if (modifiedDefIds.length === 0) return;

    const metaRemoved = db.metadata.removeForDefinitions(modifiedDefIds, ['purpose', 'domain', 'pure']);
    const relRemoved = db.relationships.deleteAnnotationsForDefinitions(modifiedDefIds);

    if (verbose) {
      this.logger(
        chalk.gray(
          `  Cleaned stale annotations: ${metaRemoved} metadata, ${relRemoved} relationships for ${modifiedDefIds.length} modified definitions`
        )
      );
    }
  }

  /**
   * Drain all dirty entries across all layers.
   */
  private drainAllLayers(dbPath: string): void {
    const db = new IndexDatabase(dbPath);
    try {
      db.syncDirty.clear();
    } finally {
      db.close();
    }
  }

  /**
   * Check if a layer has dirty entries and should be processed.
   */
  private shouldRunLayer(db: IndexDatabase, layer: DirtyLayer, _verbose: boolean): boolean {
    const count = db.syncDirty.count(layer);
    return count > 0;
  }

  /**
   * Finish enrichment: log completion and return warnings.
   */
  private finish(): void {
    this.logger(chalk.green.bold('Enrichment complete.'));
  }

  /**
   * Get collected warnings.
   */
  getWarnings(): string[] {
    return [...this.warnings];
  }
}
