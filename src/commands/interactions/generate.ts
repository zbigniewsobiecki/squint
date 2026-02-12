import { Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database-facade.js';
import type { EnrichedModuleCallEdge, Module, ModuleCallEdge, ModuleWithMembers } from '../../db/schema.js';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { parseRow } from '../llm/_shared/csv-utils.js';
import { completeWithLogging, getErrorMessage } from '../llm/_shared/llm-utils.js';
import {
  type ProcessGroups,
  areSameProcess,
  computeProcessGroups,
  getCrossProcessGroupPairs,
  getProcessDescription,
  getProcessGroupLabel,
} from '../llm/_shared/process-utils.js';

interface InteractionSuggestion {
  fromModuleId: number;
  toModuleId: number;
  fromModulePath: string;
  toModulePath: string;
  semantic: string;
  pattern: 'utility' | 'business' | 'test-internal';
  symbols: string[];
  weight: number;
}

interface InferredInteraction {
  fromModuleId: number;
  toModuleId: number;
  reason: string;
  confidence?: 'high' | 'medium';
}

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
    const showLlmRequests = ctx.llmOptions.showLlmRequests;
    const showLlmResponses = ctx.llmOptions.showLlmResponses;

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

    // Generate semantics for each edge using LLM
    const interactions: InteractionSuggestion[] = [];

    for (let i = 0; i < enrichedEdges.length; i += batchSize) {
      const batch = enrichedEdges.slice(i, i + batchSize);

      try {
        const batchIdx = Math.floor(i / batchSize);
        const totalBatches = Math.ceil(enrichedEdges.length / batchSize);
        const suggestions = await this.generateInteractionSemantics(
          batch,
          model,
          db,
          isJson,
          batchIdx + 1,
          totalBatches
        );
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
        // Fall back to auto-generated semantics
        for (const edge of batch) {
          interactions.push(this.createDefaultInteraction(edge));
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
      // These don't generate call edges but ARE significant architectural dependencies
      const inheritanceResult = db.interactionAnalysis.syncInheritanceInteractions();
      if (!isJson && verbose && inheritanceResult.created > 0) {
        this.log(chalk.gray(`  Inheritance edges: ${inheritanceResult.created}`));
      }
    }

    // Step 2: Import-based interactions (deterministic — no LLM)
    let importBasedCount = 0;
    if (!dryRun) {
      const importPairs = db.interactions.getImportOnlyModulePairs();
      if (importPairs.length > 0) {
        if (!isJson) {
          this.log('');
          this.log(chalk.bold('Step 2: Import-Based Interactions (Deterministic)'));
        }

        for (const pair of importPairs) {
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
            importBasedCount++;
          } catch {
            // Skip if already exists
          }
        }

        if (!isJson) {
          this.log(chalk.green(`  Added ${importBasedCount} import-based interactions`));
        }
      }
    }

    // Step 2b: File-level import fallback (catches imports where symbol resolution failed)
    let fileLevelCount = 0;
    if (!dryRun) {
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
    }

    // Compute process groups for Steps 3 and 4
    const processGroups = computeProcessGroups(db);

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

    // Get existing edges to avoid duplicates
    const existingEdges = db.callGraph.getModuleCallGraph();

    const logicalInteractions = await this.inferCrossProcessInteractions(
      db,
      processGroups,
      existingEdges,
      model,
      isJson,
      showLlmRequests,
      showLlmResponses
    );

    let inferredCount = 0;
    if (!dryRun && logicalInteractions.length > 0) {
      for (const li of logicalInteractions) {
        try {
          // Derive symbols from target module's exported definitions
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
          // Skip duplicates (edge may already exist from AST detection)
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
      const minRelCoverage = flags['min-relationship-coverage'] as number;
      const maxGateRetries = flags['max-gate-retries'] as number;
      const allModules = db.modules.getAll();
      const moduleMap = new Map(allModules.map((m) => [m.id, m]));

      for (let attempt = 0; attempt < maxGateRetries; attempt++) {
        const coverageCheck = db.interactionAnalysis.getRelationshipCoverage();
        const breakdown = db.interactionAnalysis.getRelationshipCoverageBreakdown();

        if (coverageCheck.coveragePercent >= minRelCoverage || breakdown.noCallEdge === 0) {
          break;
        }

        if (!isJson) {
          if (attempt === 0) {
            this.log('');
            this.log(chalk.bold('Step 4: Coverage Validation (Targeted Inference)'));
          }
          this.log(
            chalk.gray(
              `  Coverage: ${coverageCheck.coveragePercent.toFixed(1)}% (target: ${minRelCoverage}%), ${breakdown.noCallEdge} uncovered pairs`
            )
          );
        }

        const uncoveredPairs = db.interactionAnalysis.getUncoveredModulePairs();
        if (uncoveredPairs.length === 0) break;

        // Pre-filter: partition into auto-skip, auto-flip, and needs-llm
        const needsLlm: typeof uncoveredPairs = [];
        let autoSkipCount = 0;

        for (const pair of uncoveredPairs) {
          const fromMod = moduleMap.get(pair.fromModuleId);
          const toMod = moduleMap.get(pair.toModuleId);

          if (!fromMod || !toMod) {
            autoSkipCount++;
            continue;
          }

          // Cross-process pairs ALWAYS go to LLM (they communicate via runtime protocols)
          if (!areSameProcess(pair.fromModuleId, pair.toModuleId, processGroups)) {
            needsLlm.push(pair);
            continue;
          }

          // Same-layer: check import paths
          const hasForwardImports = db.interactions.hasModuleImportPath(pair.fromModuleId, pair.toModuleId);

          if (hasForwardImports) {
            // Has forward imports → send to LLM for confirmation
            needsLlm.push(pair);
            continue;
          }

          // No forward imports for same-layer pair
          const hasReverseAst = db.interactionAnalysis.hasReverseInteraction(pair.fromModuleId, pair.toModuleId);
          if (hasReverseAst) {
            // Direction confusion: reverse AST interaction exists → auto-skip
            if (verbose && !isJson) {
              this.log(chalk.gray(`  Auto-skip (reversed): ${pair.fromPath} → ${pair.toPath}`));
            }
            autoSkipCount++;
            continue;
          }

          const hasReverseImports = db.interactions.hasModuleImportPath(pair.toModuleId, pair.fromModuleId);
          if (hasReverseImports) {
            // No forward, but reverse imports → direction confusion, auto-skip
            if (verbose && !isJson) {
              this.log(chalk.gray(`  Auto-skip (reverse imports): ${pair.fromPath} → ${pair.toPath}`));
            }
            autoSkipCount++;
            continue;
          }

          // No imports in either direction for same-layer → auto-skip
          autoSkipCount++;
          if (verbose && !isJson) {
            this.log(chalk.gray(`  Auto-skip (no imports): ${pair.fromPath} → ${pair.toPath}`));
          }
        }

        if (!isJson && autoSkipCount > 0) {
          this.log(chalk.gray(`  Pre-filtered: ${autoSkipCount} pairs auto-skipped, ${needsLlm.length} sent to LLM`));
        }

        if (needsLlm.length === 0) break;

        const targetedResults = await this.inferTargetedInteractions(
          db,
          needsLlm,
          moduleMap,
          processGroups,
          model,
          isJson,
          showLlmRequests,
          showLlmResponses
        );

        let targetedCount = 0;
        for (const ti of targetedResults) {
          try {
            // Derive symbols from imports or relationship annotations
            const importedSymbols = db.interactions.getModuleImportedSymbols(ti.fromModuleId, ti.toModuleId);
            let symbols: string[];
            if (importedSymbols.length > 0) {
              symbols = importedSymbols.map((s) => s.name);
            } else {
              symbols = db.interactionAnalysis.getRelationshipSymbolsForPair(ti.fromModuleId, ti.toModuleId);
            }

            db.interactions.upsert(ti.fromModuleId, ti.toModuleId, {
              semantic: ti.reason,
              source: 'llm-inferred',
              pattern: 'business',
              symbols: symbols.length > 0 ? symbols : undefined,
              weight: 1,
              confidence: ti.confidence ?? 'medium',
            });
            targetedCount++;
          } catch {
            // Skip duplicates
          }
        }

        if (!isJson) {
          this.log(chalk.green(`  Pass ${attempt + 1}: Added ${targetedCount} targeted interactions`));
        }

        if (targetedCount === 0) break;
      }
    }

    // Get relationship coverage
    const relCoverage = db.interactionAnalysis.getRelationshipCoverage();

    // Output results
    const result = {
      totalEdges: enrichedEdges.length,
      interactions: interactions.length,
      importBasedInteractions: importBasedCount,
      inferredInteractions: inferredCount,
      businessCount,
      utilityCount,
      relationshipCoverage: relCoverage,
    };

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    } else {
      this.log('');
      this.log(chalk.bold('Results'));
      this.log(`Total module edges: ${result.totalEdges}`);
      this.log(`AST interactions created: ${result.interactions}`);
      this.log(`  Business: ${businessCount}`);
      this.log(`  Utility: ${utilityCount}`);
      this.log(`Import-based interactions: ${result.importBasedInteractions}`);
      this.log(`LLM-inferred interactions: ${result.inferredInteractions}`);

      // Display relationship coverage
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

  /**
   * Generate semantic descriptions for module edges using LLM.
   */
  private async generateInteractionSemantics(
    edges: EnrichedModuleCallEdge[],
    model: string,
    db: IndexDatabase,
    isJson: boolean,
    batchIdx: number,
    totalBatches: number
  ): Promise<InteractionSuggestion[]> {
    const systemPrompt = `You are a software architect analyzing module-level dependencies.

For each module-to-module interaction, provide a semantic description of what the interaction does.

Output format - respond with ONLY a CSV table:

\`\`\`csv
from_module,to_module,semantic
project.controllers,project.services.auth,"Controllers delegate authentication logic to the auth service for credential validation"
\`\`\`

Guidelines:
- Describe WHY the source module calls the target module
- For UTILITY patterns: use generic descriptions like "Uses logging utilities", "Accesses database layer"
- For BUSINESS patterns: be specific about the business action (e.g., "Processes customer orders", "Validates user credentials")
- Keep descriptions concise (under 80 chars)
- Focus on the business purpose, not implementation details`;

    // Build module lookup for descriptions
    const allModules = db.modules.getAll();
    const moduleMap = new Map(allModules.map((m) => [m.id, m]));

    // Build edge descriptions with symbol details and module context
    const edgeDescriptions = edges
      .map((e, i) => {
        const symbolList = e.calledSymbols.map((s) => `${s.name} (${s.kind}, ${s.callCount} calls)`).join(', ');
        const patternInfo = `[${e.edgePattern.toUpperCase()}]`;
        const fromMod = moduleMap.get(e.fromModuleId);
        const toMod = moduleMap.get(e.toModuleId);
        const fromDesc = fromMod ? `${fromMod.name}${fromMod.description ? ` - ${fromMod.description}` : ''}` : '';
        const toDesc = toMod ? `${toMod.name}${toMod.description ? ` - ${toMod.description}` : ''}` : '';

        let desc = `${i + 1}. ${patternInfo} ${e.fromModulePath} → ${e.toModulePath} (${e.weight} calls)`;
        if (fromDesc) desc += `\n   From: "${fromDesc}"`;
        if (toDesc) desc += `\n   To: "${toDesc}"`;
        desc += `\n   Symbols: ${symbolList}`;
        return desc;
      })
      .join('\n');

    const userPrompt = `## Module Interactions to Describe (${edges.length})

${edgeDescriptions}

Generate semantic descriptions for each interaction in CSV format.`;

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 4096,
      command: this,
      isJson,
      iteration: { current: batchIdx, max: totalBatches },
    });

    return this.parseInteractionCSV(response, edges);
  }

  /**
   * Parse LLM CSV response into interaction suggestions.
   */
  private parseInteractionCSV(response: string, edges: EnrichedModuleCallEdge[]): InteractionSuggestion[] {
    const results: InteractionSuggestion[] = [];

    // Find CSV block
    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('from_module'));

    for (const line of lines) {
      const fields = parseRow(line);
      if (!fields || fields.length < 3) continue;

      const [fromPath, toPath, semantic] = fields;

      // Find matching edge
      const edge =
        edges.find((e) => e.fromModulePath === fromPath && e.toModulePath === toPath) ||
        edges.find((e) => e.fromModulePath.endsWith(fromPath) && e.toModulePath.endsWith(toPath));

      if (edge) {
        results.push({
          fromModuleId: edge.fromModuleId,
          toModuleId: edge.toModuleId,
          fromModulePath: edge.fromModulePath,
          toModulePath: edge.toModulePath,
          semantic: semantic.trim().replace(/"/g, ''),
          pattern: edge.edgePattern,
          symbols: edge.calledSymbols.map((s) => s.name),
          weight: edge.weight,
        });
      }
    }

    // Add defaults for any edges not covered
    for (const edge of edges) {
      if (!results.find((r) => r.fromModuleId === edge.fromModuleId && r.toModuleId === edge.toModuleId)) {
        results.push(this.createDefaultInteraction(edge));
      }
    }

    return results;
  }

  /**
   * Create a default interaction from an edge when LLM fails.
   */
  private createDefaultInteraction(edge: EnrichedModuleCallEdge): InteractionSuggestion {
    const fromLast = edge.fromModulePath.split('.').pop() ?? 'source';
    const toLast = edge.toModulePath.split('.').pop() ?? 'target';

    return {
      fromModuleId: edge.fromModuleId,
      toModuleId: edge.toModuleId,
      fromModulePath: edge.fromModulePath,
      toModulePath: edge.toModulePath,
      semantic: `${fromLast} uses ${toLast}`,
      pattern: edge.edgePattern,
      symbols: edge.calledSymbols.map((s) => s.name),
      weight: edge.weight,
    };
  }

  // ============================================================
  // Step 3: Cross-Process Interaction Inference
  // ============================================================

  /**
   * Infer cross-process interactions between modules in different process groups.
   * Uses import graph connectivity (union-find) to detect process boundaries,
   * then asks LLM to identify runtime connections between separate processes.
   */
  private async inferCrossProcessInteractions(
    db: IndexDatabase,
    processGroups: ProcessGroups,
    existingEdges: ModuleCallEdge[],
    model: string,
    isJson: boolean,
    showLlmRequests: boolean,
    showLlmResponses: boolean
  ): Promise<InferredInteraction[]> {
    if (processGroups.groupCount < 2) {
      this.log(chalk.gray('  Single process group — no cross-process inference needed'));
      return [];
    }

    const modules = db.modules.getAll();
    const modulesWithMembers = db.modules.getAllWithMembers();

    // Build existing edge lookup to avoid duplicates
    const existingPairs = new Set(existingEdges.map((e) => `${e.fromModuleId}->${e.toModuleId}`));

    // Also include existing interactions (both AST and already-inferred)
    const existingInteractions = db.interactions.getAll();
    for (const interaction of existingInteractions) {
      existingPairs.add(`${interaction.fromModuleId}->${interaction.toModuleId}`);
    }

    // Build members lookup for enriched prompt
    const membersMap = new Map(modulesWithMembers.map((m) => [m.id, m]));

    const allResults: InferredInteraction[] = [];
    const crossProcessPairs = getCrossProcessGroupPairs(processGroups);

    for (const [groupA, groupB] of crossProcessPairs) {
      const labelA = getProcessGroupLabel(groupA);
      const labelB = getProcessGroupLabel(groupB);

      const systemPrompt = this.buildCrossProcessSystemPrompt();
      const userPrompt = this.buildCrossProcessUserPrompt(
        groupA,
        groupB,
        labelA,
        labelB,
        existingEdges,
        modules,
        membersMap
      );

      if (showLlmRequests) {
        this.log(chalk.cyan('='.repeat(60)));
        this.log(chalk.cyan(`LLM REQUEST - inferCrossProcessInteractions (${labelA} <-> ${labelB})`));
        this.log(chalk.gray(systemPrompt));
        this.log(chalk.gray(userPrompt));
      }

      const response = await completeWithLogging({
        model,
        systemPrompt,
        userPrompt,
        temperature: 0,
        maxTokens: 8192,
        command: this,
        isJson,
      });

      if (showLlmResponses) {
        this.log(chalk.green('='.repeat(60)));
        this.log(chalk.green('LLM RESPONSE'));
        this.log(chalk.gray(response));
      }

      const results = this.parseLogicalInteractionCSV(response, modules, existingPairs, processGroups, db);
      allResults.push(...results);
    }

    return allResults;
  }

  /**
   * Infer targeted interactions for specific uncovered module pairs.
   * These are module pairs with symbol-level relationships but no detected interaction.
   * Prompt is enriched with module descriptions, import evidence, and relationship details.
   */
  private async inferTargetedInteractions(
    db: IndexDatabase,
    uncoveredPairs: Array<{
      fromModuleId: number;
      toModuleId: number;
      fromPath: string;
      toPath: string;
      relationshipCount: number;
    }>,
    moduleMap: Map<number, Module>,
    processGroups: ProcessGroups,
    model: string,
    isJson: boolean,
    showLlmRequests: boolean,
    showLlmResponses: boolean
  ): Promise<InferredInteraction[]> {
    if (uncoveredPairs.length === 0) return [];

    const systemPrompt = `You are reviewing module pairs that have symbol-level relationships but no detected interaction.
For each pair, determine if a real runtime interaction exists and describe it.

## Decision Rules (CRITICAL)
- If "Forward imports: NONE" AND "Process: same-process" → SKIP (no static dependency exists)
- If "Reverse AST interaction: YES" → SKIP (the relationship direction is reversed; the reverse is already detected)
- If "Forward imports: YES" → CONFIRM is likely valid
- If "Process: separate-process" → use module descriptions and relationship semantics to decide
- When in doubt about same-process pairs with no imports → SKIP (trust static analysis)

## Output Format
\`\`\`csv
from_module_path,to_module_path,action,reason
project.backend.services.sales,project.backend.data.models.vehicle,CONFIRM,"Sales service updates vehicle availability status on sale completion"
project.shared.types,project.backend.models,SKIP,"Shared type definitions, no runtime interaction"
\`\`\`

For each pair:
- CONFIRM if a real interaction exists (provide a semantic description as reason)
- SKIP if it's an artifact (shared types, transitive dependency, test-only, or no static evidence)`;

    // Build enriched pair descriptions
    const pairDescriptions = uncoveredPairs
      .map((p, i) => {
        const fromMod = moduleMap.get(p.fromModuleId);
        const toMod = moduleMap.get(p.toModuleId);

        // Module descriptions
        const fromDesc = fromMod ? `${fromMod.name}${fromMod.description ? ` - ${fromMod.description}` : ''}` : '';
        const toDesc = toMod ? `${toMod.name}${toMod.description ? ` - ${toMod.description}` : ''}` : '';

        // Process info
        const processDesc = getProcessDescription(p.fromModuleId, p.toModuleId, processGroups);

        // Import evidence
        const hasForwardImports = db.interactions.hasModuleImportPath(p.fromModuleId, p.toModuleId);
        const hasReverseImports = db.interactions.hasModuleImportPath(p.toModuleId, p.fromModuleId);
        const forwardImportStr = hasForwardImports ? 'YES' : 'NONE';
        const reverseImportStr = hasReverseImports ? 'YES' : 'NONE';

        // Reverse AST interaction
        const hasReverseAst = db.interactionAnalysis.hasReverseInteraction(p.fromModuleId, p.toModuleId);

        // Relationship details
        const relDetails = db.interactionAnalysis.getRelationshipDetailsForModulePair(p.fromModuleId, p.toModuleId);

        let desc = `${i + 1}. ${p.fromPath} → ${p.toPath}`;
        if (fromDesc) desc += `\n   From: "${fromDesc}"`;
        if (toDesc) desc += `\n   To: "${toDesc}"`;
        desc += `\n   Process: ${processDesc}`;
        desc += `\n   Forward imports: ${forwardImportStr} | Reverse imports: ${reverseImportStr} | Reverse AST interaction: ${hasReverseAst ? 'YES' : 'NO'}`;

        if (relDetails.length > 0) {
          desc += `\n   Relationship symbols (${relDetails.length}):`;
          for (const rd of relDetails.slice(0, 5)) {
            desc += `\n     - ${rd.fromName} → ${rd.toName}: "${rd.semantic}"`;
          }
          if (relDetails.length > 5) {
            desc += `\n     (+${relDetails.length - 5} more)`;
          }
        }

        return desc;
      })
      .join('\n');

    const userPrompt = `## Module Pairs to Evaluate (${uncoveredPairs.length})

${pairDescriptions}

Evaluate each pair and output CONFIRM or SKIP in CSV format.`;

    if (showLlmRequests) {
      this.log(chalk.cyan('='.repeat(60)));
      this.log(chalk.cyan('LLM REQUEST - inferTargetedInteractions'));
      this.log(chalk.gray(systemPrompt));
      this.log(chalk.gray(userPrompt));
    }

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 8192,
      command: this,
      isJson,
    });

    if (showLlmResponses) {
      this.log(chalk.green('='.repeat(60)));
      this.log(chalk.green('LLM RESPONSE'));
      this.log(chalk.gray(response));
    }

    // Parse response
    const results: InferredInteraction[] = [];
    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/);
    const csv = csvMatch ? csvMatch[1] : response;

    const pairByPaths = new Map(uncoveredPairs.map((p) => [`${p.fromPath}|${p.toPath}`, p]));
    const moduleByPath = new Map(Array.from(moduleMap.values()).map((m) => [m.fullPath, m]));

    // Build existingInteractionPairs for gating
    const existingInteractions = db.interactions.getAll();
    const existingInteractionPairs = new Set(existingInteractions.map((i) => `${i.fromModuleId}->${i.toModuleId}`));

    for (const line of csv.split('\n')) {
      if (!line.trim() || line.startsWith('from_module')) continue;

      const fields = parseRow(line);
      if (!fields || fields.length < 4) continue;

      const [fromPath, toPath, action, reason] = fields;

      if (action.trim().toUpperCase() !== 'CONFIRM') continue;

      const pair = pairByPaths.get(`${fromPath.trim()}|${toPath.trim()}`);
      if (!pair) continue;

      const fromModule = moduleByPath.get(pair.fromPath);
      const toModule = moduleByPath.get(pair.toPath);
      if (!fromModule || !toModule) continue;

      // Apply structural gating
      const gate = this.gateInferredInteraction(fromModule, toModule, processGroups, existingInteractionPairs, db);
      if (!gate.pass) continue;

      results.push({
        fromModuleId: pair.fromModuleId,
        toModuleId: pair.toModuleId,
        reason: reason?.replace(/"/g, '').trim() ?? 'Targeted inference',
        confidence: 'medium',
      });
    }

    return results;
  }

  /**
   * Build system prompt for cross-process inference.
   */
  private buildCrossProcessSystemPrompt(): string {
    return `You identify LOGICAL runtime connections between modules in separate processes.
These modules have NO import connectivity — they communicate via runtime protocols
(HTTP/REST, gRPC, WebSocket, IPC, message queues, CLI invocation, file I/O, etc.).

For each connection:
- Identify the SOURCE module (the one initiating the call/request)
- Identify the TARGET module (the one handling/receiving)
- Describe the communication mechanism and purpose

Use entity/name matching to pair modules:
- "useCustomers" (process A) likely calls "customerController" (process B)
- Match by entity name, action verbs, and module descriptions

Only report connections with medium or high confidence.

## Output Format
\`\`\`csv
from_module_path,to_module_path,reason,confidence
project.frontend.hooks.useCustomers,project.backend.api.controllers,"Customer data hooks call customer API controllers via HTTP",high
\`\`\`

Confidence levels:
- high: Names/patterns strongly suggest connection
- medium: Context supports it but names don't match exactly
- Skip low confidence - only report likely connections

DO NOT report:
- Connections within the same process group (those are visible via static analysis)
- Utility modules (logging, config, etc.)
- Shared type definitions (no runtime interaction)

## Architecture Constraints
- In client-server architectures, the CLIENT (frontend/app/sdk) initiates requests.
  Backend modules do NOT push to specific frontend components.
- Dev-time modules (CLI scripts, seed scripts, migrations) have NO runtime callers.
  Do NOT connect production modules to dev-time utilities.
- A realistic cross-process call surface has 3-8 callers per target, not dozens.
  If you find yourself connecting most modules in one group to a single target, stop.`;
  }

  /**
   * Build user prompt for cross-process inference between two process groups.
   * Includes member names for entity pattern matching.
   */
  private buildCrossProcessUserPrompt(
    groupA: Module[],
    groupB: Module[],
    labelA: string,
    labelB: string,
    existingEdges: ModuleCallEdge[],
    allModules: Module[],
    membersMap: Map<number, ModuleWithMembers>
  ): string {
    const parts: string[] = [];

    const MAX_MEMBERS = 8;
    const KIND_PRIORITY: Record<string, number> = { function: 0, class: 1, variable: 2 };

    const formatMembers = (moduleId: number): string => {
      const modWithMembers = membersMap.get(moduleId);
      if (!modWithMembers || modWithMembers.members.length === 0) return '';
      const sorted = [...modWithMembers.members].sort(
        (a, b) => (KIND_PRIORITY[a.kind] ?? 3) - (KIND_PRIORITY[b.kind] ?? 3)
      );
      const shown = sorted.slice(0, MAX_MEMBERS);
      const memberList = shown.map((m) => `${m.name} (${m.kind})`).join(', ');
      const extra = sorted.length > MAX_MEMBERS ? ` (+${sorted.length - MAX_MEMBERS} more)` : '';
      return `\n  Members: ${memberList}${extra}`;
    };

    const groupAIds = new Set(groupA.map((m) => m.id));
    const groupBIds = new Set(groupB.map((m) => m.id));

    const BOUNDARY_PATTERNS =
      /\b(router|controller|handler|hook|client|endpoint|api|gateway|service|provider|adapter|facade|proxy|middleware)\b/i;

    const detectBoundaryModules = (group: Module[]): Module[] => {
      return group.filter((m) => {
        // Check module name/path
        if (BOUNDARY_PATTERNS.test(m.fullPath) || BOUNDARY_PATTERNS.test(m.name)) return true;
        // Check member names
        const modWithMembers = membersMap.get(m.id);
        if (modWithMembers) {
          return modWithMembers.members.some((member) => BOUNDARY_PATTERNS.test(member.name));
        }
        return false;
      });
    };

    const formatBoundaryHints = (boundaryModules: Module[], label: string): string[] => {
      if (boundaryModules.length === 0) return [];
      const hints: string[] = [];
      hints.push(`\nLikely boundary modules in "${label}":`);
      for (const m of boundaryModules.slice(0, 10)) {
        hints.push(`  * ${m.fullPath}`);
      }
      return hints;
    };

    parts.push(`## Process Group: "${labelA}" (${groupA.length} modules)`);
    for (const m of groupA) {
      parts.push(`- ${m.fullPath}: "${m.name}"${m.description ? ` - ${m.description}` : ''}${formatMembers(m.id)}`);
    }
    const boundaryA = detectBoundaryModules(groupA);
    parts.push(...formatBoundaryHints(boundaryA, labelA));

    parts.push('');
    parts.push(`## Process Group: "${labelB}" (${groupB.length} modules)`);
    for (const m of groupB) {
      parts.push(`- ${m.fullPath}: "${m.name}"${m.description ? ` - ${m.description}` : ''}${formatMembers(m.id)}`);
    }
    const boundaryB = detectBoundaryModules(groupB);
    parts.push(...formatBoundaryHints(boundaryB, labelB));

    parts.push('');
    parts.push('## Existing AST-Detected Cross-Process Connections (for reference)');
    const crossProcessEdges = existingEdges.filter((e) => {
      const fromInA = groupAIds.has(e.fromModuleId);
      const fromInB = groupBIds.has(e.fromModuleId);
      const toInA = groupAIds.has(e.toModuleId);
      const toInB = groupBIds.has(e.toModuleId);
      return (fromInA && toInB) || (fromInB && toInA);
    });

    if (crossProcessEdges.length === 0) {
      parts.push('(None detected - this is why we need inference!)');
    } else {
      for (const e of crossProcessEdges) {
        const from = allModules.find((m) => m.id === e.fromModuleId);
        const to = allModules.find((m) => m.id === e.toModuleId);
        if (from && to) {
          parts.push(`- ${from.fullPath} → ${to.fullPath}`);
        }
      }
    }

    parts.push('');
    parts.push('Identify runtime connections between these two process groups.');

    return parts.join('\n');
  }

  /**
   * Check if a module contains only type definitions (interfaces, types, enums).
   * Type-only modules should never be the initiator of an interaction.
   */
  private isTypeOnlyModule(moduleId: number, db: IndexDatabase): boolean {
    const members = db.modules.getSymbols(moduleId);
    if (members.length === 0) return false;
    const TYPE_KINDS = new Set(['interface', 'type', 'enum']);
    return members.every((m) => TYPE_KINDS.has(m.kind));
  }

  /**
   * Structural gate for inferred interactions.
   * Rejects duplicates, self-loops, reverse-of-AST interactions, and type-only initiators.
   */
  private gateInferredInteraction(
    fromModule: Module,
    toModule: Module,
    _processGroups: ProcessGroups,
    existingInteractionPairs: Set<string>,
    db: IndexDatabase
  ): { pass: boolean; reason?: string } {
    // Gate A — Duplicate
    const pairKey = `${fromModule.id}->${toModule.id}`;
    if (existingInteractionPairs.has(pairKey)) {
      return { pass: false, reason: 'duplicate' };
    }

    // Gate B — Self-loop
    if (fromModule.id === toModule.id) {
      return { pass: false, reason: 'self-loop' };
    }

    // Gate C — Reverse-of-AST
    const reverseInteraction = db.interactions.getByModules(toModule.id, fromModule.id);
    if (reverseInteraction && (reverseInteraction.source === 'ast' || reverseInteraction.source === 'ast-import')) {
      return { pass: false, reason: 'reverse-of-ast' };
    }

    // Gate D — Type-only module as initiator
    if (this.isTypeOnlyModule(fromModule.id, db)) {
      return { pass: false, reason: 'type-only-initiator' };
    }

    return { pass: true };
  }

  /**
   * Parse the LLM response CSV into inferred interactions.
   */
  private parseLogicalInteractionCSV(
    response: string,
    modules: Module[],
    existingPairs: Set<string>,
    processGroups: ProcessGroups,
    db: IndexDatabase
  ): InferredInteraction[] {
    const results: InferredInteraction[] = [];
    const moduleByPath = new Map(modules.map((m) => [m.fullPath, m]));

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/);
    const csv = csvMatch ? csvMatch[1] : response;

    for (const line of csv.split('\n')) {
      if (!line.trim() || line.startsWith('from_module')) continue;

      const fields = parseRow(line);
      if (!fields || fields.length < 4) continue;

      const [fromPath, toPath, reason, confidenceStr] = fields;

      const fromModule = moduleByPath.get(fromPath.trim());
      const toModule = moduleByPath.get(toPath.trim());

      if (!fromModule || !toModule) continue;

      const normalizedConfidence = confidenceStr.trim().toLowerCase();
      if (normalizedConfidence === 'low') continue;

      // Apply structural gating
      const gate = this.gateInferredInteraction(fromModule, toModule, processGroups, existingPairs, db);
      if (!gate.pass) continue;

      const confidence: 'high' | 'medium' = normalizedConfidence === 'high' ? 'high' : 'medium';

      results.push({
        fromModuleId: fromModule.id,
        toModuleId: toModule.id,
        reason: reason?.replace(/"/g, '').trim() ?? 'LLM inferred connection',
        confidence,
      });

      // Mark as processed to avoid duplicates within this batch
      existingPairs.add(`${fromModule.id}->${toModule.id}`);
    }

    return results;
  }
}
