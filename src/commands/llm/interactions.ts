import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import type { IndexDatabase } from '../../db/database-facade.js';
import type { EnrichedModuleCallEdge, Module, ModuleCallEdge } from '../../db/schema.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';
import { parseCSVLine } from './_shared/csv-utils.js';
import { groupModulesByEntity } from './_shared/entity-utils.js';
import { getErrorMessage } from './_shared/llm-utils.js';

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
}

export default class Interactions extends Command {
  static override description = 'Detect module interactions from call graph and generate semantics using LLM';

  static override examples = [
    '<%= config.bin %> llm interactions',
    '<%= config.bin %> llm interactions --dry-run',
    '<%= config.bin %> llm interactions --force',
    '<%= config.bin %> llm interactions -d index.db --verbose',
  ];

  static override flags = {
    database: SharedFlags.database,

    // LLM options
    model: Flags.string({
      char: 'm',
      description: 'LLM model alias',
      default: 'openrouter:google/gemini-2.5-flash',
    }),
    'batch-size': Flags.integer({
      description: 'Module edges per LLM batch for semantic generation',
      default: 10,
    }),

    // Output options
    'dry-run': Flags.boolean({
      description: 'Show results without persisting',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Re-detect even if interactions exist',
      default: false,
    }),
    json: SharedFlags.json,
    verbose: Flags.boolean({
      description: 'Show detailed progress',
      default: false,
    }),
    'show-llm-requests': Flags.boolean({
      description: 'Show LLM request prompts',
      default: false,
    }),
    'show-llm-responses': Flags.boolean({
      description: 'Show LLM response text',
      default: false,
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

  public async run(): Promise<void> {
    const { flags } = await this.parse(Interactions);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;
    const model = flags.model;
    const batchSize = flags['batch-size'];
    const showLlmRequests = flags['show-llm-requests'];
    const showLlmResponses = flags['show-llm-responses'];

    try {
      // Check if interactions already exist
      const existingCount = db.getInteractionCount();
      if (existingCount > 0 && !flags.force) {
        if (isJson) {
          this.log(
            JSON.stringify({
              error: 'Interactions already exist',
              count: existingCount,
              hint: 'Use --force to re-detect',
            })
          );
        } else {
          this.log(chalk.yellow(`${existingCount} interactions already exist.`));
          this.log(chalk.gray('Use --force to re-detect interactions.'));
        }
        return;
      }

      if (!isJson) {
        this.log(chalk.bold('Interaction Detection'));
        this.log(chalk.gray(`Model: ${model}`));
        this.log('');
      }

      // Clear existing interactions if force
      if (existingCount > 0 && flags.force && !dryRun) {
        db.clearInteractions();
        if (!isJson && verbose) {
          this.log(chalk.gray(`Cleared ${existingCount} existing interactions`));
        }
      }

      // Get enriched module call graph
      const enrichedEdges = db.getEnrichedModuleCallGraph();

      if (enrichedEdges.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ error: 'No module call graph edges found', hint: 'Run llm modules first' }));
        } else {
          this.log(chalk.yellow('No module call graph edges found.'));
          this.log(chalk.gray('Ensure modules are assigned first with `ats llm modules`'));
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
          const suggestions = await this.generateInteractionSemantics(batch, model);
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

      // Tag test-internal interactions: if both modules are test, override pattern
      const testModuleIds = db.getTestModuleIds();
      if (testModuleIds.size > 0) {
        for (const interaction of interactions) {
          if (testModuleIds.has(interaction.fromModuleId) && testModuleIds.has(interaction.toModuleId)) {
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
            db.upsertInteraction(interaction.fromModuleId, interaction.toModuleId, {
              weight: interaction.weight,
              pattern: interaction.pattern,
              symbols: interaction.symbols,
              semantic: interaction.semantic,
            });
          } catch {
            if (verbose && !isJson) {
              this.log(
                chalk.yellow(`  Skipping duplicate: ${interaction.fromModulePath} → ${interaction.toModulePath}`)
              );
            }
          }
        }

        // Create inheritance-based interactions (extends/implements)
        // These don't generate call edges but ARE significant architectural dependencies
        const inheritanceResult = db.syncInheritanceInteractions();
        if (!isJson && verbose && inheritanceResult.created > 0) {
          this.log(chalk.gray(`  Inheritance edges: ${inheritanceResult.created}`));
        }
      }

      // Step 3: Infer logical (non-AST) interactions
      if (!isJson) {
        this.log('');
        this.log(chalk.bold('Step 3: Inferring Logical Connections (LLM Analysis)'));
      }

      // Get existing edges to avoid duplicates
      const existingEdges = db.getModuleCallGraph();

      const logicalInteractions = await this.inferLogicalInteractions(
        db,
        existingEdges,
        model,
        showLlmRequests,
        showLlmResponses
      );

      let inferredCount = 0;
      if (!dryRun && logicalInteractions.length > 0) {
        for (const li of logicalInteractions) {
          try {
            db.upsertInteraction(li.fromModuleId, li.toModuleId, {
              semantic: li.reason,
              source: 'llm-inferred',
              weight: 1,
            });
            inferredCount++;
          } catch {
            // Skip duplicates (edge may already exist from AST detection)
            if (verbose && !isJson) {
              const modules = db.getAllModules();
              const fromMod = modules.find((m) => m.id === li.fromModuleId);
              const toMod = modules.find((m) => m.id === li.toModuleId);
              this.log(chalk.gray(`  Skipping: ${fromMod?.fullPath} → ${toMod?.fullPath} (exists)`));
            }
          }
        }

        if (!isJson) {
          this.log(chalk.green(`  Added ${inferredCount} inferred interactions`));
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
        const minRelCoverage = flags['min-relationship-coverage'];
        const maxGateRetries = flags['max-gate-retries'];

        for (let attempt = 0; attempt < maxGateRetries; attempt++) {
          const coverageCheck = db.getRelationshipCoverage();
          const breakdown = db.getRelationshipCoverageBreakdown();

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

          const uncoveredPairs = db.getUncoveredModulePairs();
          if (uncoveredPairs.length === 0) break;

          const targetedResults = await this.inferTargetedInteractions(
            uncoveredPairs,
            model,
            showLlmRequests,
            showLlmResponses
          );

          let targetedCount = 0;
          for (const ti of targetedResults) {
            try {
              db.upsertInteraction(ti.fromModuleId, ti.toModuleId, {
                semantic: ti.reason,
                source: 'llm-inferred',
                weight: 1,
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
      const relCoverage = db.getRelationshipCoverage();

      // Output results
      const result = {
        totalEdges: enrichedEdges.length,
        interactions: interactions.length,
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
    } finally {
      db.close();
    }
  }

  /**
   * Generate semantic descriptions for module edges using LLM.
   */
  private async generateInteractionSemantics(
    edges: EnrichedModuleCallEdge[],
    model: string
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

    // Build edge descriptions with symbol details
    const edgeDescriptions = edges
      .map((e, i) => {
        const symbolList = e.calledSymbols.map((s) => s.name).join(', ');
        const patternInfo = `[${e.edgePattern.toUpperCase()}]`;
        return `${i + 1}. ${patternInfo} ${e.fromModulePath} → ${e.toModulePath} (${e.weight} calls)\n   Symbols: ${symbolList}`;
      })
      .join('\n');

    const userPrompt = `## Module Interactions to Describe (${edges.length})

${edgeDescriptions}

Generate semantic descriptions for each interaction in CSV format.`;

    const response = await LLMist.complete(userPrompt, {
      model,
      systemPrompt,
      temperature: 0,
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
      const fields = parseCSVLine(line);
      if (fields.length < 3) continue;

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
  // Step 3: Logical Interaction Inference
  // ============================================================

  /**
   * Infer logical (non-AST) interactions between modules using LLM analysis.
   * These are connections that exist at runtime but aren't in the static call graph,
   * such as HTTP calls between frontend and backend.
   */
  private async inferLogicalInteractions(
    db: IndexDatabase,
    existingEdges: ModuleCallEdge[],
    model: string,
    showLlmRequests: boolean,
    showLlmResponses: boolean
  ): Promise<InferredInteraction[]> {
    const modules = db.getAllModules();

    // Build existing edge lookup to avoid duplicates
    const existingPairs = new Set(existingEdges.map((e) => `${e.fromModuleId}->${e.toModuleId}`));

    // Also include existing interactions (both AST and already-inferred)
    const existingInteractions = db.getAllInteractions();
    for (const interaction of existingInteractions) {
      existingPairs.add(`${interaction.fromModuleId}->${interaction.toModuleId}`);
    }

    // Classify modules by layer
    const frontend = modules.filter((m) => this.isModuleInLayer(m, 'frontend'));
    const backend = modules.filter((m) => this.isModuleInLayer(m, 'backend'));

    if (frontend.length === 0 || backend.length === 0) {
      return [];
    }

    const systemPrompt = this.buildLogicalInferenceSystemPrompt();
    const userPrompt = this.buildLogicalInferenceUserPrompt(frontend, backend, existingEdges, modules);

    if (showLlmRequests) {
      this.log(chalk.cyan('═'.repeat(60)));
      this.log(chalk.cyan('LLM REQUEST - inferLogicalInteractions'));
      this.log(chalk.gray(systemPrompt));
      this.log(chalk.gray(userPrompt));
    }

    const response = await LLMist.complete(userPrompt, { model, systemPrompt, temperature: 0 });

    if (showLlmResponses) {
      this.log(chalk.green('═'.repeat(60)));
      this.log(chalk.green('LLM RESPONSE'));
      this.log(chalk.gray(response));
    }

    return this.parseLogicalInteractionCSV(response, modules, existingPairs);
  }

  /**
   * Infer targeted interactions for specific uncovered module pairs.
   * These are module pairs with symbol-level relationships but no detected interaction.
   */
  private async inferTargetedInteractions(
    uncoveredPairs: Array<{
      fromModuleId: number;
      toModuleId: number;
      fromPath: string;
      toPath: string;
      relationshipCount: number;
    }>,
    model: string,
    showLlmRequests: boolean,
    showLlmResponses: boolean
  ): Promise<InferredInteraction[]> {
    if (uncoveredPairs.length === 0) return [];

    const systemPrompt = `You are reviewing module pairs that have symbol-level relationships but no detected interaction.
For each pair, determine if a real runtime interaction exists and describe it.

## Output Format
\`\`\`csv
from_module_path,to_module_path,action,reason
project.backend.services.sales,project.backend.data.models.vehicle,CONFIRM,"Sales service updates vehicle availability status on sale completion"
project.shared.types,project.backend.models,SKIP,"Shared type definitions, no runtime interaction"
\`\`\`

For each pair:
- CONFIRM if a real interaction exists (provide a semantic description as reason)
- SKIP if it's an artifact (shared types, transitive dependency, test-only)`;

    const pairDescriptions = uncoveredPairs
      .map((p, i) => `${i + 1}. ${p.fromPath} → ${p.toPath} (${p.relationshipCount} relationships)`)
      .join('\n');

    const userPrompt = `## Module Pairs to Evaluate (${uncoveredPairs.length})

${pairDescriptions}

Evaluate each pair and output CONFIRM or SKIP in CSV format.`;

    if (showLlmRequests) {
      this.log(chalk.cyan('═'.repeat(60)));
      this.log(chalk.cyan('LLM REQUEST - inferTargetedInteractions'));
      this.log(chalk.gray(systemPrompt));
      this.log(chalk.gray(userPrompt));
    }

    const response = await LLMist.complete(userPrompt, { model, systemPrompt, temperature: 0 });

    if (showLlmResponses) {
      this.log(chalk.green('═'.repeat(60)));
      this.log(chalk.green('LLM RESPONSE'));
      this.log(chalk.gray(response));
    }

    // Parse response
    const results: InferredInteraction[] = [];
    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/);
    const csv = csvMatch ? csvMatch[1] : response;

    const pairByPaths = new Map(uncoveredPairs.map((p) => [`${p.fromPath}|${p.toPath}`, p]));

    for (const line of csv.split('\n')) {
      if (!line.trim() || line.startsWith('from_module')) continue;

      const fields = parseCSVLine(line);
      if (fields.length < 4) continue;

      const [fromPath, toPath, action, reason] = fields;

      if (action.trim().toUpperCase() !== 'CONFIRM') continue;

      const pair = pairByPaths.get(`${fromPath.trim()}|${toPath.trim()}`);
      if (!pair) continue;

      results.push({
        fromModuleId: pair.fromModuleId,
        toModuleId: pair.toModuleId,
        reason: reason?.replace(/"/g, '').trim() ?? 'Targeted inference',
      });
    }

    return results;
  }

  /**
   * Determine if a module belongs to frontend or backend layer based on path patterns.
   */
  private isModuleInLayer(module: Module, layer: 'frontend' | 'backend'): boolean {
    const path = module.fullPath.toLowerCase();
    if (layer === 'frontend') {
      return (
        path.includes('frontend') ||
        path.includes('screen') ||
        path.includes('page') ||
        path.includes('hook') ||
        path.includes('component') ||
        path.includes('ui') ||
        path.includes('view') ||
        path.includes('client')
      );
    }
    return (
      path.includes('backend') ||
      path.includes('api') ||
      path.includes('route') ||
      path.includes('controller') ||
      path.includes('handler') ||
      path.includes('server') ||
      path.includes('service') ||
      path.includes('repository') ||
      path.includes('model')
    );
  }

  /**
   * Build system prompt for logical inference.
   */
  private buildLogicalInferenceSystemPrompt(): string {
    return `You identify LOGICAL module connections that exist at runtime but aren't in static analysis.

## Architecture Boundary Rules (CRITICAL)
Frontend and backend are separated by an HTTP boundary. Frontend code makes HTTP requests to backend API endpoints.

VALID cross-boundary connections (frontend → backend):
- Frontend modules → API routes/controllers (the HTTP entry points)
- Example: hooks.data-fetching.sales → api.routes OR api.controllers

INVALID connections (DO NOT INFER):
- Frontend → Backend Services (services are internal to backend, not exposed via HTTP)
- Frontend → Backend Repositories/Data layers (internal to backend)
- Frontend → Backend Models (internal to backend)

## What to Detect
- Frontend screens/hooks calling backend API endpoints via HTTP/fetch
- Only connect frontend to the backend's HTTP boundary (routes, controllers, API)

## Matching Patterns
- Entity names: "useVehicles" hook likely calls "vehicleRoutes" or "vehicleController"
- Data fetching hooks call API endpoints, NOT services directly
- The backend call chain is: Routes → Controllers → Services (internal to backend)

## Entity-Based Matching (IMPORTANT)
When inferring connections, prefer entity-specific targets over generic ones:
- hooks.data-fetching.users → api.controllers.users (if exists)
- hooks.useProducts → api.controllers.products (if exists)
- Only fall back to generic module (e.g., api.controllers) if no entity-specific module exists

Extract entity name from source module path and match to target.

## Output Format
\`\`\`csv
from_module_path,to_module_path,reason,confidence
project.frontend.hooks.useCustomers,project.backend.api.controllers,"Customer data hooks call customer API controllers",high
\`\`\`

Confidence levels:
- high: Names/patterns strongly suggest connection
- medium: Context supports it but names don't match exactly
- Skip low confidence - only report likely connections

DO NOT report:
- Frontend → Services (WRONG: services are internal to backend)
- Frontend → Repositories (WRONG: repos are internal to backend)
- Same-layer connections (frontend→frontend, backend→backend)
- Utility modules (logging, config, etc.)`;
  }

  /**
   * Build user prompt with module lists for logical inference.
   */
  private buildLogicalInferenceUserPrompt(
    frontend: Module[],
    backend: Module[],
    existingEdges: ModuleCallEdge[],
    allModules: Module[]
  ): string {
    const parts: string[] = [];

    parts.push('## Frontend Modules');
    for (const m of frontend) {
      parts.push(`- ${m.fullPath}: ${m.name}${m.description ? ` - ${m.description}` : ''}`);
    }

    parts.push('');
    parts.push('## Backend Modules (grouped by entity)');

    // Group backend modules by entity pattern for better LLM matching
    const entityGroups = groupModulesByEntity(backend);

    for (const [entity, modules] of entityGroups) {
      if (entity === '_generic') {
        parts.push('### Generic/Shared');
      } else {
        parts.push(`### ${entity}-related`);
      }
      for (const m of modules) {
        parts.push(`- ${m.fullPath}: ${m.name}${m.description ? ` - ${m.description}` : ''}`);
      }
      parts.push('');
    }

    parts.push('');
    parts.push('## Existing AST-Detected Connections (for reference)');
    const crossLayerEdges = existingEdges.filter((e) => {
      const from = allModules.find((m) => m.id === e.fromModuleId);
      const to = allModules.find((m) => m.id === e.toModuleId);
      return from && to && this.isModuleInLayer(from, 'frontend') !== this.isModuleInLayer(to, 'frontend');
    });

    if (crossLayerEdges.length === 0) {
      parts.push('(None detected - this is why we need inference!)');
    } else {
      for (const e of crossLayerEdges) {
        const from = allModules.find((m) => m.id === e.fromModuleId);
        const to = allModules.find((m) => m.id === e.toModuleId);
        if (from && to) {
          parts.push(`- ${from.fullPath} → ${to.fullPath}`);
        }
      }
    }

    parts.push('');
    parts.push('Identify frontend→backend logical connections that likely exist at runtime.');

    return parts.join('\n');
  }

  /**
   * Parse the LLM response CSV into inferred interactions.
   */
  private parseLogicalInteractionCSV(
    response: string,
    modules: Module[],
    existingPairs: Set<string>
  ): InferredInteraction[] {
    const results: InferredInteraction[] = [];
    const moduleByPath = new Map(modules.map((m) => [m.fullPath, m]));

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/);
    const csv = csvMatch ? csvMatch[1] : response;

    for (const line of csv.split('\n')) {
      if (!line.trim() || line.startsWith('from_module')) continue;

      const fields = parseCSVLine(line);
      if (fields.length < 4) continue;

      const [fromPath, toPath, reason, confidence] = fields;

      const fromModule = moduleByPath.get(fromPath.trim());
      const toModule = moduleByPath.get(toPath.trim());

      if (!fromModule || !toModule) continue;
      if (confidence.trim().toLowerCase() === 'low') continue;

      const pairKey = `${fromModule.id}->${toModule.id}`;
      if (existingPairs.has(pairKey)) continue; // Skip duplicates

      results.push({
        fromModuleId: fromModule.id,
        toModuleId: toModule.id,
        reason: reason?.replace(/"/g, '').trim() ?? 'LLM inferred connection',
      });

      // Mark as processed to avoid duplicates within this batch
      existingPairs.add(pairKey);
    }

    return results;
  }
}
