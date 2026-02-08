import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import { openDatabase, SharedFlags } from '../_shared/index.js';
import type { IndexDatabase } from '../../db/database.js';
import type { InteractionWithPaths, FlowStakeholder } from '../../db/schema.js';

interface EntryPointInfo {
  definitionId: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  moduleId: number | null;
  modulePath: string | null;
}

interface FlowSuggestion {
  name: string;
  slug: string;
  entryPointId: number | null;
  entryPath: string;
  stakeholder: FlowStakeholder;
  description: string;
  interactionIds: number[];
}

export default class Flows extends Command {
  static override description = 'Detect user journey flows from entry points and trace through interactions';

  static override examples = [
    '<%= config.bin %> llm flows',
    '<%= config.bin %> llm flows --dry-run',
    '<%= config.bin %> llm flows --force',
    '<%= config.bin %> llm flows -d index.db --verbose',
  ];

  static override flags = {
    database: SharedFlags.database,

    // LLM options
    model: Flags.string({
      char: 'm',
      description: 'LLM model alias',
      default: 'sonnet',
    }),

    // Output options
    'dry-run': Flags.boolean({
      description: 'Show results without persisting',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Re-detect even if flows exist',
      default: false,
    }),
    json: SharedFlags.json,
    verbose: Flags.boolean({
      description: 'Show detailed progress',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Flows);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;
    const model = flags.model;

    try {
      // Check if flows already exist
      const existingCount = db.getFlowCount();
      if (existingCount > 0 && !flags.force) {
        if (isJson) {
          this.log(JSON.stringify({
            error: 'Flows already exist',
            count: existingCount,
            hint: 'Use --force to re-detect',
          }));
        } else {
          this.log(chalk.yellow(`${existingCount} flows already exist.`));
          this.log(chalk.gray('Use --force to re-detect flows.'));
        }
        return;
      }

      // Check if interactions exist
      const interactionCount = db.getInteractionCount();
      if (interactionCount === 0) {
        if (isJson) {
          this.log(JSON.stringify({ error: 'No interactions found', hint: 'Run llm interactions first' }));
        } else {
          this.log(chalk.yellow('No interactions found.'));
          this.log(chalk.gray('Run `ats llm interactions` first to detect module interactions.'));
        }
        return;
      }

      if (!isJson) {
        this.log(chalk.bold('Flow Detection'));
        this.log(chalk.gray(`Model: ${model}`));
        this.log('');
      }

      // Clear existing flows if force
      if (existingCount > 0 && flags.force && !dryRun) {
        db.clearFlows();
        if (!isJson && verbose) {
          this.log(chalk.gray(`Cleared ${existingCount} existing flows`));
        }
      }

      // Step 1: Detect entry points
      if (!isJson) {
        this.log(chalk.bold('Step 1: Detecting Entry Points'));
      }

      const entryPoints = this.detectEntryPoints(db);

      if (!isJson && verbose) {
        this.log(chalk.gray(`Found ${entryPoints.length} potential entry points`));
      }

      if (entryPoints.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ error: 'No entry points found' }));
        } else {
          this.log(chalk.yellow('No entry points detected.'));
        }
        return;
      }

      // Step 2: Trace flows from entry points
      if (!isJson) {
        this.log('');
        this.log(chalk.bold('Step 2: Tracing Flows from Entry Points'));
      }

      const interactions = db.getAllInteractions();
      const flowSuggestions: FlowSuggestion[] = [];

      // Build interaction lookup by module
      const interactionsByFromModule = new Map<number, InteractionWithPaths[]>();
      for (const interaction of interactions) {
        const list = interactionsByFromModule.get(interaction.fromModuleId) ?? [];
        list.push(interaction);
        interactionsByFromModule.set(interaction.fromModuleId, list);
      }

      // Trace flow for each entry point
      for (const entryPoint of entryPoints) {
        if (!entryPoint.moduleId) continue;

        const path = this.traceFlow(entryPoint.moduleId, interactionsByFromModule);

        if (path.length > 0) {
          flowSuggestions.push({
            name: this.generateFlowName(entryPoint),
            slug: this.generateFlowSlug(entryPoint),
            entryPointId: entryPoint.definitionId,
            entryPath: `${entryPoint.name} (${entryPoint.filePath}:${entryPoint.line})`,
            stakeholder: this.inferStakeholder(entryPoint),
            description: `Flow starting from ${entryPoint.name}`,
            interactionIds: path.map(i => i.id),
          });
        }
      }

      if (!isJson && verbose) {
        this.log(chalk.gray(`Traced ${flowSuggestions.length} potential flows`));
      }

      // Step 3: Use LLM to enhance flow metadata
      if (!isJson) {
        this.log('');
        this.log(chalk.bold('Step 3: Enhancing Flow Metadata with LLM'));
      }

      let enhancedFlows: FlowSuggestion[] = [];
      if (flowSuggestions.length > 0) {
        try {
          enhancedFlows = await this.enhanceFlowsWithLLM(flowSuggestions, interactions, model);
          if (!isJson && verbose) {
            this.log(chalk.gray(`Enhanced ${enhancedFlows.length} flows`));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isJson) {
            this.log(chalk.yellow(`LLM enhancement failed: ${message}`));
          }
          enhancedFlows = flowSuggestions;
        }
      }

      // Step 4: Persist flows
      if (!dryRun && enhancedFlows.length > 0) {
        const usedSlugs = new Set<string>();

        for (const flow of enhancedFlows) {
          let slug = flow.slug;
          let counter = 1;
          while (usedSlugs.has(slug)) {
            slug = `${flow.slug}-${counter++}`;
          }
          usedSlugs.add(slug);

          try {
            const flowId = db.insertFlow(flow.name, slug, {
              entryPointId: flow.entryPointId ?? undefined,
              entryPath: flow.entryPath,
              stakeholder: flow.stakeholder,
              description: flow.description,
            });

            // Add steps
            if (flow.interactionIds.length > 0) {
              db.addFlowSteps(flowId, flow.interactionIds);
            }
          } catch (e) {
            if (verbose && !isJson) {
              this.log(chalk.yellow(`  Skipping flow: ${flow.name}`));
            }
          }
        }
      }

      // Output results
      const result = {
        entryPoints: entryPoints.length,
        flowsCreated: enhancedFlows.length,
        coverage: db.getFlowCoverage(),
      };

      if (isJson) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        this.log('');
        this.log(chalk.bold('Results'));
        this.log(`Entry points detected: ${result.entryPoints}`);
        this.log(`Flows created: ${result.flowsCreated}`);
        this.log(`Interaction coverage: ${result.coverage.coveredByFlows}/${result.coverage.totalInteractions} (${result.coverage.percentage.toFixed(1)}%)`);

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
   * Detect potential entry points in the codebase.
   * Entry points are exported symbols that are not called by other internal code.
   */
  private detectEntryPoints(db: IndexDatabase): EntryPointInfo[] {
    const rootDefs = db.getRootDefinitions();
    const entryPoints: EntryPointInfo[] = [];

    for (const def of rootDefs) {
      // Get module info for this definition
      const moduleInfo = db.getDefinitionModule(def.id);

      // Filter to likely entry points based on patterns
      const isLikelyEntryPoint = this.isLikelyEntryPoint(def.name, def.kind);

      if (isLikelyEntryPoint) {
        entryPoints.push({
          definitionId: def.id,
          name: def.name,
          kind: def.kind,
          filePath: def.filePath,
          line: def.line,
          moduleId: moduleInfo?.module?.id ?? null,
          modulePath: moduleInfo?.module?.fullPath ?? null,
        });
      }
    }

    return entryPoints;
  }

  /**
   * Check if a symbol is likely to be an entry point.
   */
  private isLikelyEntryPoint(name: string, kind: string): boolean {
    // Handler patterns
    const handlerPatterns = [
      /^handle[A-Z]/,
      /Handler$/,
      /^on[A-Z]/,
      /Listener$/,
      /Controller$/,
      /^route/i,
      /^api/i,
      /^endpoint/i,
      /^command/i,
      /^action/i,
    ];

    // Check name patterns
    for (const pattern of handlerPatterns) {
      if (pattern.test(name)) return true;
    }

    // Check kind
    if (kind === 'class' && (name.endsWith('Controller') || name.endsWith('Handler'))) {
      return true;
    }

    // Main/index exports
    if (name === 'default' || name === 'main' || name === 'run' || name === 'execute') {
      return true;
    }

    return false;
  }

  /**
   * Trace a flow from a starting module through interactions.
   */
  private traceFlow(
    startModuleId: number,
    interactionsByFromModule: Map<number, InteractionWithPaths[]>
  ): InteractionWithPaths[] {
    const visited = new Set<number>();
    const path: InteractionWithPaths[] = [];
    const maxDepth = 10;

    const trace = (moduleId: number, depth: number): void => {
      if (depth >= maxDepth) return;
      if (visited.has(moduleId)) return;
      visited.add(moduleId);

      const outgoing = interactionsByFromModule.get(moduleId) ?? [];
      for (const interaction of outgoing) {
        // Skip utility interactions for flow tracing (they're infrastructure)
        if (interaction.pattern === 'utility') continue;

        path.push(interaction);
        trace(interaction.toModuleId, depth + 1);
      }
    };

    trace(startModuleId, 0);
    return path;
  }

  /**
   * Generate a flow name from an entry point.
   */
  private generateFlowName(entryPoint: EntryPointInfo): string {
    // Convert handler names to flow names
    let name = entryPoint.name;

    // Remove common prefixes/suffixes
    name = name.replace(/^handle/, '');
    name = name.replace(/Handler$/, '');
    name = name.replace(/Controller$/, '');
    name = name.replace(/^on/, '');

    // Add "Flow" suffix if not present
    if (!name.endsWith('Flow')) {
      name = `${name}Flow`;
    }

    return name;
  }

  /**
   * Generate a slug from an entry point.
   */
  private generateFlowSlug(entryPoint: EntryPointInfo): string {
    return this.generateFlowName(entryPoint)
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }

  /**
   * Infer stakeholder from entry point context.
   */
  private inferStakeholder(entryPoint: EntryPointInfo): FlowStakeholder {
    const name = entryPoint.name.toLowerCase();
    const path = entryPoint.filePath.toLowerCase();

    if (path.includes('admin') || name.includes('admin')) return 'admin';
    if (path.includes('api') || path.includes('route')) return 'external';
    if (path.includes('cron') || path.includes('job') || path.includes('worker')) return 'system';
    if (path.includes('cli') || path.includes('command')) return 'developer';

    return 'user';
  }

  /**
   * Enhance flows with LLM-generated metadata.
   */
  private async enhanceFlowsWithLLM(
    flows: FlowSuggestion[],
    interactions: InteractionWithPaths[],
    model: string
  ): Promise<FlowSuggestion[]> {
    const interactionMap = new Map(interactions.map(i => [i.id, i]));

    const systemPrompt = `You are a software architect naming and describing user journey flows.

For each flow (defined by its entry point and interaction sequence), provide:
1. A clear, user-focused name (PascalCase with "Flow" suffix)
2. A concise description of what the flow accomplishes

Output format - respond with ONLY a CSV table:

\`\`\`csv
entry_point,name,description
handleLogin,"UserLoginFlow","Authenticates user credentials and establishes a session"
\`\`\`

Guidelines:
- Name flows after the USER GOAL, not implementation details
- Descriptions should explain WHAT the user accomplishes
- Keep descriptions under 80 characters`;

    // Build flow descriptions
    const flowDescriptions = flows.map((f, i) => {
      const steps = f.interactionIds
        .slice(0, 5)
        .map(id => {
          const interaction = interactionMap.get(id);
          return interaction ? `${interaction.fromModulePath} → ${interaction.toModulePath}` : '?';
        })
        .join(' → ');

      return `${i + 1}. Entry: ${f.entryPath}\n   Steps: ${steps}`;
    }).join('\n\n');

    const userPrompt = `## Flows to Enhance (${flows.length})

${flowDescriptions}

Provide enhanced names and descriptions for each flow in CSV format.`;

    const response = await LLMist.complete(userPrompt, {
      model,
      systemPrompt,
      temperature: 0,
    });

    return this.parseEnhancedFlowsCSV(response, flows);
  }

  /**
   * Parse LLM response for enhanced flows.
   */
  private parseEnhancedFlowsCSV(response: string, originalFlows: FlowSuggestion[]): FlowSuggestion[] {
    const results: FlowSuggestion[] = [];

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) ||
      response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter(l => l.trim() && !l.startsWith('entry_point'));

    for (let i = 0; i < originalFlows.length; i++) {
      const original = originalFlows[i];

      if (i < lines.length) {
        const fields = this.parseCSVLine(lines[i]);
        if (fields.length >= 3) {
          results.push({
            ...original,
            name: fields[1].trim().replace(/"/g, '') || original.name,
            description: fields[2].trim().replace(/"/g, '') || original.description,
          });
          continue;
        }
      }

      results.push(original);
    }

    return results;
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
