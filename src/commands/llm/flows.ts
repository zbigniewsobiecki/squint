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
import type { InteractionWithPaths } from '../../db/schema.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';
import {
  calculatePercentage,
  getErrorMessage,
  logSection,
  logStep,
  logVerbose,
  logWarning,
} from './_shared/llm-utils.js';
import {
  EntryPointDetector,
  FlowEnhancer,
  type FlowSuggestion,
  FlowTracer,
  FlowValidator,
  GapFlowGenerator,
  buildFlowTracingContext,
} from './flows/index.js';
import type { EntryPointModuleInfo } from './flows/types.js';

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
    'min-interaction-coverage': Flags.integer({
      description: 'Minimum % of interactions that must appear in flows',
      default: 90,
    }),
    'max-gap-flow-ratio': Flags.integer({
      description: 'Maximum % of flows that can be internal/gap flows',
      default: 20,
    }),
    'min-entry-point-yield': Flags.integer({
      description: 'Minimum % of entry point modules that must produce meaningful flows',
      default: 90,
    }),
    'min-inferred-coverage': Flags.integer({
      description: 'Minimum % of inferred (cross-boundary) interactions that must appear in flows',
      default: 90,
    }),
    'max-gate-retries': Flags.integer({
      description: 'Maximum retry attempts when coverage gates fail',
      default: 2,
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

      const sharedFlowEnhancer = new FlowEnhancer(this, isJson);
      let enhancedFlows: FlowSuggestion[] = [];
      if (flowSuggestions.length > 0) {
        try {
          enhancedFlows = await sharedFlowEnhancer.enhanceFlowsWithLLM(
            flowSuggestions,
            interactions,
            model,
            llmOptions
          );
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

      let coveredIds = new Set(enhancedFlows.flatMap((f) => f.interactionIds));
      const gapFlowGenerator = new GapFlowGenerator();
      let gapFlows = gapFlowGenerator.createGapFlows(coveredIds, interactions);
      enhancedFlows.push(...gapFlows);

      logVerbose(this, `Created ${gapFlows.length} gap flows for uncovered interactions`, verbose, isJson);

      // Step 5: Validate flow completeness (LLM review) with auto-retry loop
      logStep(this, 5, 'Validating Flow Completeness (LLM Review)', isJson);

      const maxGateRetries = flags['max-gate-retries'];
      const thresholds = {
        minInteractionCoverage: flags['min-interaction-coverage'],
        maxGapFlowRatio: flags['max-gap-flow-ratio'],
        minEntryPointYield: flags['min-entry-point-yield'],
        minInferredCoverage: flags['min-inferred-coverage'],
      };

      const flowValidator = new FlowValidator(db, this, isJson, verbose);

      for (let attempt = 0; attempt <= maxGateRetries; attempt++) {
        try {
          // Run validator (initial or with gate failure context)
          const gateResults =
            attempt > 0 ? this.checkCoverageGates(enhancedFlows, interactions, entryPointModules, thresholds) : null;

          const validatorFlows = await flowValidator.validateAndFillGaps(
            enhancedFlows,
            interactions,
            model,
            llmOptions,
            gateResults?.failures,
            entryPointModules
          );

          // Post-validation gate: reject flows whose actionType doesn't exist in entry point definitions
          const verifiedFlows = this.filterUnverifiedFlows(validatorFlows, entryPointModules);
          const gateRejects = validatorFlows.length - verifiedFlows.length;
          if (gateRejects > 0) {
            logVerbose(
              this,
              `  Rejected ${gateRejects} flows: actionType not found in entry point definitions`,
              verbose,
              isJson
            );
          }

          if (verifiedFlows.length > 0) {
            // Build dedup key set from existing flows
            const existingKeys = new Set(
              enhancedFlows
                .filter((f) => f.actionType && f.targetEntity)
                .map((f) => `${f.entryPointModuleId}:${f.actionType}:${f.targetEntity}`)
            );
            const existingSlugs = new Set(enhancedFlows.map((f) => f.slug));

            const dedup = (flows: FlowSuggestion[]): FlowSuggestion[] =>
              flows.filter((f) => {
                if (f.actionType && f.targetEntity) {
                  const key = `${f.entryPointModuleId}:${f.actionType}:${f.targetEntity}`;
                  if (existingKeys.has(key)) return false;
                  existingKeys.add(key);
                  return true;
                }
                // Fallback: slug-based dedup for unclassified flows
                if (existingSlugs.has(f.slug)) return false;
                existingSlugs.add(f.slug);
                return true;
              });

            // Run through enhancer for consistent naming
            try {
              const enhancedValidatorFlows = await sharedFlowEnhancer.enhanceFlowsWithLLM(
                verifiedFlows,
                interactions,
                model,
                llmOptions
              );
              const dedupedFlows = dedup(enhancedValidatorFlows);
              enhancedFlows.push(...dedupedFlows);
              const filteredCount = enhancedValidatorFlows.length - dedupedFlows.length;
              const suffix = filteredCount > 0 ? ` (${filteredCount} duplicates filtered)` : '';
              logVerbose(
                this,
                `  Added ${dedupedFlows.length} flows from validation pass ${attempt + 1}${suffix}`,
                verbose,
                isJson
              );
            } catch {
              const dedupedFlows = dedup(verifiedFlows);
              enhancedFlows.push(...dedupedFlows);
              const filteredCount = verifiedFlows.length - dedupedFlows.length;
              const suffix = filteredCount > 0 ? ` (${filteredCount} duplicates filtered)` : '';
              logVerbose(
                this,
                `  Added ${dedupedFlows.length} unenhanced flows from validation pass ${attempt + 1}${suffix}`,
                verbose,
                isJson
              );
            }

            // Regenerate gap flows with updated coverage
            coveredIds = new Set(enhancedFlows.flatMap((f) => f.interactionIds));
            const oldGapCount = gapFlows.length;
            // Remove old gap flows
            enhancedFlows = enhancedFlows.filter((f) => f.entryPointModuleId !== null);
            gapFlows = gapFlowGenerator.createGapFlows(coveredIds, interactions);
            enhancedFlows.push(...gapFlows);
            if (gapFlows.length < oldGapCount) {
              logVerbose(this, `  Gap flows reduced: ${oldGapCount} → ${gapFlows.length}`, verbose, isJson);
            }
          }
        } catch (error) {
          const message = getErrorMessage(error);
          logVerbose(this, `  Validator pass ${attempt + 1} failed: ${message}`, verbose, isJson);
        }

        // Check gates
        const currentGates = this.checkCoverageGates(enhancedFlows, interactions, entryPointModules, thresholds);
        if (currentGates.passed) {
          logVerbose(this, '  All coverage gates passed', verbose, isJson);
          break;
        }

        if (attempt === maxGateRetries) {
          for (const failure of currentGates.failures) {
            logWarning(
              this,
              `Coverage gate: ${failure.gate} (${failure.actual.toFixed(1)}% vs ${failure.threshold}%) - ${failure.details}`,
              isJson
            );
          }
          logVerbose(
            this,
            `  Coverage gates not met after ${maxGateRetries} retries, proceeding with best results`,
            verbose,
            isJson
          );
        }
      }

      // Step 6: Persist flows
      logStep(this, 6, 'Persisting Flows', isJson);

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
      const slug = flow.slug;
      if (usedSlugs.has(slug)) {
        logVerbose(this, `  Skipping duplicate flow: ${flow.name} (slug: ${slug})`, verbose, isJson);
        continue;
      }
      usedSlugs.add(slug);

      try {
        const flowId = db.insertFlow(flow.name, slug, {
          entryPointModuleId: flow.entryPointModuleId ?? undefined,
          entryPointId: flow.entryPointId ?? undefined,
          entryPath: flow.entryPath,
          stakeholder: flow.stakeholder,
          description: flow.description,
          actionType: flow.actionType ?? undefined,
          targetEntity: flow.targetEntity ?? undefined,
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
    interactions: InteractionWithPaths[],
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

    // Count test-internal exclusions
    const testInternalCount = interactions.filter((i) => i.pattern === 'test-internal').length;
    const relevantTotal = dryRun
      ? coverage.totalInteractions - testInternalCount // dry-run total includes all
      : coverage.totalInteractions; // DB total already excludes test-internal
    const relevantCovered = dryRun
      ? interactions.filter((i) => i.pattern !== 'test-internal' && coveredInteractionIds.has(i.id)).length
      : coverage.coveredByFlows; // getCoverage already excludes test-internal
    const relevantPercentage = relevantTotal > 0 ? (relevantCovered / relevantTotal) * 100 : 0;

    const result = {
      entryPointModules: entryPointModules.length,
      flowsCreated: enhancedFlows.length,
      userFlows: userFlowCount,
      internalFlows: internalFlowCount,
      coverage,
      testInternalExcluded: testInternalCount,
    };

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    } else {
      logSection(this, 'Results', false);
      this.log(`Entry point modules detected: ${result.entryPointModules} (LLM classified)`);
      this.log(`Flows created: ${result.flowsCreated}`);
      this.log(`  - User flows: ${result.userFlows}`);
      this.log(`  - Internal/gap flows: ${result.internalFlows}`);
      if (testInternalCount > 0) {
        this.log(
          `Interaction coverage: ${relevantCovered}/${relevantTotal} relevant (${relevantPercentage.toFixed(1)}%)`
        );
        this.log(chalk.gray(`  (${testInternalCount} test-internal interactions excluded)`));
      } else {
        this.log(
          `Interaction coverage: ${result.coverage.coveredByFlows}/${result.coverage.totalInteractions} (${result.coverage.percentage.toFixed(1)}%)`
        );
      }

      if (dryRun) {
        this.log('');
        this.log(chalk.gray('(Dry run - no changes persisted)'));
      }
    }
  }

  /**
   * Check coverage quality gates.
   */
  private checkCoverageGates(
    flows: FlowSuggestion[],
    interactions: InteractionWithPaths[],
    entryPointModules: EntryPointModuleInfo[],
    thresholds: {
      minInteractionCoverage: number;
      maxGapFlowRatio: number;
      minEntryPointYield: number;
      minInferredCoverage: number;
    }
  ): { passed: boolean; failures: Array<{ gate: string; actual: number; threshold: number; details: string }> } {
    const failures: Array<{ gate: string; actual: number; threshold: number; details: string }> = [];

    // Filter out test-internal interactions from coverage calculation
    const relevantInteractions = interactions.filter((i) => i.pattern !== 'test-internal');

    // Gate 1: Interaction coverage (excludes test-internal)
    const coveredIds = new Set(flows.flatMap((f) => f.interactionIds));
    const relevantCoveredCount = relevantInteractions.filter((i) => coveredIds.has(i.id)).length;
    const interactionCoverage =
      relevantInteractions.length > 0 ? (relevantCoveredCount / relevantInteractions.length) * 100 : 100;
    if (interactionCoverage < thresholds.minInteractionCoverage) {
      failures.push({
        gate: 'interaction-coverage',
        actual: interactionCoverage,
        threshold: thresholds.minInteractionCoverage,
        details: `${relevantCoveredCount}/${relevantInteractions.length} relevant interactions covered by flows`,
      });
    }

    // Gate 2: Gap flow ratio
    const gapFlows = flows.filter((f) => f.entryPointModuleId === null);
    const gapRatio = flows.length > 0 ? (gapFlows.length / flows.length) * 100 : 0;
    if (gapRatio > thresholds.maxGapFlowRatio) {
      failures.push({
        gate: 'gap-flow-ratio',
        actual: gapRatio,
        threshold: thresholds.maxGapFlowRatio,
        details: `${gapFlows.length}/${flows.length} flows are internal/gap (want < ${thresholds.maxGapFlowRatio}%)`,
      });
    }

    // Gate 3: Entry point yield
    const userFlows = flows.filter((f) => f.entryPointModuleId !== null);
    const modulesWithFlows = new Set(
      userFlows.filter((f) => f.interactionIds.length >= 1).map((f) => f.entryPointModuleId)
    );
    const entryPointYield =
      entryPointModules.length > 0 ? (modulesWithFlows.size / entryPointModules.length) * 100 : 100;
    if (entryPointYield < thresholds.minEntryPointYield) {
      failures.push({
        gate: 'entry-point-yield',
        actual: entryPointYield,
        threshold: thresholds.minEntryPointYield,
        details: `${modulesWithFlows.size}/${entryPointModules.length} entry points produced meaningful flows`,
      });
    }

    // Gate 4: Inferred interaction inclusion
    const inferredInteractions = interactions.filter((i) => i.source === 'llm-inferred');
    if (inferredInteractions.length > 0) {
      const inferredCovered = inferredInteractions.filter((i) => coveredIds.has(i.id)).length;
      const inferredCoverage = (inferredCovered / inferredInteractions.length) * 100;
      if (inferredCoverage < thresholds.minInferredCoverage) {
        failures.push({
          gate: 'inferred-interaction-coverage',
          actual: inferredCoverage,
          threshold: thresholds.minInferredCoverage,
          details: `${inferredCovered}/${inferredInteractions.length} inferred (cross-boundary) interactions in flows`,
        });
      }
    }

    return { passed: failures.length === 0, failures };
  }

  /**
   * Reject validator-proposed flows whose actionType has no matching definition
   * in the entry point module. Deterministic safety net against hallucinated flows.
   */
  private filterUnverifiedFlows(flows: FlowSuggestion[], entryPointModules: EntryPointModuleInfo[]): FlowSuggestion[] {
    // Build lookup: moduleId -> set of actionTypes available
    const moduleActions = new Map<number, Set<string>>();
    for (const ep of entryPointModules) {
      const actions = new Set<string>();
      for (const def of ep.memberDefinitions) {
        if (def.actionType) actions.add(def.actionType);
      }
      moduleActions.set(ep.moduleId, actions);
    }

    return flows.filter((flow) => {
      // Only gate flows that claim a specific actionType from a known entry point
      if (!flow.actionType || !flow.entryPointModuleId) return true;
      const available = moduleActions.get(flow.entryPointModuleId);
      if (!available) return true; // Unknown module — let through
      return available.has(flow.actionType);
    });
  }
}
