/**
 * Flows Command - Detects user journey flows from entry points and traces through interactions.
 *
 * This is a thin orchestrator that composes:
 * - EntryPointDetector: LLM-based entry point module classification
 * - FlowTracer: Definition-level call graph traversal
 * - FlowEnhancer: LLM metadata enhancement for flows
 * - GapFlowGenerator: Creates flows for uncovered interactions
 */

import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';
import { calculatePercentage, getErrorMessage, logSection, logStep, logVerbose } from './_shared/llm-utils.js';
import {
  EntryPointDetector,
  FlowEnhancer,
  type FlowSuggestion,
  FlowTracer,
  GapFlowGenerator,
  buildFlowTracingContext,
} from './flows/index.js';

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
      default: 'openrouter:google/gemini-2.5-flash',
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
    'show-llm-requests': Flags.boolean({
      description: 'Show full LLM requests (system + user prompts)',
      default: false,
    }),
    'show-llm-responses': Flags.boolean({
      description: 'Show full LLM responses',
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
    const llmOptions = {
      showLlmRequests: flags['show-llm-requests'],
      showLlmResponses: flags['show-llm-responses'],
    };

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
        logVerbose(this, `Cleared ${existingCount} existing flows`, verbose, isJson);
      }

      // Step 1: Detect entry point modules using LLM classification
      logStep(this, 1, 'Detecting Entry Point Modules (LLM Classification)', isJson);

      const entryPointDetector = new EntryPointDetector(db, this, isJson, verbose);
      const entryPointModules = await entryPointDetector.detectEntryPointModules(model, llmOptions);

      logVerbose(this, `Found ${entryPointModules.length} LLM-classified entry point modules`, verbose, isJson);

      if (entryPointModules.length === 0 && !isJson) {
        this.log(chalk.yellow('No entry point modules detected.'));
        this.log(chalk.gray('Gap flows will still be created for uncovered interactions.'));
      }

      // Step 2: Trace flows from entry point modules using definition-level call graph
      logStep(this, 2, 'Tracing Flows from Entry Point Modules (Definition-Level)', isJson);

      const interactions = db.getAllInteractions();
      const allModulesWithMembers = db.getAllModulesWithMembers();
      const definitionCallGraph = db.getDefinitionCallGraphMap();

      const tracingContext = buildFlowTracingContext(definitionCallGraph, allModulesWithMembers, interactions);
      const flowTracer = new FlowTracer(tracingContext);
      const flowSuggestions = flowTracer.traceFlowsFromEntryPoints(entryPointModules);

      logVerbose(this, `Traced ${flowSuggestions.length} potential flows with definition-level steps`, verbose, isJson);

      // Step 3: Use LLM to enhance flow metadata
      logStep(this, 3, 'Enhancing Flow Metadata with LLM', isJson);

      let enhancedFlows: FlowSuggestion[] = [];
      if (flowSuggestions.length > 0) {
        try {
          const flowEnhancer = new FlowEnhancer(this, isJson);
          enhancedFlows = await flowEnhancer.enhanceFlowsWithLLM(flowSuggestions, interactions, model, llmOptions);
          logVerbose(this, `Enhanced ${enhancedFlows.length} flows`, verbose, isJson);
        } catch (error) {
          const message = getErrorMessage(error);
          if (!isJson) {
            this.log(chalk.yellow(`LLM enhancement failed: ${message}`));
          }
          enhancedFlows = flowSuggestions;
        }
      }

      // Step 4: Create gap flows for uncovered interactions
      logStep(this, 4, 'Creating Gap Flows for Uncovered Interactions', isJson);

      const coveredIds = new Set(enhancedFlows.flatMap((f) => f.interactionIds));
      const gapFlowGenerator = new GapFlowGenerator();
      const gapFlows = gapFlowGenerator.createGapFlows(coveredIds, interactions);
      enhancedFlows.push(...gapFlows);

      logVerbose(this, `Created ${gapFlows.length} gap flows for uncovered interactions`, verbose, isJson);

      // Step 5: Persist flows
      if (!dryRun && enhancedFlows.length > 0) {
        this.persistFlows(db, enhancedFlows, verbose, isJson);
      }

      // Output results
      this.outputResults(db, enhancedFlows, gapFlows, entryPointModules, interactions, dryRun, isJson);
    } finally {
      db.close();
    }
  }

  /**
   * Persist flows to the database.
   */
  private persistFlows(db: IndexDatabase, flows: FlowSuggestion[], verbose: boolean, isJson: boolean): void {
    const usedSlugs = new Set<string>();

    for (const flow of flows) {
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
      } catch {
        if (verbose && !isJson) {
          this.log(chalk.yellow(`  Skipping flow: ${flow.name}`));
        }
      }
    }
  }

  /**
   * Output results in JSON or human-readable format.
   */
  private outputResults(
    db: IndexDatabase,
    enhancedFlows: FlowSuggestion[],
    gapFlows: FlowSuggestion[],
    entryPointModules: Array<{ moduleId: number }>,
    interactions: Array<{ id: number }>,
    dryRun: boolean,
    isJson: boolean
  ): void {
    const userFlowCount = enhancedFlows.filter((f) => f.entryPointModuleId !== null).length;
    const internalFlowCount = gapFlows.length;

    const coveredInteractionIds = new Set(enhancedFlows.flatMap((f) => f.interactionIds));
    const coverage = dryRun
      ? {
          totalInteractions: interactions.length,
          coveredByFlows: coveredInteractionIds.size,
          percentage: calculatePercentage(coveredInteractionIds.size, interactions.length),
        }
      : db.getFlowCoverage();

    const result = {
      entryPointModules: entryPointModules.length,
      flowsCreated: enhancedFlows.length,
      userFlows: userFlowCount,
      internalFlows: internalFlowCount,
      coverage,
    };

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    } else {
      logSection(this, 'Results', false);
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
  }
}
