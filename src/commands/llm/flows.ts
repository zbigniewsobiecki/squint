import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import type { IndexDatabase } from '../../db/database.js';
import type { FlowStakeholder, InteractionWithPaths } from '../../db/schema.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';

interface ModuleCandidate {
  id: number;
  fullPath: string;
  name: string;
  description: string | null;
  depth: number;
  memberCount: number;
  members: Array<{ definitionId: number; name: string; kind: string }>;
}

interface EntryPointModuleClassification {
  moduleId: number;
  isEntryPoint: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

interface EntryPointModuleInfo {
  moduleId: number;
  modulePath: string;
  moduleName: string;
  memberDefinitions: Array<{ id: number; name: string; kind: string }>;
}

interface TracedDefinitionStep {
  fromDefinitionId: number;
  toDefinitionId: number;
  fromModuleId: number | null;
  toModuleId: number | null;
}

interface FlowSuggestion {
  name: string;
  slug: string;
  entryPointModuleId: number | null;
  entryPointId: number | null;
  entryPath: string;
  stakeholder: FlowStakeholder;
  description: string;
  interactionIds: number[];
  definitionSteps: TracedDefinitionStep[];
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

      // Step 1: Detect entry point MODULES using LLM classification
      if (!isJson) {
        this.log(chalk.bold('Step 1: Detecting Entry Point Modules (LLM Classification)'));
      }

      const entryPointModules = await this.detectEntryPointModules(db, model, verbose, isJson);

      if (!isJson && verbose) {
        this.log(chalk.gray(`Found ${entryPointModules.length} LLM-classified entry point modules`));
      }

      if (entryPointModules.length === 0) {
        if (!isJson) {
          this.log(chalk.yellow('No entry point modules detected.'));
          this.log(chalk.gray('Gap flows will still be created for uncovered interactions.'));
        }
      }

      // Step 2: Trace flows from entry point modules using definition-level call graph
      if (!isJson) {
        this.log('');
        this.log(chalk.bold('Step 2: Tracing Flows from Entry Point Modules (Definition-Level)'));
      }

      const interactions = db.getAllInteractions();
      const flowSuggestions: FlowSuggestion[] = [];

      // Build definition-level call graph
      const definitionCallGraph = db.getDefinitionCallGraphMap();

      // Build definition-to-module lookup
      const defToModule = new Map<number, { moduleId: number; modulePath: string }>();
      const allModulesWithMembers = db.getAllModulesWithMembers();
      for (const mod of allModulesWithMembers) {
        for (const member of mod.members) {
          defToModule.set(member.definitionId, { moduleId: mod.id, modulePath: mod.fullPath });
        }
      }

      // Build interaction lookup for module pairs (for deriving interactionIds)
      const interactionByModulePair = new Map<string, number>();
      for (const interaction of interactions) {
        const key = `${interaction.fromModuleId}->${interaction.toModuleId}`;
        interactionByModulePair.set(key, interaction.id);
      }

      // Trace flow for each definition within entry point modules
      for (const entryPointModule of entryPointModules) {
        // Create a flow for each member definition in the entry point module
        for (const member of entryPointModule.memberDefinitions) {
          const definitionSteps = this.traceDefinitionFlow(member.id, definitionCallGraph, defToModule);

          if (definitionSteps.length > 0) {
            // Derive unique interaction IDs from cross-module definition steps
            const derivedInteractionIds = this.deriveInteractionIds(definitionSteps, interactionByModulePair);

            flowSuggestions.push({
              name: this.generateFlowNameFromModule(entryPointModule, member),
              slug: this.generateFlowSlugFromModule(entryPointModule, member),
              entryPointModuleId: entryPointModule.moduleId,
              entryPointId: member.id,
              entryPath: `${entryPointModule.modulePath}.${member.name}`,
              stakeholder: this.inferStakeholderFromModule(entryPointModule),
              description: `Flow starting from ${member.name} in ${entryPointModule.modulePath}`,
              interactionIds: derivedInteractionIds,
              definitionSteps,
            });
          }
        }
      }

