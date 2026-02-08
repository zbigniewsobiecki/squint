import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import { openDatabase, SharedFlags } from '../_shared/index.js';
import type { IndexDatabase } from '../../db/database.js';
import type { ModuleCallEdge, Flow } from '../../db/schema.js';

interface FlowsResult {
  phase: string;
  moduleEdges?: number;
  leafFlows?: number;
  parentFlows?: number;
  rootFlows?: number;
  coverage?: {
    totalModuleEdges: number;
    coveredByFlows: number;
    percentage: number;
  };
}

interface LeafFlowSuggestion {
  fromModuleId: number;
  toModuleId: number;
  fromModulePath: string;
  toModulePath: string;
  name: string;
  slug: string;
  semantic: string;
}

interface FlowGrouping {
  name: string;
  slug: string;
  description: string;
  domain: string | null;
  orderedLeafFlowIds: number[];  // Ordered by execution sequence (IDs for unambiguous matching)
}

interface RootFlowSuggestion {
  name: string;
  slug: string;
  description: string;
  orderedParentFlowIds: number[];  // Ordered by journey sequence (IDs for unambiguous matching)
}

export default class Flows extends Command {
  static override description = 'Detect hierarchical execution flows from module call graph using LLM analysis';

  static override examples = [
    '<%= config.bin %> llm flows',
    '<%= config.bin %> llm flows --phase leaf --dry-run',
    '<%= config.bin %> llm flows --phase all --force',
    '<%= config.bin %> llm flows -d car-dealership.db --verbose',
  ];

