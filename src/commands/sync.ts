import fs from 'node:fs';
import path from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IndexDatabase } from '../db/database-facade.js';
import type { DirtyLayer } from '../db/schema.js';
import { detectChanges } from '../sync/change-detector.js';
import { applySync } from '../sync/incremental-indexer.js';
import { type EnrichmentStrategy, selectStrategy } from '../sync/sync-strategy.js';
import ContractsExtract from './contracts/extract.js';
import FeaturesGenerate from './features/generate.js';
import FlowsGenerate from './flows/generate.js';
import InteractionsGenerate from './interactions/generate.js';
import ModulesGenerate from './modules/generate.js';
import RelationshipsAnnotate from './relationships/annotate.js';
import SymbolsAnnotate from './symbols/annotate.js';

export default class Sync extends Command {
  static override description = 'Incrementally sync the database with source code changes';

  static override examples = [
    '<%= config.bin %> sync ./src',
    '<%= config.bin %> sync ./src --check',
    '<%= config.bin %> sync ./src --enrich',
    '<%= config.bin %> sync ./src --enrich --strict',
    '<%= config.bin %> sync ./src -d .squint.db --verbose',
    '<%= config.bin %> sync ./src --install-hook',
  ];

  static override args = {
    directory: Args.string({
      description: 'Directory to scan for TypeScript/JavaScript files',
      required: true,
    }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Database file path (default: <directory>/.squint.db)',
    }),
    check: Flags.boolean({
      description: 'Dry-run: detect changes, report, exit 1 if out of sync',
      default: false,
    }),
    enrich: Flags.boolean({
      description: 'After AST sync, run LLM re-enrichment for new/stale items',
      default: false,
    }),
    model: Flags.string({
      char: 'm',
      description: 'LLM model for --enrich mode',
      default: 'openrouter:google/gemini-2.5-flash',
    }),
    strict: Flags.boolean({
      description: 'Exit non-zero if enrichment warnings occur (CI mode)',
      default: false,
    }),
    verbose: Flags.boolean({
      description: 'Detailed output',
      default: false,
    }),
    'install-hook': Flags.boolean({
      description: 'Install a pre-push git hook that runs squint sync',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Sync);

    const directory = path.resolve(args.directory);
    const dbPath = flags.database
      ? path.resolve(flags.database)
      : process.env.SQUINT_DB_PATH
        ? path.resolve(process.env.SQUINT_DB_PATH)
        : path.join(directory, '.squint.db');

    // Handle --install-hook
    if (flags['install-hook']) {
      await this.installHook(directory);
      return;
    }

    // Check directory exists
    try {
      const stat = fs.statSync(directory);
      if (!stat.isDirectory()) {
        this.error(chalk.red(`"${directory}" is not a directory`));
      }
    } catch {
      this.error(chalk.red(`Directory "${directory}" does not exist`));
    }

    // Check DB exists
    if (!fs.existsSync(dbPath)) {
      this.error(
        chalk.red(`Database not found at ${dbPath}\nRun 'squint parse ${args.directory}' first to create the database.`)
      );
    }

    // Open DB
    const db = new IndexDatabase(dbPath);

    // Verify the database has files (not empty)
    const fileCount = db.files.getCount();
    if (fileCount === 0) {
      db.close();
      this.error(chalk.red(`Database is empty.\nRun 'squint parse ${args.directory}' first to populate the database.`));
    }

    // Detect changes
    this.log(chalk.blue('Squint Sync'));
    this.log(chalk.white(`  Source: ${directory}`));
    this.log(chalk.white(`  Database: ${dbPath}`));
    this.log('');

    if (flags.verbose) this.log(chalk.gray('Detecting changes...'));
    const { changes, unchangedCount } = await detectChanges(directory, db);

    const newFiles = changes.filter((c) => c.status === 'new');
    const modifiedFiles = changes.filter((c) => c.status === 'modified');
    const deletedFiles = changes.filter((c) => c.status === 'deleted');

    this.log(chalk.white.bold('Changes detected:'));
    this.log(chalk.white(`  New files:      ${newFiles.length}`));
    this.log(chalk.white(`  Modified files: ${modifiedFiles.length}`));
    this.log(chalk.white(`  Deleted files:  ${deletedFiles.length}`));
    this.log(chalk.white(`  Unchanged:     ${unchangedCount}`));
    this.log('');

    // --check mode: report and exit
    if (flags.check) {
      db.close();
      if (changes.length === 0) {
        this.log(chalk.green('Database is in sync with source code.'));
        this.exit(0);
      } else {
        this.log(chalk.yellow('Database is out of sync with source code.'));
        if (flags.verbose) {
          for (const c of changes) {
            this.log(chalk.gray(`  ${c.status.toUpperCase().padEnd(10)} ${c.path}`));
          }
        }
        this.exit(1);
      }
      return;
    }

    // No changes
    if (changes.length === 0) {
      if (flags.enrich) {
        // Even with no AST changes, there may be dirty entries or unannotated
        // definitions from a prior sync that didn't include --enrich.
        const dirtyCount = db.syncDirty.countAll();
        const conn = db.getConnection();
        const unassigned = (
          conn
            .prepare(
              'SELECT COUNT(*) as cnt FROM definitions WHERE id NOT IN (SELECT definition_id FROM module_members)'
            )
            .get() as { cnt: number }
        ).cnt;
        const hasModules = (conn.prepare('SELECT COUNT(*) as cnt FROM modules').get() as { cnt: number }).cnt > 0;

        if (dirtyCount > 0 || unassigned > 0) {
          this.log(
            chalk.gray(
              `No AST changes, but ${dirtyCount} dirty entries and ${unassigned} unannotated definitions remain.`
            )
          );
          db.close();
          await this.runEnrichment(
            dbPath,
            flags.model!,
            flags.strict,
            unassigned,
            hasModules,
            'incremental',
            flags.verbose
          );
        } else {
          db.close();
          this.log(chalk.green('No changes detected. Database is up to date.'));
        }
      } else {
        db.close();
        this.log(chalk.green('No changes detected. Database is up to date.'));
      }
      return;
    }

    // Apply sync
    this.log(chalk.blue('Applying AST sync...'));
    let result: Awaited<ReturnType<typeof applySync>>;
    try {
      result = await applySync(changes, directory, db, flags.verbose, (msg: string) => this.log(chalk.gray(msg)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('SQLITE_BUSY') || message.includes('database is locked')) {
        db.close();
        this.error(chalk.red('Another squint process is writing to this database. Try again shortly.'));
      }
      throw error;
    }

    // Report
    this.log('');
    this.log(chalk.white.bold('AST sync applied:'));
    this.log(chalk.white(`  Definitions added:   ${result.definitionsAdded}`));
    this.log(chalk.white(`  Definitions updated: ${result.definitionsUpdated}`));
    this.log(chalk.white(`  Definitions removed: ${result.definitionsRemoved}`));
    this.log(chalk.white(`  Imports refreshed:   ${result.importsRefreshed} files`));
    if (result.inheritanceResult.created > 0) {
      this.log(chalk.white(`  Inheritance edges:   ${result.inheritanceResult.created} recreated`));
    }
    if (result.dependentFilesReResolved > 0) {
      this.log(chalk.white(`  Dependent files:     ${result.dependentFilesReResolved} re-resolved`));
    }
    if (result.danglingRefsCleaned > 0) {
      this.log(chalk.white(`  Dangling refs:       ${result.danglingRefsCleaned} cleaned`));
    }
    if (result.ghostRowsCleaned > 0) {
      this.log(chalk.white(`  Ghost rows:          ${result.ghostRowsCleaned} cleaned`));
    }

    this.log('');
    this.log(chalk.white.bold('LLM data status:'));
    this.log(chalk.white(`  Stale metadata:       ${result.staleMetadataCount} definitions (in modified files)`));
    this.log(chalk.white(`  Unassigned to module: ${result.unassignedCount} definitions (new)`));
    this.log(chalk.white(`  Interactions recalc:  ${result.interactionsRecalculated ? 'Yes' : 'No (no modules)'}`));

    // Report dirty set summary and enrichment strategy
    const dirtySummary = db.syncDirty.getSummary();
    const dirtyTotal = db.syncDirty.countAll();
    if (dirtyTotal > 0) {
      this.log('');
      this.log(chalk.white.bold('Dirty sets populated:'));
      for (const [layer, count] of Object.entries(dirtySummary)) {
        if (count > 0) {
          this.log(chalk.white(`  ${layer.padEnd(16)} ${count} entities`));
        }
      }
    }

    const decision = selectStrategy(db, result);
    this.log('');
    this.log(chalk.white.bold('Enrichment strategy:'));
    this.log(chalk.white(`  Strategy: ${decision.strategy}`));
    this.log(chalk.white(`  Reason:   ${decision.reason}`));
    if (flags.verbose) {
      const m = decision.metrics;
      this.log(
        chalk.gray(`  Defs: ${m.changedDefinitions}/${m.totalDefinitions} (${(m.changeRatio * 100).toFixed(1)}%)`)
      );
      this.log(chalk.gray(`  Modules: ${m.affectedModules}/${m.totalModules} (${(m.moduleRatio * 100).toFixed(1)}%)`));
      this.log(
        chalk.gray(
          `  Interactions: ${m.affectedInteractions}/${m.totalInteractions} (${(m.interactionRatio * 100).toFixed(1)}%)`
        )
      );
    }

    // Update metadata
    db.setMetadata('indexed_at', new Date().toISOString());
    db.close();

    this.log('');
    this.log(chalk.green.bold('Sync complete.'));

    // --enrich mode: run LLM enrichment
    if (flags.enrich) {
      await this.runEnrichment(
        dbPath,
        flags.model!,
        flags.strict,
        result.unassignedCount,
        result.interactionsRecalculated,
        decision.strategy,
        flags.verbose
      );
    } else if (result.staleMetadataCount > 0 || result.unassignedCount > 0) {
      this.log('');
      this.log(chalk.gray("Run 'squint sync --enrich' to update annotations, modules, and flows."));
    }
  }

  private async runEnrichment(
    dbPath: string,
    model: string,
    strict: boolean,
    unassignedCount: number,
    hasModules: boolean,
    strategy: EnrichmentStrategy = 'full',
    verbose = false
  ): Promise<void> {
    this.log('');
    this.log(chalk.blue(`Running LLM enrichment (strategy: ${strategy})...`));

    const llmFlags = ['-d', dbPath, '--model', model];
    const enrichmentWarnings: string[] = [];

    // Strategy: 'none' — drain all dirty, skip enrichment
    if (strategy === 'none') {
      this.drainAllLayers(dbPath);
      this.log(chalk.green.bold('Enrichment skipped (strategy: none).'));
      return;
    }

    // Strategy: 'full' — drain all dirty, run all commands with --force
    if (strategy === 'full') {
      this.drainAllLayers(dbPath);
      await this.runFullEnrichment(llmFlags, enrichmentWarnings, unassignedCount, hasModules);
      this.finishEnrichment(strict, enrichmentWarnings);
      return;
    }

    // Strategy: 'incremental' — run the incremental pipeline with layer skipping
    const db = new IndexDatabase(dbPath);
    try {
      // Clean stale annotations for modified definitions
      this.cleanStaleAnnotations(db, verbose);

      // Step 1: Annotate symbols (picks up stale + new as unannotated)
      try {
        this.log(chalk.gray('  Annotating symbols...'));
        await SymbolsAnnotate.run(['--aspect', 'purpose', '--aspect', 'domain', '--aspect', 'pure', ...llmFlags]);
        db.syncDirty.drain('metadata');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const warning = `Symbol annotation warning: ${msg}`;
        this.warn(chalk.yellow(`  ${warning}`));
        enrichmentWarnings.push(warning);
      }

      // Step 2: Annotate relationships
      try {
        this.log(chalk.gray('  Annotating relationships...'));
        await RelationshipsAnnotate.run(llmFlags);
        db.syncDirty.drain('relationships');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const warning = `Relationship annotation warning: ${msg}`;
        this.warn(chalk.yellow(`  ${warning}`));
        enrichmentWarnings.push(warning);
      }

      // Step 3: Assign new definitions to modules
      if (this.shouldRunLayer(db, 'modules', verbose) && unassignedCount > 0 && hasModules) {
        try {
          this.log(chalk.gray('  Assigning new definitions to modules...'));
          await ModulesGenerate.run(['--incremental', '--phase', 'assign', '--deepen-threshold', '0', ...llmFlags]);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const warning = `Module assignment warning: ${msg}`;
          this.warn(chalk.yellow(`  ${warning}`));
          enrichmentWarnings.push(warning);
        }
      }

      // Step 4: Extract contracts
      if (this.shouldRunLayer(db, 'contracts', verbose) && hasModules) {
        try {
          this.log(chalk.gray('  Extracting contracts...'));
          await ContractsExtract.run(['--force', ...llmFlags]);
          db.syncDirty.drain('contracts');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const warning = `Contract extraction warning: ${msg}`;
          this.warn(chalk.yellow(`  ${warning}`));
          enrichmentWarnings.push(warning);
        }
      }

      // Step 5: Generate interactions (scoped to dirty modules)
      // Note: reads 'modules' dirty set, so modules must NOT be drained yet
      if (this.shouldRunLayer(db, 'interactions', verbose)) {
        try {
          this.log(chalk.gray('  Generating interactions (incremental)...'));
          await InteractionsGenerate.run(['--incremental', ...llmFlags]);
          db.syncDirty.drain('interactions');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const warning = `Interaction generation warning: ${msg}`;
          this.warn(chalk.yellow(`  ${warning}`));
          enrichmentWarnings.push(warning);
        }
      }

      // Drain modules AFTER interactions (interactions reads the modules dirty set)
      db.syncDirty.drain('modules');

      // Step 6: Regenerate flows (skip if no dirty flows)
      if (this.shouldRunLayer(db, 'flows', verbose) && hasModules) {
        try {
          this.log(chalk.gray('  Regenerating flows (incremental)...'));
          await FlowsGenerate.run(['--incremental', ...llmFlags]);
          db.syncDirty.drain('flows');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const warning = `Flow generation warning: ${msg}`;
          this.warn(chalk.yellow(`  ${warning}`));
          enrichmentWarnings.push(warning);
        }
      }

      // Step 7: Regenerate features (always full — cheap, 1-2 LLM calls)
      if (hasModules) {
        try {
          this.log(chalk.gray('  Regenerating features...'));
          await FeaturesGenerate.run(['--force', ...llmFlags]);
          db.syncDirty.drain('features');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const warning = `Feature generation warning: ${msg}`;
          this.warn(chalk.yellow(`  ${warning}`));
          enrichmentWarnings.push(warning);
        }
      }
    } finally {
      db.close();
    }

    this.finishEnrichment(strict, enrichmentWarnings);
  }

  /**
   * Run all enrichment commands with --force (full rebuild).
   */
  private async runFullEnrichment(
    llmFlags: string[],
    enrichmentWarnings: string[],
    unassignedCount: number,
    hasModules: boolean
  ): Promise<void> {
    // Step 1: Annotate symbols
    try {
      this.log(chalk.gray('  Annotating symbols...'));
      await SymbolsAnnotate.run(['--aspect', 'purpose', '--aspect', 'domain', '--aspect', 'pure', ...llmFlags]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const warning = `Symbol annotation warning: ${msg}`;
      this.warn(chalk.yellow(`  ${warning}`));
      enrichmentWarnings.push(warning);
    }

    // Step 2: Annotate relationships
    try {
      this.log(chalk.gray('  Annotating relationships...'));
      await RelationshipsAnnotate.run(llmFlags);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const warning = `Relationship annotation warning: ${msg}`;
      this.warn(chalk.yellow(`  ${warning}`));
      enrichmentWarnings.push(warning);
    }

    // Step 3: Assign new definitions to existing modules
    if (unassignedCount > 0 && hasModules) {
      try {
        this.log(chalk.gray('  Assigning new definitions to modules...'));
        await ModulesGenerate.run(['--incremental', '--phase', 'assign', '--deepen-threshold', '0', ...llmFlags]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const warning = `Module assignment warning: ${msg}`;
        this.warn(chalk.yellow(`  ${warning}`));
        enrichmentWarnings.push(warning);
      }
    }

    // Step 4: Extract contracts (if modules exist)
    if (hasModules) {
      try {
        this.log(chalk.gray('  Extracting contracts...'));
        await ContractsExtract.run(['--force', ...llmFlags]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const warning = `Contract extraction warning: ${msg}`;
        this.warn(chalk.yellow(`  ${warning}`));
        enrichmentWarnings.push(warning);
      }
    }

    // Step 5: Generate interactions
    try {
      this.log(chalk.gray('  Generating interactions...'));
      await InteractionsGenerate.run(['--force', ...llmFlags]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const warning = `Interaction generation warning: ${msg}`;
      this.warn(chalk.yellow(`  ${warning}`));
      enrichmentWarnings.push(warning);
    }

    // Step 6: Regenerate flows (if modules exist)
    if (hasModules) {
      try {
        this.log(chalk.gray('  Regenerating flows...'));
        await FlowsGenerate.run(['--force', ...llmFlags]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const warning = `Flow generation warning: ${msg}`;
        this.warn(chalk.yellow(`  ${warning}`));
        enrichmentWarnings.push(warning);
      }

      // Step 7: Regenerate features
      try {
        this.log(chalk.gray('  Regenerating features...'));
        await FeaturesGenerate.run(['--force', ...llmFlags]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const warning = `Feature generation warning: ${msg}`;
        this.warn(chalk.yellow(`  ${warning}`));
        enrichmentWarnings.push(warning);
      }
    }
  }

  /**
   * Delete purpose/domain/pure metadata and relationship annotations
   * for definitions that were modified (not just added).
   * This makes them "unannotated" again so existing annotate commands pick them up.
   */
  private cleanStaleAnnotations(db: IndexDatabase, verbose: boolean): void {
    const dirtyEntries = db.syncDirty.getDirty('metadata');
    const modifiedDefIds = dirtyEntries.filter((e) => e.reason === 'modified').map((e) => e.entityId);

    if (modifiedDefIds.length === 0) return;

    const metaRemoved = db.metadata.removeForDefinitions(modifiedDefIds, ['purpose', 'domain', 'pure']);
    const relRemoved = db.relationships.deleteAnnotationsForDefinitions(modifiedDefIds);

    if (verbose) {
      this.log(
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
   * Returns false and logs skip message if no dirty entries.
   */
  private shouldRunLayer(db: IndexDatabase, layer: DirtyLayer, verbose: boolean): boolean {
    const count = db.syncDirty.count(layer);
    if (count === 0) {
      if (verbose) {
        this.log(chalk.gray(`  ${layer} (skipped — no dirty entries)`));
      }
      return false;
    }
    return true;
  }

  /**
   * Finish enrichment: log completion, check strict mode warnings.
   */
  private finishEnrichment(strict: boolean, enrichmentWarnings: string[]): void {
    this.log(chalk.green.bold('Enrichment complete.'));

    if (strict && enrichmentWarnings.length > 0) {
      this.log('');
      this.log(chalk.yellow(`${enrichmentWarnings.length} enrichment warning(s) in --strict mode:`));
      for (const w of enrichmentWarnings) {
        this.log(chalk.yellow(`  - ${w}`));
      }
      this.exit(2);
    }
  }

  private async installHook(directory: string): Promise<void> {
    // Find .git directory
    let gitDir = directory;
    while (gitDir !== path.dirname(gitDir)) {
      if (fs.existsSync(path.join(gitDir, '.git'))) break;
      gitDir = path.dirname(gitDir);
    }

    const hookDir = path.join(gitDir, '.git', 'hooks');
    if (!fs.existsSync(hookDir)) {
      this.error(chalk.red(`No .git/hooks directory found. Is ${directory} inside a git repository?`));
    }

    const hookPath = path.join(hookDir, 'pre-push');
    const hookContent = `#!/bin/sh
# squint sync pre-push hook
squint sync ${directory} -d ${path.join(directory, '.squint.db')}
if [ $? -ne 0 ]; then
  echo "squint sync failed. Fix issues before pushing."
  exit 1
fi
`;

    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
    this.log(chalk.green(`Pre-push hook installed at ${hookPath}`));
  }
}