      if (!isJson && verbose) {
        this.log(chalk.gray(`Traced ${flowSuggestions.length} potential flows with definition-level steps`));
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
              entryPointModuleId: flow.entryPointModuleId ?? undefined,
              entryPointId: flow.entryPointId ?? undefined,
              entryPath: flow.entryPath,
              stakeholder: flow.stakeholder,
              description: flow.description,
            });

            // Add module-level steps (for backward compatibility / architecture views)
            if (flow.interactionIds.length > 0) {
              db.addFlowSteps(flowId, flow.interactionIds);
            }

            // Add definition-level steps (for accurate user story tracing)
            if (flow.definitionSteps.length > 0) {
              db.addFlowDefinitionSteps(
                flowId,
                flow.definitionSteps.map((s) => ({
                  fromDefinitionId: s.fromDefinitionId,
                  toDefinitionId: s.toDefinitionId,
                }))
              );
            }
          } catch (e) {
            if (verbose && !isJson) {
              this.log(chalk.yellow(`  Skipping flow: ${flow.name}`));
            }
          }
        }
      }

      // Count user vs internal flows
      const userFlowCount = enhancedFlows.filter((f) => f.entryPointModuleId !== null).length;
      const internalFlowCount = gapFlows.length;

      // Output results
      const result = {
        entryPointModules: entryPointModules.length,
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
        this.log(`Entry point modules detected: ${result.entryPointModules} (LLM classified)`);
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
   * Detect entry point MODULES in the codebase using LLM classification.
   * Entry point modules are modules where execution originates from external triggers
   * (pages, screens, API handlers, CLI commands, etc.)
   */
  private async detectEntryPointModules(
    db: IndexDatabase,
    model: string,
    verbose: boolean,
    isJson: boolean
  ): Promise<EntryPointModuleInfo[]> {
    const allModulesWithMembers = db.getAllModulesWithMembers();

    // Build module candidates (only leaf modules with members)
    const candidates: ModuleCandidate[] = [];
    for (const mod of allModulesWithMembers) {
      if (mod.members.length === 0) continue;

      candidates.push({
        id: mod.id,
        fullPath: mod.fullPath,
        name: mod.name,
        description: mod.description,
        depth: mod.depth,
        memberCount: mod.members.length,
        members: mod.members.map((m) => ({
          definitionId: m.definitionId,
          name: m.name,
          kind: m.kind,
        })),
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    // Classify with LLM
    let classifications: EntryPointModuleClassification[];
    try {
      classifications = await this.classifyModulesAsEntryPoints(candidates, model);
      if (verbose && !isJson) {
        const entryCount = classifications.filter((c) => c.isEntryPoint).length;
        this.log(chalk.gray(`  LLM classified ${entryCount}/${candidates.length} modules as entry points`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isJson) {
        this.log(chalk.yellow(`  LLM classification failed: ${message}`));
        this.log(chalk.gray('  Falling back to heuristic detection'));
      }
      // Fallback to simple heuristics based on module path
      classifications = candidates.map((c) => ({
        moduleId: c.id,
        isEntryPoint: this.isLikelyEntryPointModuleHeuristic(c),
        confidence: 'low' as const,
        reason: 'Heuristic fallback',
      }));
    }

    // Build entry point modules from classifications
    const entryPointModules: EntryPointModuleInfo[] = [];
    for (const classification of classifications) {
      if (!classification.isEntryPoint) continue;

      const mod = candidates.find((c) => c.id === classification.moduleId);
      if (!mod) continue;

      entryPointModules.push({
        moduleId: mod.id,
        modulePath: mod.fullPath,
        moduleName: mod.name,
        memberDefinitions: mod.members.map((m) => ({
          id: m.definitionId,
          name: m.name,
          kind: m.kind,
        })),
      });
    }

    return entryPointModules;
  }

  /**
   * Use LLM to classify MODULES as entry point modules.
   */
  private async classifyModulesAsEntryPoints(
    candidates: ModuleCandidate[],
    model: string
  ): Promise<EntryPointModuleClassification[]> {
    const systemPrompt = `You are classifying code MODULES as entry point modules or internal modules.

Entry point modules are where execution originates from external triggers:
- User navigation (pages, screens, views)
- API/HTTP requests (route handlers, controllers)
- CLI invocation (commands)
- External events (webhooks, message handlers)
- Main entry points (index files that bootstrap the app)

Internal modules are called BY entry points, they don't originate execution:
- Utility modules (helpers, utils, common)
- Service modules (internal business logic)
- Data access modules (repositories, models)
- Infrastructure modules (config, logging, etc.)

Classify each module based on its PURPOSE and ROLE in the architecture, not individual symbols.
The module path tells you a lot - "screens.login" is clearly a user-facing entry point.

Output ONLY a CSV table:

\`\`\`csv
module_id,is_entry_point,confidence,reason
42,true,high,"User-facing screen module"
87,false,high,"Internal data access layer"
\`\`\`

Guidelines:
- Focus on the MODULE's role, not individual functions within it
- Modules containing pages/screens/routes are entry points
- Modules with "api", "routes", "handlers", "commands" in their path are entry points
- Modules with "utils", "helpers", "lib", "common", "shared" are internal
- When in doubt, check what the module contains to infer its purpose`;

    // Build module descriptions for LLM
    const moduleList = candidates
      .map((m) => {
        let desc = `${m.id}: ${m.fullPath}`;
        if (m.description) desc += `\n   Description: ${m.description}`;
        desc += `\n   Name: ${m.name}`;
        desc += `\n   Members (${m.memberCount}): ${m.members
          .slice(0, 5)
          .map((mem) => `${mem.name} (${mem.kind})`)
          .join(', ')}`;
        if (m.members.length > 5) desc += `, ... and ${m.members.length - 5} more`;
        return desc;
      })
      .join('\n\n');

    const userPrompt = `## Modules to Classify (${candidates.length})

${moduleList}

Classify each module as entry point module or internal module.`;

    const response = await LLMist.complete(userPrompt, {
      model,
      systemPrompt,
      temperature: 0,
    });

    return this.parseModuleClassificationCSV(response, candidates);
  }

  /**
   * Parse LLM response for module classifications.
   */
  private parseModuleClassificationCSV(
    response: string,
    candidates: ModuleCandidate[]
  ): EntryPointModuleClassification[] {
    const results: EntryPointModuleClassification[] = [];

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('module_id,'));

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
        moduleId: id,
        isEntryPoint,
        confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'medium',
        reason,
      });
    }

    // Add fallback for any candidates not in response
    for (const candidate of candidates) {
      if (!results.find((r) => r.moduleId === candidate.id)) {
        results.push({
          moduleId: candidate.id,
          isEntryPoint: this.isLikelyEntryPointModuleHeuristic(candidate),
          confidence: 'low',
          reason: 'Not in LLM response, using heuristic',
        });
      }
    }

    return results;
  }

  /**
   * Simple heuristic fallback for entry point module detection.
   */
  private isLikelyEntryPointModuleHeuristic(candidate: ModuleCandidate): boolean {
    const path = candidate.fullPath.toLowerCase();

    // Page/screen patterns
    if (path.includes('page') || path.includes('screen') || path.includes('view')) return true;

    // Route/API patterns
    if (path.includes('route') || path.includes('api') || path.includes('endpoint')) return true;
    if (path.includes('handler') || path.includes('controller')) return true;

    // Command patterns
    if (path.includes('command') || path.includes('cli')) return true;

    // Internal patterns (NOT entry points)
    if (path.includes('util') || path.includes('helper') || path.includes('common')) return false;
    if (path.includes('lib') || path.includes('shared') || path.includes('core')) return false;
    if (path.includes('service') || path.includes('repository') || path.includes('model')) return false;

    // Check member names for hints
    const memberNames = candidate.members.map((m) => m.name.toLowerCase());
    const hasHandlerLikeMember = memberNames.some(
      (n) => n.includes('handle') || n.includes('route') || n.includes('page')
    );
    if (hasHandlerLikeMember) return true;

    return false;
  }

  /**
   * Trace a flow from a starting definition through the definition-level call graph.
   * Returns definition-level steps, not module-level interactions.
   * This provides accurate per-entry-point tracing instead of tracing all module interactions.
   */
  private traceDefinitionFlow(
    startDefinitionId: number,
    callGraph: Map<number, number[]>,
    defToModule: Map<number, { moduleId: number; modulePath: string }>
  ): TracedDefinitionStep[] {
    const visited = new Set<number>();
    const steps: TracedDefinitionStep[] = [];
    const maxDepth = 15; // Limit depth for definition-level tracing

    const trace = (defId: number, depth: number): void => {
      if (depth >= maxDepth) return;
      if (visited.has(defId)) return;
      visited.add(defId);

      const calledDefs = callGraph.get(defId) ?? [];
      for (const calledDefId of calledDefs) {
        const fromModule = defToModule.get(defId);
        const toModule = defToModule.get(calledDefId);

        // Only include cross-module calls (skip internal module calls)
        if (fromModule && toModule && fromModule.moduleId !== toModule.moduleId) {
          steps.push({
            fromDefinitionId: defId,
            toDefinitionId: calledDefId,
            fromModuleId: fromModule.moduleId,
            toModuleId: toModule.moduleId,
          });
        }

        // Continue tracing recursively
        trace(calledDefId, depth + 1);
      }
    };

    trace(startDefinitionId, 0);
    return steps;
  }

  /**
   * Derive unique interaction IDs from definition-level steps.
   * Maps cross-module definition calls back to module-level interactions.
   */
  private deriveInteractionIds(
    definitionSteps: TracedDefinitionStep[],
    interactionByModulePair: Map<string, number>
  ): number[] {
    const seenIds = new Set<number>();
    const result: number[] = [];

    for (const step of definitionSteps) {
      if (step.fromModuleId && step.toModuleId) {
        const key = `${step.fromModuleId}->${step.toModuleId}`;
        const interactionId = interactionByModulePair.get(key);
        if (interactionId && !seenIds.has(interactionId)) {
          seenIds.add(interactionId);
          result.push(interactionId);
        }
      }
    }

    return result;
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
        entryPointModuleId: null,
        entryPointId: null,
        entryPath: `Internal: ${modulePath}`,
        stakeholder: 'developer', // Internal, not user-facing
        description: `Internal interactions originating from ${modulePath}`,
        interactionIds: interactions.map((i) => i.id),
        definitionSteps: [], // Gap flows don't have definition-level tracing
      });
    }

    return gapFlows;
  }

  /**
   * Generate a flow name from an entry point module and member.
   */
  private generateFlowNameFromModule(
    _module: EntryPointModuleInfo,
    member: { id: number; name: string; kind: string }
  ): string {
    // Convert handler names to flow names
    let name = member.name;

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
   * Generate a slug from an entry point module and member.
   */
  private generateFlowSlugFromModule(
    _module: EntryPointModuleInfo,
    member: { id: number; name: string; kind: string }
  ): string {
    return this.generateFlowNameFromModule(_module, member)
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }

  /**
   * Infer stakeholder from entry point module context.
   */
  private inferStakeholderFromModule(module: EntryPointModuleInfo): FlowStakeholder {
    const path = module.modulePath.toLowerCase();

    if (path.includes('admin')) return 'admin';
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