  static override flags = {
    database: SharedFlags.database,

    // Phase control
    phase: Flags.string({
      description: 'Which phase to run',
      options: ['all', 'leaf', 'group', 'root'],
      default: 'all',
    }),

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
    const phase = flags.phase;
    const isJson = flags.json;
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;
    const model = flags.model;
    const batchSize = flags['batch-size'];

    try {
      // Check if flows already exist
      const existingFlowCount = db.getFlowCount();
      if (existingFlowCount > 0 && !flags.force) {
        if (isJson) {
          this.log(JSON.stringify({
            error: 'Flows already exist',
            flowCount: existingFlowCount,
            hint: 'Use --force to re-detect',
          }));
        } else {
          this.log(chalk.yellow(`${existingFlowCount} flows already exist.`));
          this.log(chalk.gray('Use --force to re-detect flows.'));
        }
        return;
      }

      if (!isJson) {
        this.log(chalk.bold('Hierarchical Flow Detection'));
        this.log(chalk.gray(`Phase: ${phase}, Model: ${model}`));
        this.log('');
      }

      // Clear existing flows if force
      if (existingFlowCount > 0 && flags.force && !dryRun) {
        db.clearFlows();
        if (!isJson && verbose) {
          this.log(chalk.gray(`Cleared ${existingFlowCount} existing flows`));
        }
      }

      const result: FlowsResult = { phase };

      // Phase 1: Build module call graph and create leaf flows
      if (phase === 'all' || phase === 'leaf') {
        if (!isJson) {
          this.log(chalk.bold('Phase 1: Create Leaf Flows from Module Call Graph'));
        }

        const leafFlowCount = await this.runLeafFlowPhase(db, model, batchSize, isJson, verbose, dryRun);
        result.leafFlows = leafFlowCount;
        result.moduleEdges = db.getModuleCallGraph().length;
      }

      // Phase 2: Group leaf flows into parent flows
      if (phase === 'all' || phase === 'group') {
        if (!isJson) {
          this.log('');
          this.log(chalk.bold('Phase 2: Group Leaf Flows into Parent Flows'));
        }

        const parentFlowCount = await this.runGroupingPhase(db, model, isJson, verbose, dryRun);
        result.parentFlows = parentFlowCount;
      }

      // Phase 3: Create root-level flows
      if (phase === 'all' || phase === 'root') {
        if (!isJson) {
          this.log('');
          this.log(chalk.bold('Phase 3: Create Root-Level User Journey Flows'));
        }

        const rootFlowCount = await this.runRootFlowPhase(db, model, isJson, verbose, dryRun);
        result.rootFlows = rootFlowCount;
      }

      // Final coverage statistics
      const coverage = db.getFlowCoverage();
      result.coverage = coverage;

      if (isJson) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        this.log('');
        this.log(chalk.bold('Final Results'));
        this.log(`Module edges: ${coverage.totalModuleEdges}`);
        this.log(`Covered by flows: ${coverage.coveredByFlows} (${coverage.percentage.toFixed(1)}%)`);
        const stats = db.getFlowStats();
        this.log(`Total flows: ${stats.flowCount} (${stats.leafFlowCount} leaf, max depth: ${stats.maxDepth})`);
      }
    } finally {
      db.close();
    }
  }

  /**
   * Phase 1: Create leaf flows from module call graph edges.
   * For each unique module-to-module edge, create a leaf flow.
   * Use LLM to generate semantic descriptions.
   */
  private async runLeafFlowPhase(
    db: IndexDatabase,
    model: string,
    batchSize: number,
    isJson: boolean,
    verbose: boolean,
    dryRun: boolean
  ): Promise<number> {
    // Get module call graph
    const moduleEdges = db.getModuleCallGraph();

    if (moduleEdges.length === 0) {
      if (!isJson) {
        this.log(chalk.yellow('  No module call graph edges found.'));
        this.log(chalk.gray('  Ensure modules are assigned first with `ats llm modules`'));
      }
      return 0;
    }

    if (!isJson && verbose) {
      this.log(chalk.gray(`  Found ${moduleEdges.length} module-to-module edges`));
    }

    // Generate semantic descriptions for each edge using LLM
    const leafFlows: LeafFlowSuggestion[] = [];

    for (let i = 0; i < moduleEdges.length; i += batchSize) {
      const batch = moduleEdges.slice(i, i + batchSize);

      try {
        const suggestions = await this.generateLeafFlowSemantics(batch, model);
        leafFlows.push(...suggestions);

        if (!isJson && verbose) {
          this.log(chalk.gray(`  Batch ${Math.floor(i / batchSize) + 1}: Generated ${suggestions.length} leaf flows`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isJson) {
          this.log(chalk.yellow(`  Batch ${Math.floor(i / batchSize) + 1} failed: ${message}`));
        }
        // Fall back to auto-generated names
        for (const edge of batch) {
          leafFlows.push(this.createDefaultLeafFlow(edge));
        }
      }
    }

    // Persist leaf flows as orphans (parentId = null) for later reparenting
    // Use a Set to track used slugs and ensure uniqueness upfront
    if (!dryRun) {
      const usedSlugs = new Set<string>();

      for (const flow of leafFlows) {
        // Ensure slug uniqueness by appending module IDs if needed
        let slug = flow.slug;
        if (usedSlugs.has(slug)) {
          slug = `${flow.slug}-${flow.fromModuleId}-${flow.toModuleId}`;
        }
        usedSlugs.add(slug);

        try {
          // Create orphaned leaf flow (will be reparented in Phase 2)
          db.insertFlow(null, slug, flow.name, {
            fromModuleId: flow.fromModuleId,
            toModuleId: flow.toModuleId,
            semantic: flow.semantic,
          });
        } catch {
          // Skip if still fails (e.g., database constraint)
          if (verbose && !isJson) {
            this.log(chalk.yellow(`  Skipping duplicate flow: ${flow.name}`));
          }
        }
      }
    }

    if (!isJson) {
      this.log(chalk.gray(`  Created ${leafFlows.length} leaf flows from module edges`));
    }

    return leafFlows.length;
  }

  /**
   * Generate semantic descriptions for module edges using LLM.
   */
  private async generateLeafFlowSemantics(
    edges: ModuleCallEdge[],
    model: string
  ): Promise<LeafFlowSuggestion[]> {
    const systemPrompt = `You are a software architect analyzing module-level call graph edges.

For each module-to-module transition, provide:
1. A descriptive name for the flow (PascalCase, action-oriented)
2. A UNIQUE slug (kebab-case, URL-safe) that includes module context
3. A semantic description of what happens in this transition

Output format - respond with ONLY a CSV table:

\`\`\`csv
from_module,to_module,name,slug,semantic
project.controllers,project.services.auth,"ValidateCredentials","controllers-auth-validate-credentials","Controller validates user credentials through auth service"
\`\`\`

Guidelines:
- Name should describe the business action (e.g., "ProcessPayment", "ValidateInput")
- Slug MUST be unique - prefix with abbreviated module names to avoid collisions
- Format: {from-module-short}-{to-module-short}-{action} (e.g., "api-db-fetch-user")
- Semantic should explain WHY this module calls the other module
- Keep descriptions concise (under 100 chars)`;

    const userPrompt = `## Module Transitions to Describe (${edges.length})

${edges.map((e, i) => `${i + 1}. ${e.fromModulePath} → ${e.toModulePath} (${e.weight} calls)`).join('\n')}

Generate flow metadata for each transition in CSV format.`;

    const response = await LLMist.complete(userPrompt, {
      model,
      systemPrompt,
      temperature: 0,
    });

    return this.parseLeafFlowCSV(response, edges);
  }

  /**
   * Parse LLM CSV response into leaf flow suggestions.
   */
  private parseLeafFlowCSV(response: string, edges: ModuleCallEdge[]): LeafFlowSuggestion[] {
    const results: LeafFlowSuggestion[] = [];

    // Find CSV block
    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) ||
      response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter(l => l.trim() && !l.startsWith('from_module'));

    for (const line of lines) {
      // Parse CSV line (handle quoted fields)
      const fields = this.parseCSVLine(line);
      if (fields.length < 5) continue;

      const [fromPath, toPath, name, slug, semantic] = fields;

      // Find matching edge
      const edge = edges.find(e =>
        e.fromModulePath === fromPath && e.toModulePath === toPath
      ) || edges.find(e =>
        e.fromModulePath.endsWith(fromPath) && e.toModulePath.endsWith(toPath)
      );

      if (edge) {
        results.push({
          fromModuleId: edge.fromModuleId,
          toModuleId: edge.toModuleId,
          fromModulePath: edge.fromModulePath,
          toModulePath: edge.toModulePath,
          name: name.trim().replace(/"/g, ''),
          slug: slug.trim().replace(/"/g, ''),
          semantic: semantic.trim().replace(/"/g, ''),
        });
      }
    }

    // Add defaults for any edges not covered
    for (const edge of edges) {
      if (!results.find(r => r.fromModuleId === edge.fromModuleId && r.toModuleId === edge.toModuleId)) {
        results.push(this.createDefaultLeafFlow(edge));
      }
    }

    return results;
  }

  /**
   * Create a default leaf flow from an edge when LLM fails.
   * Uses full module context in slug to prevent collisions.
   */
  private createDefaultLeafFlow(edge: ModuleCallEdge): LeafFlowSuggestion {
    const fromLast = edge.fromModulePath.split('.').pop() ?? 'source';
    const toLast = edge.toModulePath.split('.').pop() ?? 'target';
    const name = `${this.toPascalCase(fromLast)}To${this.toPascalCase(toLast)}`;
    // Include module IDs in slug to guarantee uniqueness
    const slug = `${fromLast}-to-${toLast}-${edge.fromModuleId}-${edge.toModuleId}`.toLowerCase();

    return {
      fromModuleId: edge.fromModuleId,
      toModuleId: edge.toModuleId,
      fromModulePath: edge.fromModulePath,
      toModulePath: edge.toModulePath,
      name,
      slug,
      semantic: `Calls from ${edge.fromModulePath} to ${edge.toModulePath}`,
    };
  }

  /**
   * Phase 2: Group leaf flows into parent flows.
   * LLM analyzes leaf flows and groups them into logical parent flows.
   * Leaf flows are reparented under their assigned parent flows.
   */
  private async runGroupingPhase(
    db: IndexDatabase,
    model: string,
    isJson: boolean,
    verbose: boolean,
    dryRun: boolean
  ): Promise<number> {
    const leafFlows = db.getLeafFlows();

    if (leafFlows.length === 0) {
      if (!isJson && verbose) {
        this.log(chalk.gray('  No leaf flows to group'));
      }
      return 0;
    }

    if (!isJson && verbose) {
      this.log(chalk.gray(`  Analyzing ${leafFlows.length} leaf flows for grouping...`));
    }

    // Build a map of ID to flow for validation
    const idToFlow = new Map<number, Flow>();
    for (const flow of leafFlows) {
      idToFlow.set(flow.id, flow);
    }

    // Get module names for context in prompts
    const modules = db.getAllModules();
    const moduleNameMap = new Map(modules.map(m => [m.id, m.fullPath]));

    try {
      const groupings = await this.generateFlowGroupings(leafFlows, moduleNameMap, model);

      if (!dryRun) {
        let reparentedCount = 0;

        for (const group of groupings) {
          // Create parent flow as orphan (will be reparented in Phase 3)
          const parentFlowId = db.insertFlow(null, group.slug, group.name, {
            description: group.description,
            domain: group.domain ?? undefined,
          });

          // Validate and filter IDs - only use IDs that exist in our leaf flows
          const validLeafFlowIds: number[] = [];
          for (const leafId of group.orderedLeafFlowIds) {
            const leaf = idToFlow.get(leafId);
            if (leaf) {
              validLeafFlowIds.push(leafId);
            } else if (verbose && !isJson) {
              this.log(chalk.yellow(`  Warning: Leaf flow ID ${leafId} not found for group '${group.name}'`));
            }
          }

          // Reparent leaf flows under the parent in the order specified
          if (validLeafFlowIds.length > 0) {
            db.reparentFlows(validLeafFlowIds, parentFlowId);
            reparentedCount += validLeafFlowIds.length;
          }

          if (verbose && !isJson) {
            this.log(chalk.gray(`  Created parent flow '${group.name}' with ${validLeafFlowIds.length} children`));
          }
        }

        // Handle orphan leaf flows after grouping
        await this.handleOrphanFlows(db, 0, 'leaf', isJson, verbose, dryRun);

        if (!isJson) {
          this.log(chalk.gray(`  Created ${groupings.length} parent flows, reparented ${reparentedCount} leaf flows`));
        }
      } else if (!isJson) {
        this.log(chalk.gray(`  Would create ${groupings.length} parent flow groups`));
      }

      return groupings.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isJson) {
        this.log(chalk.yellow(`  Grouping failed: ${message}`));
      }
      return 0;
    }
  }

  /**
   * Generate flow groupings using LLM.
   * Asks the LLM to group leaf flows by ID for unambiguous matching.
   */
  private async generateFlowGroupings(
    leafFlows: Flow[],
    moduleNameMap: Map<number, string>,
    model: string
  ): Promise<FlowGrouping[]> {
    const systemPrompt = `You are a software architect grouping related module transitions into higher-level business flows.

Analyze the leaf flows (module-to-module transitions) and group them into logical parent flows that represent:
- Feature flows (e.g., "Authentication", "PaymentProcessing")
- Domain operations (e.g., "UserManagement", "OrderFulfillment")
- Technical concerns (e.g., "DataValidation", "ErrorHandling")

Output format - respond with ONLY a CSV table:

\`\`\`csv
name,slug,description,domain,child_ids
"Authentication","authentication","User authentication and session management","auth","12,15,18"
"PaymentProcessing","payment-processing","Payment validation and processing","payments","22,25,28"
\`\`\`

IMPORTANT Guidelines:
- Group flows that work together to accomplish a business goal
- Name groups with PascalCase describing the feature/domain
- Include 2-6 related leaf flows per group
- **Reference flows by their ID numbers** (the number in brackets) for unambiguous matching
- **List child IDs IN EXECUTION ORDER (first to last)** - the order matters!
- Leaf flows can appear in multiple groups if they're truly shared
- Leave ungroupable flows for the next phase`;

    // Build flow list with IDs and module context for better LLM understanding
    const flowList = leafFlows.map(f => {
      const fromModule = f.fromModuleId ? moduleNameMap.get(f.fromModuleId) ?? 'unknown' : 'unknown';
      const toModule = f.toModuleId ? moduleNameMap.get(f.toModuleId) ?? 'unknown' : 'unknown';
      return `[${f.id}] ${f.slug} (${fromModule} → ${toModule})${f.semantic ? ` - "${f.semantic}"` : ''}`;
    }).join('\n');

    const userPrompt = `## Leaf Flows to Group (${leafFlows.length})

${flowList}

Group these into logical parent flows in CSV format. Reference flows by their ID (number in brackets). List child IDs in execution order.`;

    const response = await LLMist.complete(userPrompt, {
      model,
      systemPrompt,
      temperature: 0,
    });

    return this.parseGroupingCSV(response);
  }

  /**
   * Parse grouping CSV response with ID-based child references.
   */
  private parseGroupingCSV(response: string): FlowGrouping[] {
    const results: FlowGrouping[] = [];

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) ||
      response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter(l => l.trim() && !l.startsWith('name,'));

    for (const line of lines) {
      const fields = this.parseCSVLine(line);
      if (fields.length < 5) continue;

      const [name, slug, description, domain, childIdsStr] = fields;

      // Parse IDs from comma-separated string, filtering non-numeric values
      const childIds = childIdsStr
        .split(',')
        .map(s => parseInt(s.trim().replace(/"/g, ''), 10))
        .filter(id => !isNaN(id) && id > 0);

      results.push({
        name: name.trim().replace(/"/g, ''),
        slug: slug.trim().replace(/"/g, ''),
        description: description.trim().replace(/"/g, ''),
        domain: domain.trim().replace(/"/g, '') || null,
        orderedLeafFlowIds: childIds,
      });
    }

    return results;
  }

  /**
   * Phase 3: Create root-level user journey flows.
   * LLM combines parent flows into user-story-level flows.
   * Parent flows are reparented under their assigned root flows.
   */
  private async runRootFlowPhase(
    db: IndexDatabase,
    model: string,
    isJson: boolean,
    verbose: boolean,
    dryRun: boolean
  ): Promise<number> {
    // Get parent flows that haven't been assigned to a root yet
    // After Phase 2, parent flows are at depth 0 (orphaned)
    const allFlows = db.getAllFlows();
    const parentFlows = allFlows.filter(f =>
      f.depth === 0 &&
      f.fromModuleId === null &&  // Not a leaf flow
      f.toModuleId === null
    );

    // Also check for parent flows at depth 1 if they exist under a temp root
    const parentFlowsDepth1 = allFlows.filter(f =>
      f.depth === 1 &&
      f.fromModuleId === null &&
      f.toModuleId === null
    );

    const candidateParentFlows = parentFlows.length > 0 ? parentFlows : parentFlowsDepth1;

    if (candidateParentFlows.length === 0) {
      if (!isJson && verbose) {
        this.log(chalk.gray('  No parent flows to combine into root flows'));
      }
      return 0;
    }

    if (!isJson && verbose) {
      this.log(chalk.gray(`  Analyzing ${candidateParentFlows.length} parent flows for root-level journeys...`));
    }

    // Build a map of ID to flow for validation
    const idToFlow = new Map<number, Flow>();
    for (const flow of candidateParentFlows) {
      idToFlow.set(flow.id, flow);
    }

    try {
      const rootFlowSuggestions = await this.generateRootFlows(candidateParentFlows, model);

      if (!dryRun && rootFlowSuggestions.length > 0) {
        let reparentedCount = 0;

        for (const rootSuggestion of rootFlowSuggestions) {
          // Create root flow
          const rootFlowId = db.insertFlow(null, rootSuggestion.slug, rootSuggestion.name, {
            description: rootSuggestion.description,
          });

          // Validate and filter IDs - only use IDs that exist in our parent flows
          const validParentFlowIds: number[] = [];
          for (const parentId of rootSuggestion.orderedParentFlowIds) {
            const parent = idToFlow.get(parentId);
            if (parent) {
              validParentFlowIds.push(parentId);
            } else if (verbose && !isJson) {
              this.log(chalk.yellow(`  Warning: Parent flow ID ${parentId} not found for root '${rootSuggestion.name}'`));
            }
          }

          // Reparent parent flows under the root in the order specified
          if (validParentFlowIds.length > 0) {
            db.reparentFlows(validParentFlowIds, rootFlowId);
            reparentedCount += validParentFlowIds.length;
          }

          if (verbose && !isJson) {
            this.log(chalk.gray(`  Created root flow '${rootSuggestion.name}' with ${validParentFlowIds.length} parent flows`));
          }
        }

        // Handle orphan parent flows after root creation
        await this.handleOrphanFlows(db, 0, 'parent', isJson, verbose, dryRun);

        if (!isJson) {
          this.log(chalk.gray(`  Created ${rootFlowSuggestions.length} root flows, reparented ${reparentedCount} parent flows`));
        }
      } else if (!isJson) {
        this.log(chalk.gray(`  Would create ${rootFlowSuggestions.length} root-level user journeys`));
      }

      return rootFlowSuggestions.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isJson) {
        this.log(chalk.yellow(`  Root flow generation failed: ${message}`));
      }
      return 0;
    }
  }

  /**
   * Generate root-level flows using LLM.
   * Asks the LLM to combine parent flows into user journeys by ID for unambiguous matching.
   */
  private async generateRootFlows(
    parentFlows: Flow[],
    model: string
  ): Promise<RootFlowSuggestion[]> {
    const systemPrompt = `You are a software architect identifying user journeys from feature-level flows.

Analyze the parent flows and identify complete user journeys like:
- "UserOnboarding": signup → email verification → profile setup
- "CheckoutProcess": cart review → payment → confirmation
- "ContentPublishing": draft → review → publish → notify

Output format - respond with ONLY a CSV table:

\`\`\`csv
name,slug,description,child_ids
"UserOnboarding","user-onboarding","Complete new user signup journey from registration to active account","12,15,18"
"CheckoutProcess","checkout-process","Full checkout flow from cart to confirmation","22,25,28"
\`\`\`

IMPORTANT Guidelines:
- Focus on end-to-end user experiences
- Each journey should tell a complete user story
- **Reference flows by their ID numbers** (the number in brackets) for unambiguous matching
- **List child IDs IN JOURNEY ORDER (first to last)** - the sequence matters!
- Include 2-5 parent flows per journey
- Parent flows can appear in multiple journeys if they're truly shared`;

    // Build flow list with IDs for unambiguous LLM matching
    const flowList = parentFlows.map(f =>
      `[${f.id}] ${f.slug}: ${f.name}${f.description ? ` - "${f.description}"` : ''}`
    ).join('\n');

    const userPrompt = `## Parent Flows (${parentFlows.length})

${flowList}

Identify user journeys combining these flows in CSV format. Reference flows by their ID (number in brackets). List child IDs in journey sequence order.`;

    const response = await LLMist.complete(userPrompt, {
      model,
      systemPrompt,
      temperature: 0,
    });

    const results: RootFlowSuggestion[] = [];

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) ||
      response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter(l => l.trim() && !l.startsWith('name,'));

    for (const line of lines) {
      const fields = this.parseCSVLine(line);
      if (fields.length < 4) continue;

      const [name, slug, description, childIdsStr] = fields;

      // Parse IDs from comma-separated string, filtering non-numeric values
      const childIds = childIdsStr
        .split(',')
        .map(s => parseInt(s.trim().replace(/"/g, ''), 10))
        .filter(id => !isNaN(id) && id > 0);

      results.push({
        name: name.trim().replace(/"/g, ''),
        slug: slug.trim().replace(/"/g, ''),
        description: description.trim().replace(/"/g, ''),
        orderedParentFlowIds: childIds,
      });
    }

    return results;
  }

  /**
   * Handle orphan flows that weren't grouped in Phase 2 or 3.
   * Groups orphans by their domain or creates a catch-all parent.
   */
  private async handleOrphanFlows(
    db: IndexDatabase,
    depth: number,
    flowType: 'leaf' | 'parent',
    isJson: boolean,
    verbose: boolean,
    dryRun: boolean
  ): Promise<void> {
    const orphans = db.getOrphanFlows(depth);

    // Filter based on flow type
    const filteredOrphans = flowType === 'leaf'
      ? orphans.filter(f => f.fromModuleId !== null && f.toModuleId !== null)
      : orphans.filter(f => f.fromModuleId === null && f.toModuleId === null);

    if (filteredOrphans.length === 0) {
      return;
    }

    if (!isJson && verbose) {
      this.log(chalk.gray(`  Found ${filteredOrphans.length} orphan ${flowType} flows at depth ${depth}`));
    }

    if (dryRun) {
      return;
    }

    // Group orphans by domain
    const grouped = new Map<string, Flow[]>();
    for (const flow of filteredOrphans) {
      const domain = flow.domain ?? 'misc';
      const existing = grouped.get(domain) || [];
      existing.push(flow);
      grouped.set(domain, existing);
    }

    for (const [domain, flows] of grouped) {
      const catchAllSlug = `${domain}-${flowType === 'leaf' ? 'operations' : 'misc'}`;
      const catchAllName = `${this.toPascalCase(domain)} ${flowType === 'leaf' ? 'Operations' : '(Ungrouped)'}`;

      try {
        // Create catch-all parent flow
        const parentFlowId = db.insertFlow(null, catchAllSlug, catchAllName, {
          description: `Ungrouped ${flowType} flows in the ${domain} domain`,
          domain,
        });

        // Reparent orphan flows under this catch-all
        const flowIds = flows.map(f => f.id);
        db.reparentFlows(flowIds, parentFlowId);

        if (!isJson && verbose) {
          this.log(chalk.gray(`  Created catch-all '${catchAllName}' with ${flowIds.length} ${flowType} flows`));
        }
      } catch {
        // Slug collision - try with a unique suffix
        const uniqueSlug = `${catchAllSlug}-${Date.now()}`;
        const parentFlowId = db.insertFlow(null, uniqueSlug, catchAllName, {
          description: `Ungrouped ${flowType} flows in the ${domain} domain`,
          domain,
        });
        const flowIds = flows.map(f => f.id);
        db.reparentFlows(flowIds, parentFlowId);
      }
    }
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

  /**
   * Convert to PascalCase.
   */
  private toPascalCase(str: string): string {
    return str
      .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
      .replace(/^(.)/, (_, c) => c.toUpperCase());
  }
}
