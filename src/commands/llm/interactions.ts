import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import type { EnrichedModuleCallEdge } from '../../db/schema.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';

interface InteractionSuggestion {
  fromModuleId: number;
  toModuleId: number;
  fromModulePath: string;
  toModulePath: string;
  semantic: string;
  pattern: 'utility' | 'business';
  symbols: string[];
  weight: number;
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
      default: 'sonnet',
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
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Interactions);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;
    const model = flags.model;
    const batchSize = flags['batch-size'];

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
          const message = error instanceof Error ? error.message : String(error);
          if (!isJson) {
            this.log(chalk.yellow(`  Batch ${Math.floor(i / batchSize) + 1} failed: ${message}`));
          }
          // Fall back to auto-generated semantics
          for (const edge of batch) {
            interactions.push(this.createDefaultInteraction(edge));
          }
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

      // Get relationship coverage
      const relCoverage = db.getRelationshipCoverage();

      // Output results
      const result = {
        totalEdges: enrichedEdges.length,
        interactions: interactions.length,
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
        this.log(`Interactions created: ${result.interactions}`);
        this.log(`  Business: ${businessCount}`);
        this.log(`  Utility: ${utilityCount}`);

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
        const symbolList = e.calledSymbols
          .slice(0, 5)
          .map((s) => s.name)
          .join(', ');
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
      const fields = this.parseCSVLine(line);
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

  /**
   * Parse a CSV line handling quoted fields.
   */
  private parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);

    return fields;
  }
}
