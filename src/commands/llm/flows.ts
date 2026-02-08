import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import type { IndexDatabase } from '../../db/database.js';
import type { FlowStakeholder, InteractionWithPaths } from '../../db/schema.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';

interface RootDefinition {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  purpose: string | null;
  role: string | null;
  outgoingCount: number;
}

interface EntryPointClassification {
  definitionId: number;
  isEntryPoint: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

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
          this.log(
            JSON.stringify({
              error: 'Flows already exist',
              count: existingCount,
              hint: 'Use --force to re-detect',
            })
          );
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

      // Step 1: Detect entry points using LLM classification
      if (!isJson) {
        this.log(chalk.bold('Step 1: Detecting Entry Points (LLM Classification)'));
      }

      const entryPoints = await this.detectEntryPoints(db, model, verbose, isJson);

      if (!isJson && verbose) {
        this.log(chalk.gray(`Found ${entryPoints.length} LLM-classified entry points`));
      }

      if (entryPoints.length === 0) {
        if (!isJson) {
          this.log(chalk.yellow('No entry points detected.'));
          this.log(chalk.gray('Gap flows will still be created for uncovered interactions.'));
        }
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
            interactionIds: path.map((i) => i.id),
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

      // Step 4: Create gap flows for uncovered interactions
      if (!isJson) {
        this.log('');
        this.log(chalk.bold('Step 4: Creating Gap Flows for Uncovered Interactions'));
      }

      const coveredIds = new Set(enhancedFlows.flatMap((f) => f.interactionIds));
      const gapFlows = this.createGapFlows(coveredIds, interactions);
      enhancedFlows.push(...gapFlows);

      if (!isJson && verbose) {
        this.log(chalk.gray(`Created ${gapFlows.length} gap flows for uncovered interactions`));
      }

      // Step 5: Persist flows
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

      // Count user vs internal flows
      const userFlowCount = enhancedFlows.filter((f) => f.entryPointId !== null).length;
      const internalFlowCount = gapFlows.length;

      // Output results
      const result = {
        entryPoints: entryPoints.length,
        flowsCreated: enhancedFlows.length,
        userFlows: userFlowCount,
        internalFlows: internalFlowCount,
        coverage: dryRun
          ? {
              totalInteractions: interactions.length,
              coveredByFlows: new Set(enhancedFlows.flatMap((f) => f.interactionIds)).size,
              percentage: (new Set(enhancedFlows.flatMap((f) => f.interactionIds)).size / interactions.length) * 100,
            }
          : db.getFlowCoverage(),
      };

      if (isJson) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        this.log('');
        this.log(chalk.bold('Results'));
        this.log(`Entry points detected: ${result.entryPoints} (LLM classified)`);
        this.log(`Flows created: ${result.flowsCreated}`);
        this.log(`  - User flows: ${result.userFlows}`);
        this.log(`  - Internal/gap flows: ${result.internalFlows}`);
        this.log(
          `Interaction coverage: ${result.coverage.coveredByFlows}/${result.coverage.totalInteractions} (${result.coverage.percentage.toFixed(1)}%)`
        );

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
   * Detect potential entry points in the codebase using LLM classification.
   * Entry points are exported symbols that are not called by other internal code.
   */
  private async detectEntryPoints(
    db: IndexDatabase,
    model: string,
    verbose: boolean,
    isJson: boolean
  ): Promise<EntryPointInfo[]> {
    const rootDefs = db.getRootDefinitions();

    // Build rich candidate info for LLM
    const candidates: RootDefinition[] = [];
    for (const def of rootDefs) {
      const metadata = db.getDefinitionMetadata(def.id);
      const deps = db.getDefinitionDependencies(def.id);

      candidates.push({
        id: def.id,
        name: def.name,
        kind: def.kind,
        filePath: def.filePath,
        line: def.line,
        purpose: metadata.purpose ?? null,
        role: metadata.role ?? null,
        outgoingCount: deps.length,
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    // Classify with LLM
    let classifications: EntryPointClassification[];
    try {
      classifications = await this.classifyEntryPoints(candidates, model);
      if (verbose && !isJson) {
        const entryCount = classifications.filter((c) => c.isEntryPoint).length;
        this.log(chalk.gray(`  LLM classified ${entryCount}/${candidates.length} as entry points`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isJson) {
        this.log(chalk.yellow(`  LLM classification failed: ${message}`));
        this.log(chalk.gray('  Falling back to heuristic detection'));
      }
      // Fallback to simple heuristics
      classifications = candidates.map((c) => ({
        definitionId: c.id,
        isEntryPoint: this.isLikelyEntryPointHeuristic(c),
        confidence: 'low' as const,
        reason: 'Heuristic fallback',
      }));
    }

    // Build entry points from classifications
    const entryPoints: EntryPointInfo[] = [];
    for (const classification of classifications) {
      if (!classification.isEntryPoint) continue;

      const def = candidates.find((c) => c.id === classification.definitionId);
      if (!def) continue;

      const moduleInfo = db.getDefinitionModule(def.id);
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

    return entryPoints;
  }

  /**
   * Use LLM to classify root definitions as entry points.
   */
  private async classifyEntryPoints(candidates: RootDefinition[], model: string): Promise<EntryPointClassification[]> {
    const systemPrompt = `You are classifying code symbols as entry points or internal helpers.

Entry points are:
- Functions/methods that initiate user journeys (API handlers, event listeners, CLI commands)
- Public interface functions that external code would call
- Test setup/teardown functions
- Initialization and configuration functions
- Command handlers and route handlers
- Main execution entry points

Internal helpers are:
- Private utilities called by other internal code
- Pure transformation functions
- Low-level implementation details
- Type definitions and interfaces (unless they define public APIs)
- Constants and configuration values

Classify each candidate. Output ONLY a CSV table:

\`\`\`csv
id,is_entry_point,confidence,reason
42,true,high,"API route handler for user creation"
87,false,high,"Internal helper for password hashing"
\`\`\`

Guidelines:
- Be generous with entry point classification - when in doubt, mark as entry point
- Anything that looks like a handler, command, or public interface is an entry point
- Only mark as NOT entry point if clearly internal/utility`;

    // Build candidate descriptions
    const candidateList = candidates
      .map((c) => {
        let desc = `${c.id}: ${c.name} (${c.kind}) in ${c.filePath}:${c.line}`;
        if (c.purpose) desc += `\n   Purpose: ${c.purpose}`;
        if (c.role) desc += `\n   Role: ${c.role}`;
        desc += `\n   Outgoing deps: ${c.outgoingCount}`;
        return desc;
      })
      .join('\n\n');

    const userPrompt = `## Candidates to Classify (${candidates.length})

${candidateList}

Classify each as entry point or internal helper.`;

    const response = await LLMist.complete(userPrompt, {
      model,
      systemPrompt,
      temperature: 0,
    });

    return this.parseEntryPointCSV(response, candidates);
  }

  /**
   * Parse LLM response for entry point classifications.
   */
  private parseEntryPointCSV(response: string, candidates: RootDefinition[]): EntryPointClassification[] {
    const results: EntryPointClassification[] = [];

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('id,'));

    const candidateMap = new Map(candidates.map((c) => [c.id, c]));

    for (const line of lines) {
      const fields = this.parseCSVLine(line);
      if (fields.length < 4) continue;

      const id = Number.parseInt(fields[0].trim(), 10);
      if (!candidateMap.has(id)) continue;

      const isEntryPoint = fields[1].trim().toLowerCase() === 'true';
      const confidence = fields[2].trim().toLowerCase() as 'high' | 'medium' | 'low';
      const reason = fields[3].trim().replace(/"/g, '');

      results.push({
        definitionId: id,
        isEntryPoint,
        confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'medium',
        reason,
      });
    }

    // Add fallback for any candidates not in response
    for (const candidate of candidates) {
      if (!results.find((r) => r.definitionId === candidate.id)) {
        results.push({
          definitionId: candidate.id,
          isEntryPoint: this.isLikelyEntryPointHeuristic(candidate),
          confidence: 'low',
          reason: 'Not in LLM response, using heuristic',
        });
      }
    }

    return results;
  }

  /**
   * Simple heuristic fallback for entry point detection.
   */
  private isLikelyEntryPointHeuristic(candidate: RootDefinition): boolean {
    const name = candidate.name.toLowerCase();
    const kind = candidate.kind;

    // Handler patterns
    if (name.startsWith('handle') || name.endsWith('handler')) return true;
    if (name.startsWith('on') && name.length > 2) return true;
    if (name.endsWith('controller') || name.endsWith('listener')) return true;

    // Route/API patterns
    if (name.includes('route') || name.includes('api') || name.includes('endpoint')) return true;

    // Command patterns
    if (name.includes('command') || name.includes('action')) return true;

    // Main/index exports
    if (name === 'default' || name === 'main' || name === 'run' || name === 'execute') return true;

    // Classes with handler/controller suffix
    if (kind === 'class' && (name.endsWith('controller') || name.endsWith('handler'))) return true;

    // Role-based detection
    if (candidate.role === 'entry-point' || candidate.role === 'handler') return true;

    return false;
  }

  /**
   * Trace a flow from a starting module through interactions.
   * Includes ALL interactions (including utility) since they are part of user journeys.
   */
  private traceFlow(
    startModuleId: number,
    interactionsByFromModule: Map<number, InteractionWithPaths[]>
  ): InteractionWithPaths[] {
    const visited = new Set<number>();
    const path: InteractionWithPaths[] = [];
    const maxDepth = 50; // Increased from 10 for deep call chains

    const trace = (moduleId: number, depth: number): void => {
      if (depth >= maxDepth) return;
      if (visited.has(moduleId)) return;
      visited.add(moduleId);

      const outgoing = interactionsByFromModule.get(moduleId) ?? [];
      for (const interaction of outgoing) {
        // Include ALL interactions (utility + business) - they're all part of user journeys
        path.push(interaction);
        trace(interaction.toModuleId, depth + 1);
      }
    };

    trace(startModuleId, 0);
    return path;
  }

  /**
   * Create gap flows for interactions not covered by entry point flows.
   * Groups uncovered interactions by source module and creates internal flows.
   */
  private createGapFlows(coveredIds: Set<number>, allInteractions: InteractionWithPaths[]): FlowSuggestion[] {
    const uncovered = allInteractions.filter((i) => !coveredIds.has(i.id));
    if (uncovered.length === 0) return [];

    // Group uncovered interactions by source module
    const bySource = new Map<number, InteractionWithPaths[]>();
    for (const i of uncovered) {
      const list = bySource.get(i.fromModuleId) ?? [];
      list.push(i);
      bySource.set(i.fromModuleId, list);
    }

    // Create "internal" flows for each cluster
    const gapFlows: FlowSuggestion[] = [];
    for (const [, interactions] of bySource) {
      const modulePath = interactions[0].fromModulePath;
      const shortName = modulePath.split('.').pop() ?? 'Module';

      // Convert to PascalCase for flow name
      const flowName = `${shortName.charAt(0).toUpperCase() + shortName.slice(1)}InternalFlow`;
      const slug = `${shortName.toLowerCase()}-internal`;

      gapFlows.push({
        name: flowName,
        slug: slug,
        entryPointId: null,
        entryPath: `Internal: ${modulePath}`,
        stakeholder: 'developer', // Internal, not user-facing
        description: `Internal interactions originating from ${modulePath}`,
        interactionIds: interactions.map((i) => i.id),
      });
    }

    return gapFlows;
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
    const interactionMap = new Map(interactions.map((i) => [i.id, i]));

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
    const flowDescriptions = flows
      .map((f, i) => {
        const steps = f.interactionIds
          .slice(0, 5)
          .map((id) => {
            const interaction = interactionMap.get(id);
            return interaction ? `${interaction.fromModulePath} → ${interaction.toModulePath}` : '?';
          })
          .join(' → ');

        return `${i + 1}. Entry: ${f.entryPath}\n   Steps: ${steps}`;
      })
      .join('\n\n');

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

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('entry_point'));

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
