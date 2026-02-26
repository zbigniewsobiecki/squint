import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { getErrorMessage } from '../llm/_shared/llm-utils.js';
import { type ProcessGroups, computeProcessGroups, getProcessGroupLabel } from '../llm/_shared/process-utils.js';
import { type InteractionSuggestion, createDefaultInteraction, generateAstSemantics } from './_shared/ast-semantics.js';
import { ContractMatcher } from './_shared/contract-matcher.js';
import { runCoverageInference } from './_shared/coverage-inferrer.js';
import { inferCrossProcessInteractions } from './_shared/cross-process-inferrer.js';

export default class InteractionsGenerate extends BaseLlmCommand {
  static override description = 'Detect module interactions from call graph and generate semantics using LLM';

  static override examples = [
    '<%= config.bin %> interactions generate',
    '<%= config.bin %> interactions generate --dry-run',
    '<%= config.bin %> interactions generate --force',
    '<%= config.bin %> interactions generate -d index.db --verbose',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    incremental: Flags.boolean({
      description: 'Only process dirty modules (from sync dirty tracking)',
      default: false,
    }),
    'batch-size': Flags.integer({
      description: 'Module edges per LLM batch for semantic generation',
      default: 10,
    }),
    'min-relationship-coverage': Flags.integer({
      description: 'Minimum % of cross-module relationships covered by interactions',
      default: 90,
    }),
    'max-gate-retries': Flags.integer({
      description: 'Maximum retry attempts when coverage gate fails',
      default: 2,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, verbose, model } = ctx;
    const batchSize = flags['batch-size'] as number;
    const isIncremental = flags.incremental as boolean;

    // Incremental mode: scope to dirty modules only
    if (isIncremental) {
      await this.executeIncremental(ctx, flags);
      return;
    }

    // Check if interactions already exist
    const existingCount = db.interactions.getCount();
    if (
      !this.checkExistingAndClear(ctx, {
        entityName: 'Interactions',
        existingCount,
        force: flags.force as boolean,
        clearFn: () => db.interactions.clear(),
        forceHint: 'Use --force to re-detect',
      })
    ) {
      return;
    }

    this.logHeader(ctx, 'Interaction Detection');

    // Get enriched module call graph
    const enrichedEdges = db.callGraph.getEnrichedModuleCallGraph();

    if (enrichedEdges.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ error: 'No module call graph edges found', hint: 'Run llm modules first' }));
      } else {
        this.log(chalk.yellow('No module call graph edges found.'));
        this.log(chalk.gray('Ensure modules are assigned first with `squint llm modules`'));
      }
      return;
    }

    // Count utility vs business edges
    const utilityCount = enrichedEdges.filter((e) => e.edgePattern === 'utility').length;
    const businessCount = enrichedEdges.filter((e) => e.edgePattern === 'business').length;

    if (!isJson && verbose) {
      this.log(chalk.gray(`Found ${enrichedEdges.length} module-to-module edges`));
      this.log(chalk.gray(`  Business logic: ${businessCount}, Utility: ${utilityCount}`));
    }

    // Step 1: Generate semantics for each edge using LLM (in batches)
    const interactions: InteractionSuggestion[] = [];

    for (let i = 0; i < enrichedEdges.length; i += batchSize) {
      const batch = enrichedEdges.slice(i, i + batchSize);

      try {
        const batchIdx = Math.floor(i / batchSize);
        const totalBatches = Math.ceil(enrichedEdges.length / batchSize);
        const suggestions = await generateAstSemantics(batch, model, db, this, isJson, batchIdx + 1, totalBatches);
        interactions.push(...suggestions);

        if (!isJson && verbose) {
          this.log(
            chalk.gray(`  Batch ${Math.floor(i / batchSize) + 1}: Generated ${suggestions.length} interactions`)
          );
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (!isJson) {
          this.log(chalk.yellow(`  Batch ${Math.floor(i / batchSize) + 1} failed: ${message}`));
        }
        for (const edge of batch) {
          interactions.push(createDefaultInteraction(edge));
        }
      }
    }

    // Tag test-internal interactions: if either module is a test module, override pattern
    const testModuleIds = db.modules.getTestModuleIds();
    if (testModuleIds.size > 0) {
      for (const interaction of interactions) {
        if (testModuleIds.has(interaction.fromModuleId) || testModuleIds.has(interaction.toModuleId)) {
          interaction.pattern = 'test-internal';
        }
      }

      const testInternalCount = interactions.filter((i) => i.pattern === 'test-internal').length;
      if (!isJson && verbose && testInternalCount > 0) {
        this.log(chalk.gray(`  Tagged ${testInternalCount} interactions as test-internal`));
      }
    }

    // Persist interactions
    if (!dryRun) {
      for (const interaction of interactions) {
        try {
          db.interactions.upsert(interaction.fromModuleId, interaction.toModuleId, {
            weight: interaction.weight,
            pattern: interaction.pattern,
            symbols: interaction.symbols,
            semantic: interaction.semantic,
          });
        } catch {
          if (verbose && !isJson) {
            this.log(chalk.yellow(`  Skipping duplicate: ${interaction.fromModulePath} → ${interaction.toModulePath}`));
          }
        }
      }

      // Create inheritance-based interactions (extends/implements)
      const inheritanceResult = db.interactionAnalysis.syncInheritanceInteractions();
      if (!isJson && verbose && inheritanceResult.created > 0) {
        this.log(chalk.gray(`  Inheritance edges: ${inheritanceResult.created}`));
      }
    }

    // Step 2: Import-based interactions (deterministic — no LLM)
    const { importBasedCount } = !dryRun
      ? this.createImportBasedInteractions(ctx, testModuleIds)
      : { importBasedCount: 0 };

    // Compute process groups for Steps 2.5, 3, and 4
    const processGroups = computeProcessGroups(db);

    // Step 2.5: Contract-Based Matching (Deterministic)
    const { contractMatchedCount, contractLinkedCount } = !dryRun
      ? this.createContractInteractions(ctx, processGroups)
      : { contractMatchedCount: 0, contractLinkedCount: 0 };

    // Step 3: Infer cross-process (non-AST) interactions
    if (!isJson) {
      this.log('');
      this.log(chalk.bold('Step 3: Inferring Cross-Process Connections (LLM Analysis)'));
      if (verbose) {
        this.log(chalk.gray(`  Detected ${processGroups.groupCount} process group(s)`));
        for (const [, mods] of processGroups.groupToModules) {
          const label = getProcessGroupLabel(mods);
          this.log(chalk.gray(`    Group "${label}": ${mods.length} modules`));
        }
      }
    }

    const existingEdges = db.callGraph.getModuleCallGraph();
    const logicalInteractions = await inferCrossProcessInteractions(
      db,
      processGroups,
      existingEdges,
      model,
      this,
      isJson,
      ctx.llmOptions
    );

    // Persistence for cross-process interactions lives here (not inside inferCrossProcessInteractions)
    // because the post-hoc fan-in anomaly detection below must run across ALL inferred interactions,
    // not just cross-process ones. Step 4 (runCoverageInference) encapsulates its own persistence
    // because its results feed only into its own coverage loop.
    let inferredCount = 0;
    if (!dryRun && logicalInteractions.length > 0) {
      for (const li of logicalInteractions) {
        try {
          const toModuleWithMembers = db.modules.getWithMembers(li.toModuleId);
          const symbols = toModuleWithMembers
            ? toModuleWithMembers.members
                .filter((m) => m.kind === 'function' || m.kind === 'class')
                .slice(0, 10)
                .map((m) => m.name)
            : [];

          db.interactions.upsert(li.fromModuleId, li.toModuleId, {
            semantic: li.reason,
            source: 'llm-inferred',
            pattern: 'business',
            symbols: symbols.length > 0 ? symbols : undefined,
            weight: 1,
            confidence: li.confidence,
          });
          inferredCount++;
        } catch {
          if (verbose && !isJson) {
            const modules = db.modules.getAll();
            const fromMod = modules.find((m) => m.id === li.fromModuleId);
            const toMod = modules.find((m) => m.id === li.toModuleId);
            this.log(chalk.gray(`  Skipping: ${fromMod?.fullPath} → ${toMod?.fullPath} (exists)`));
          }
        }
      }

      if (!isJson) {
        this.log(chalk.green(`  Added ${inferredCount} inferred interactions`));
      }

      // Post-hoc fan-in anomaly detection
      const anomalies = db.interactionAnalysis.detectFanInAnomalies();
      if (anomalies.length > 0) {
        let totalRemoved = 0;
        for (const anomaly of anomalies) {
          const removed = db.interactions.removeInferredToModule(anomaly.moduleId);
          totalRemoved += removed;
          if (!isJson && verbose) {
            this.log(
              chalk.yellow(
                `  Fan-in anomaly: removed ${removed} inferred interactions targeting ${anomaly.modulePath} (llm-fan-in: ${anomaly.llmFanIn}, ast-fan-in: ${anomaly.astFanIn})`
              )
            );
          }
        }
        if (!isJson && totalRemoved > 0) {
          this.log(
            chalk.yellow(
              `  Fan-in cleanup: removed ${totalRemoved} hallucinated interactions from ${anomalies.length} anomalous target(s)`
            )
          );
        }
      }
    } else if (!isJson) {
      if (logicalInteractions.length === 0) {
        this.log(chalk.gray('  No additional logical connections detected'));
      } else {
        this.log(chalk.gray(`  Would add ${logicalInteractions.length} inferred interactions (dry run)`));
      }
    }

    // Step 4: Coverage validation - targeted inference for uncovered module pairs
    if (!dryRun) {
      await runCoverageInference(db, processGroups, model, this, isJson, verbose, ctx.llmOptions, {
        minRelCoverage: flags['min-relationship-coverage'] as number,
        maxGateRetries: flags['max-gate-retries'] as number,
      });
    }

    // Output results
    this.reportResults(ctx, {
      totalEdges: enrichedEdges.length,
      interactions: interactions.length,
      importBasedCount,
      contractMatchedCount,
      contractLinkedCount,
      inferredCount,
      businessCount,
      utilityCount,
    });
  }

  /**
   * Incremental mode: only process dirty modules.
   * Skips cross-process inference and coverage validation.
   */
  private async executeIncremental(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, verbose, model } = ctx;
    const batchSize = flags['batch-size'] as number;

    // Read dirty module IDs
    const dirtyModuleIds = db.syncDirty.getDirtyIds('modules');
    if (dirtyModuleIds.length === 0) {
      if (!isJson) {
        this.log(chalk.gray('No dirty modules — skipping incremental interaction generation.'));
      }
      return;
    }

    this.logHeader(ctx, 'Interaction Detection (Incremental)');

    const dirtyModuleSet = new Set(dirtyModuleIds);

    if (!isJson && verbose) {
      this.log(chalk.gray(`Dirty modules: ${dirtyModuleIds.length}`));
    }

    // Delete interactions where BOTH endpoints are dirty (full re-evaluation)
    if (!dryRun) {
      const deleted = db.interactions.deleteForModulePairsBothDirty(dirtyModuleIds);
      if (!isJson && verbose && deleted > 0) {
        this.log(chalk.gray(`  Deleted ${deleted} interactions between dirty module pairs`));
      }
    }

    // Get enriched call graph scoped to dirty modules
    const enrichedEdges = db.callGraph.getEnrichedModuleCallGraph(dirtyModuleSet);

    if (enrichedEdges.length === 0) {
      if (!isJson) {
        this.log(chalk.gray('No call graph edges for dirty modules.'));
      }
      return;
    }

    const utilityCount = enrichedEdges.filter((e) => e.edgePattern === 'utility').length;
    const businessCount = enrichedEdges.filter((e) => e.edgePattern === 'business').length;

    if (!isJson && verbose) {
      this.log(chalk.gray(`Found ${enrichedEdges.length} module-to-module edges touching dirty modules`));
      this.log(chalk.gray(`  Business logic: ${businessCount}, Utility: ${utilityCount}`));
    }

    // Generate semantics via LLM (in batches)
    const interactions: InteractionSuggestion[] = [];

    for (let i = 0; i < enrichedEdges.length; i += batchSize) {
      const batch = enrichedEdges.slice(i, i + batchSize);
      try {
        const batchIdx = Math.floor(i / batchSize);
        const totalBatches = Math.ceil(enrichedEdges.length / batchSize);
        const suggestions = await generateAstSemantics(batch, model, db, this, isJson, batchIdx + 1, totalBatches);
        interactions.push(...suggestions);
      } catch (error) {
        const message = getErrorMessage(error);
        if (!isJson) {
          this.log(chalk.yellow(`  Batch ${Math.floor(i / batchSize) + 1} failed: ${message}`));
        }
        for (const edge of batch) {
          interactions.push(createDefaultInteraction(edge));
        }
      }
    }

    // Tag test-internal interactions
    const testModuleIds = db.modules.getTestModuleIds();
    if (testModuleIds.size > 0) {
      for (const interaction of interactions) {
        if (testModuleIds.has(interaction.fromModuleId) || testModuleIds.has(interaction.toModuleId)) {
          interaction.pattern = 'test-internal';
        }
      }
    }

    // Persist via upsert (preserves IDs for clean-endpoint interactions)
    if (!dryRun) {
      for (const interaction of interactions) {
        try {
          db.interactions.upsert(interaction.fromModuleId, interaction.toModuleId, {
            weight: interaction.weight,
            pattern: interaction.pattern,
            symbols: interaction.symbols,
            semantic: interaction.semantic,
          });
        } catch {
          if (verbose && !isJson) {
            this.log(chalk.yellow(`  Skipping duplicate: ${interaction.fromModulePath} → ${interaction.toModulePath}`));
          }
        }
      }

      // Sync inheritance-based interactions
      const inheritanceResult = db.interactionAnalysis.syncInheritanceInteractions();
      if (!isJson && verbose && inheritanceResult.created > 0) {
        this.log(chalk.gray(`  Inheritance edges: ${inheritanceResult.created}`));
      }
    }

    // Import-based interactions scoped to dirty modules
    const { importBasedCount } = !dryRun
      ? this.createImportBasedInteractionsScoped(ctx, testModuleIds, dirtyModuleSet)
      : { importBasedCount: 0 };

    // Contract matching scoped to dirty modules
    let contractMatchedCount = 0;
    let contractLinkedCount = 0;
    if (!dryRun && db.contracts.getCount() > 0) {
      const processGroups = computeProcessGroups(db);
      const result = this.createContractInteractionsScoped(ctx, processGroups, dirtyModuleSet);
      contractMatchedCount = result.contractMatchedCount;
      contractLinkedCount = result.contractLinkedCount;
    }

    // Skip cross-process inference + coverage validation in incremental mode

    // Output results
    this.reportResults(ctx, {
      totalEdges: enrichedEdges.length,
      interactions: interactions.length,
      importBasedCount,
      contractMatchedCount,
      contractLinkedCount,
      inferredCount: 0,
      businessCount,
      utilityCount,
    });
  }

  /**
   * Import-based interactions scoped to dirty modules.
   */
  private createImportBasedInteractionsScoped(
    ctx: LlmContext,
    testModuleIds: Set<number>,
    dirtyModuleIds: Set<number>
  ): { importBasedCount: number; fileLevelCount: number } {
    const { db, isJson, verbose } = ctx;

    let importBasedCount = 0;
    const importPairs = db.interactions
      .getImportOnlyModulePairs()
      .filter((p) => dirtyModuleIds.has(p.fromModuleId) || dirtyModuleIds.has(p.toModuleId));

    if (importPairs.length > 0) {
      if (!isJson && verbose) {
        this.log(chalk.gray(`  Processing ${importPairs.length} import-based pairs touching dirty modules`));
      }

      for (const pair of importPairs) {
        if (this.upsertImportInteraction(db, pair, testModuleIds)) {
          importBasedCount++;
        }
      }

      if (!isJson && verbose) {
        this.log(chalk.green(`  Added/updated ${importBasedCount} import-based interactions`));
      }
    }

    // File-level import fallback (scoped to dirty modules)
    let fileLevelCount = 0;
    const fileLevelPairs = db.interactions
      .getFileLevelImportModulePairs()
      .filter((p) => dirtyModuleIds.has(p.fromModuleId) || dirtyModuleIds.has(p.toModuleId));

    if (fileLevelPairs.length > 0) {
      for (const pair of fileLevelPairs) {
        const pattern =
          testModuleIds.has(pair.fromModuleId) || testModuleIds.has(pair.toModuleId) ? 'test-internal' : 'business';
        try {
          db.interactions.upsert(pair.fromModuleId, pair.toModuleId, {
            weight: pair.importCount,
            pattern,
            semantic: pair.isTypeOnly ? 'Type dependency (file-level import)' : 'File-level import dependency',
            source: 'ast-import',
          });
          fileLevelCount++;
        } catch {
          // Skip if already exists
        }
      }

      if (!isJson && verbose && fileLevelCount > 0) {
        this.log(chalk.green(`  Added ${fileLevelCount} file-level import interactions (scoped)`));
      }
    }

    return { importBasedCount, fileLevelCount };
  }

  /**
   * Contract matching scoped to dirty modules.
   */
  private createContractInteractionsScoped(
    ctx: LlmContext,
    processGroups: ProcessGroups,
    dirtyModuleIds: Set<number>
  ): { contractMatchedCount: number; contractLinkedCount: number } {
    const { db, isJson, verbose } = ctx;

    db.contracts.backfillModuleIds();
    const matcher = new ContractMatcher();
    const allMatches = matcher.match(db, processGroups);

    // Filter to matches touching dirty modules
    const scopedMatches = allMatches.filter(
      (m) => dirtyModuleIds.has(m.fromModuleId) || dirtyModuleIds.has(m.toModuleId)
    );

    if (scopedMatches.length === 0) {
      return { contractMatchedCount: 0, contractLinkedCount: 0 };
    }

    const result = matcher.materializeInteractions(db, scopedMatches);

    if (!isJson && verbose) {
      this.log(
        chalk.gray(
          `  Contract-matched: ${result.created} interactions (${result.linked} definition links) [scoped to dirty modules]`
        )
      );
    }

    return { contractMatchedCount: result.created, contractLinkedCount: result.linked };
  }

  /**
   * Upsert a single symbol-level import interaction. Returns true if persisted.
   */
  private upsertImportInteraction(
    db: LlmContext['db'],
    pair: { fromModuleId: number; toModuleId: number; symbols: string[]; weight: number; isTypeOnly: boolean },
    testModuleIds: Set<number>
  ): boolean {
    const pattern =
      testModuleIds.has(pair.fromModuleId) || testModuleIds.has(pair.toModuleId) ? 'test-internal' : 'business';
    try {
      db.interactions.upsert(pair.fromModuleId, pair.toModuleId, {
        weight: pair.weight,
        pattern,
        symbols: pair.symbols.length > 0 ? pair.symbols.slice(0, 20) : undefined,
        semantic: pair.isTypeOnly
          ? `Type/interface dependency (${pair.symbols.slice(0, 3).join(', ')}${pair.symbols.length > 3 ? '...' : ''})`
          : `Imports ${pair.symbols.slice(0, 3).join(', ')}${pair.symbols.length > 3 ? ` (+${pair.symbols.length - 3} more)` : ''}`,
        source: 'ast-import',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Step 2: Create import-based interactions (deterministic, no LLM).
   */
  private createImportBasedInteractions(
    ctx: LlmContext,
    testModuleIds: Set<number>
  ): { importBasedCount: number; fileLevelCount: number } {
    const { db, isJson, verbose } = ctx;

    let importBasedCount = 0;
    const importPairs = db.interactions.getImportOnlyModulePairs();
    if (importPairs.length > 0) {
      if (!isJson) {
        this.log('');
        this.log(chalk.bold('Step 2: Import-Based Interactions (Deterministic)'));
      }

      for (const pair of importPairs) {
        if (this.upsertImportInteraction(db, pair, testModuleIds)) {
          importBasedCount++;
        }
      }

      if (!isJson) {
        this.log(chalk.green(`  Added ${importBasedCount} import-based interactions`));
      }
    }

    // Step 2b: File-level import fallback
    let fileLevelCount = 0;
    const fileLevelPairs = db.interactions.getFileLevelImportModulePairs();
    if (fileLevelPairs.length > 0) {
      for (const pair of fileLevelPairs) {
        const pattern =
          testModuleIds.has(pair.fromModuleId) || testModuleIds.has(pair.toModuleId) ? 'test-internal' : 'business';
        try {
          db.interactions.upsert(pair.fromModuleId, pair.toModuleId, {
            weight: pair.importCount,
            pattern,
            semantic: pair.isTypeOnly ? 'Type dependency (file-level import)' : 'File-level import dependency',
            source: 'ast-import',
          });
          fileLevelCount++;
        } catch {
          // Skip if already exists
        }
      }

      if (!isJson && verbose && fileLevelCount > 0) {
        this.log(chalk.green(`  Added ${fileLevelCount} file-level import interactions`));
      }
    }

    return { importBasedCount, fileLevelCount };
  }

  /**
   * Step 2.5: Contract-based matching (deterministic, no LLM).
   */
  private createContractInteractions(
    ctx: LlmContext,
    processGroups: ProcessGroups
  ): { contractMatchedCount: number; contractLinkedCount: number } {
    const { db, isJson, verbose } = ctx;

    let contractMatchedCount = 0;
    let contractLinkedCount = 0;

    if (db.contracts.getCount() > 0) {
      const backfilled = db.contracts.backfillModuleIds();
      if (backfilled > 0 && !isJson && verbose) {
        this.log(chalk.gray(`  Backfilled ${backfilled} contract participant module_id(s)`));
      }

      if (!isJson) {
        this.log('');
        this.log(chalk.bold('Step 2.5: Contract-Based Matching (Deterministic)'));
      }

      const matcher = new ContractMatcher();
      const contractMatches = matcher.match(db, processGroups);
      const matchResult = matcher.materializeInteractions(db, contractMatches);
      contractMatchedCount = matchResult.created;
      contractLinkedCount = matchResult.linked;

      if (!isJson) {
        this.log(
          chalk.green(
            `  Added ${contractMatchedCount} contract-matched interactions (${contractLinkedCount} definition links)`
          )
        );

        const stats = matcher.getStats(db, processGroups);
        if (stats.byProtocol.size > 0) {
          for (const [protocol, count] of stats.byProtocol) {
            this.log(chalk.gray(`    ${protocol}: ${count} contracts`));
          }
        }
        if (stats.unmatched > 0) {
          this.log(chalk.yellow(`  Unmatched contracts (one-sided): ${stats.unmatched}`));
        }
      }
    }

    return { contractMatchedCount, contractLinkedCount };
  }

  /**
   * Report final results to the user.
   */
  private reportResults(
    ctx: LlmContext,
    counts: {
      totalEdges: number;
      interactions: number;
      importBasedCount: number;
      contractMatchedCount: number;
      contractLinkedCount: number;
      inferredCount: number;
      businessCount: number;
      utilityCount: number;
    }
  ): void {
    const { db, isJson, dryRun } = ctx;

    const relCoverage = db.interactionAnalysis.getRelationshipCoverage();

    const result = {
      totalEdges: counts.totalEdges,
      interactions: counts.interactions,
      importBasedInteractions: counts.importBasedCount,
      contractMatchedInteractions: counts.contractMatchedCount,
      inferredInteractions: counts.inferredCount,
      businessCount: counts.businessCount,
      utilityCount: counts.utilityCount,
      relationshipCoverage: relCoverage,
    };

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    } else {
      this.log('');
      this.log(chalk.bold('Results'));
      this.log(`Total module edges: ${result.totalEdges}`);
      this.log(`AST interactions created: ${result.interactions}`);
      this.log(`  Business: ${counts.businessCount}`);
      this.log(`  Utility: ${counts.utilityCount}`);
      this.log(`Import-based interactions: ${result.importBasedInteractions}`);
      if (counts.contractMatchedCount > 0) {
        this.log(
          `Contract-matched interactions: ${result.contractMatchedInteractions} (${counts.contractLinkedCount} definition links)`
        );
      }
      this.log(`LLM-inferred interactions: ${result.inferredInteractions}`);

      this.log('');
      this.log(chalk.bold('Relationship → Interaction Coverage'));
      this.log(`  Total relationships: ${relCoverage.totalRelationships}`);
      this.log(`  Cross-module: ${relCoverage.crossModuleRelationships}`);
      this.log(`  Same-module (internal cohesion): ${relCoverage.sameModuleCount}`);
      this.log(
        `  Contributing to interactions: ${relCoverage.relationshipsContributingToInteractions}/${relCoverage.crossModuleRelationships} (${relCoverage.coveragePercent.toFixed(1)}%)`
      );
      if (relCoverage.orphanedCount > 0) {
        this.log(chalk.yellow(`  Orphaned (missing module): ${relCoverage.orphanedCount}`));
      }

      if (dryRun) {
        this.log('');
        this.log(chalk.gray('(Dry run - no changes persisted)'));
      }
    }
  }
}
