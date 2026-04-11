import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { type ProcessGroups, computeProcessGroups, getProcessGroupLabel } from '../llm/_shared/process-utils.js';
import type { InteractionSuggestion } from './_shared/ast-semantics.js';
import { persistInteractions, processBatchSemantics, tagTestInternalInteractions } from './_shared/batch-processor.js';
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

    // Tag test-internal interactions: if either module is a test module, override pattern
    const testModuleIds = db.modules.getTestModuleIds();

    const utilityCount = enrichedEdges.filter((e) => e.edgePattern === 'utility').length;
    const businessCount = enrichedEdges.filter((e) => e.edgePattern === 'business').length;

    let interactions: InteractionSuggestion[] = [];

    if (enrichedEdges.length > 0) {
      if (!isJson && verbose) {
        this.log(chalk.gray(`Found ${enrichedEdges.length} module-to-module edges`));
        this.log(chalk.gray(`  Business logic: ${businessCount}, Utility: ${utilityCount}`));
      }

      // Step 1: Generate semantics for each edge using LLM (in batches)
      interactions = await processBatchSemantics(enrichedEdges, batchSize, model, db, this, isJson, verbose);

      tagTestInternalInteractions(interactions, testModuleIds, { command: this, isJson, verbose });

      // Persist interactions
      persistInteractions(db, interactions, verbose, isJson, dryRun, this);
    } else if (!isJson && verbose) {
      this.log(chalk.gray('No call-graph edges found, skipping Step 1 (LLM semantics)'));
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
                .filter(
                  (m) => m.kind === 'function' || m.kind === 'class' || m.kind === 'method' || m.kind === 'module'
                )
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
    const interactions: InteractionSuggestion[] = await processBatchSemantics(
      enrichedEdges,
      batchSize,
      model,
      db,
      this,
      isJson,
      verbose
    );

    // Tag test-internal interactions
    const testModuleIds = db.modules.getTestModuleIds();
    tagTestInternalInteractions(interactions, testModuleIds);

    // Persist via upsert (preserves IDs for clean-endpoint interactions)
    persistInteractions(db, interactions, verbose, isJson, dryRun, this);

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
   *
   * PR1/4: When the symbols stage has annotated the imported symbols with a
   * `purpose`, use the first one to build an architectural semantic instead
   * of the literal "Imports X" placeholder. The placeholder was scoring ~0.3
   * on the eval rubric for edges like `tasks-controller → requireAuth` where
   * the GT expected "guards endpoints with the authentication middleware".
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
        semantic: this.buildImportSemantic(db, pair),
        source: 'ast-import',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build a semantic description for an import-only module edge. Looks up the
   * `purpose` of the imported symbols from definition_metadata so the result
   * describes architectural USE (e.g. "Uses requireAuth: middleware that rejects
   * unauthenticated requests") instead of the literal "Imports requireAuth".
   *
   * Falls back to the placeholder when no purposes are annotated yet (e.g. when
   * the symbols stage hasn't run, or for type-only imports).
   */
  private buildImportSemantic(
    db: LlmContext['db'],
    pair: { toModuleId: number; symbols: string[]; isTypeOnly: boolean }
  ): string {
    const shownSymbols = pair.symbols.slice(0, 3);
    const moreCount = pair.symbols.length - shownSymbols.length;
    const moreSuffix = moreCount > 0 ? ` (+${moreCount} more)` : '';

    if (pair.isTypeOnly || shownSymbols.length === 0) {
      return pair.isTypeOnly
        ? `Type/interface dependency (${shownSymbols.join(', ')}${moreCount > 0 ? '...' : ''})`
        : `Imports ${shownSymbols.join(', ')}${moreSuffix}`;
    }

    // Look up purposes for the target module's symbols and pick the first that
    // matches one of the imported names. Per-module cache avoids duplicate
    // queries when many edges import from the same target.
    const purposesByName = this.getImportTargetPurposes(db, pair.toModuleId);
    const PURPOSE_CHAR_BUDGET = 100;
    for (const symbolName of shownSymbols) {
      const purpose = purposesByName.get(symbolName);
      if (purpose) {
        const truncated =
          purpose.length > PURPOSE_CHAR_BUDGET ? `${purpose.slice(0, PURPOSE_CHAR_BUDGET - 1)}…` : purpose;
        return `Uses ${shownSymbols.join(', ')}${moreSuffix} — ${truncated}`;
      }
    }

    return `Imports ${shownSymbols.join(', ')}${moreSuffix}`;
  }

  /**
   * Per-target-module cache for symbol-name → purpose lookups. Lives on the
   * command instance for the duration of one `interactions generate` invocation;
   * a fresh instance gets a fresh cache.
   */
  private importPurposeCache = new Map<number, Map<string, string>>();
  private getImportTargetPurposes(db: LlmContext['db'], toModuleId: number): Map<string, string> {
    const cached = this.importPurposeCache.get(toModuleId);
    if (cached) return cached;

    const members = db.modules.getSymbols(toModuleId);
    const defIds = members.map((m) => m.id);
    const purposes = db.metadata.getValuesByKey(defIds, 'purpose');
    const byName = new Map<string, string>();
    for (const m of members) {
      const purpose = purposes.get(m.id);
      if (purpose) byName.set(m.name, purpose);
    }
    this.importPurposeCache.set(toModuleId, byName);
    return byName;
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
