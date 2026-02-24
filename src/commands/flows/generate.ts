/**
 * Flows Generate Command - Detects user journey flows from entry points and traces through interactions.
 *
 * This is a thin orchestrator that composes:
 * - EntryPointDetector: LLM-based entry point module classification
 * - FlowTracer: Definition-level call graph traversal
 * - FlowEnhancer: LLM metadata enhancement for flows
 * - GapFlowGenerator: Creates flows for uncovered interactions
 */

import { Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import { type InteractionWithPaths, isRuntimeInteraction } from '../../db/schema.js';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import {
  calculatePercentage,
  getErrorMessage,
  logSection,
  logStep,
  logVerbose,
  logWarning,
} from '../llm/_shared/llm-utils.js';
import {
  AtomicFlowBuilder,
  EntryPointDetector,
  FlowEnhancer,
  type FlowSuggestion,
  FlowTracer,
  FlowValidator,
  GapFlowGenerator,
  JourneyBuilder,
  buildFlowTracingContext,
  deduplicateByInteractionOverlap,
} from '../llm/flows/index.js';
import type { EntryPointModuleInfo } from '../llm/flows/types.js';

export default class FlowsGenerate extends BaseLlmCommand {
  static override description = 'Detect user journey flows from entry points and trace through interactions';

  static override examples = [
    '<%= config.bin %> flows generate',
    '<%= config.bin %> flows generate --dry-run',
    '<%= config.bin %> flows generate --force',
    '<%= config.bin %> flows generate -d index.db --verbose',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
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
    'max-validator-flows': Flags.integer({
      description: 'Maximum new flows the validator can add per pass',
      default: 60,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, verbose, model, llmOptions } = ctx;

    // Check if flows already exist
    const existingCount = db.flows.getCount();
    if (
      !this.checkExistingAndClear(ctx, {
        entityName: 'Flows',
        existingCount,
        force: flags.force as boolean,
        clearFn: () => {
          db.flows.clear();
          db.features.clear();
        },
        forceHint: 'Use --force to re-detect',
      })
    ) {
      return;
    }

    // Check if interactions exist
    const interactionCount = db.interactions.getCount();
    if (interactionCount === 0) {
      if (isJson) {
        this.log(JSON.stringify({ error: 'No interactions found', hint: 'Run llm interactions first' }));
      } else {
        this.log(chalk.yellow('No interactions found.'));
        this.log(chalk.gray('Run `squint llm interactions` first to detect module interactions.'));
      }
      return;
    }

    this.logHeader(ctx, 'Flow Detection');

    // Step 1: Detect entry point modules using LLM classification
    logStep(this, 1, 'Detecting Entry Point Modules (LLM Classification)', isJson);

    const entryPointDetector = new EntryPointDetector(db, this, isJson, verbose);
    const entryPointModules = await entryPointDetector.detectEntryPointModules(model, llmOptions);

    logVerbose(this, `Found ${entryPointModules.length} LLM-classified entry point modules`, verbose, isJson);

    if (entryPointModules.length === 0 && !isJson) {
      this.log(chalk.yellow('No entry point modules detected.'));
      this.log(chalk.gray('Gap flows will still be created for uncovered interactions.'));
    }

    // Step 2: Build atomic flows (deterministic, no LLM)
    logStep(this, 2, 'Building Atomic Flows (Tier 0)', isJson);

    const allInteractions = db.interactions.getAll();
    // Filter once at the top: only runtime interactions (excludes ast-import and test-internal)
    const interactions = allInteractions.filter(isRuntimeInteraction);
    const allModules = db.modules.getAll();
    const allModulesWithMembers = db.modules.getAllWithMembers();

    logVerbose(
      this,
      `Filtered to ${interactions.length}/${allInteractions.length} runtime interactions (excluded ${allInteractions.length - interactions.length} ast-import/test-internal)`,
      verbose,
      isJson
    );

    // Build entity overrides from LLM-classified entry points for entity grouping
    const moduleEntityOverrides = new Map<number, string>();
    for (const ep of entryPointModules) {
      for (const def of ep.memberDefinitions) {
        if (def.targetEntity && !moduleEntityOverrides.has(ep.moduleId)) {
          moduleEntityOverrides.set(ep.moduleId, def.targetEntity);
        }
      }
    }

    const atomicFlowBuilder = new AtomicFlowBuilder();
    const atomicFlows = atomicFlowBuilder.buildAtomicFlows(interactions, allModules, moduleEntityOverrides);

    const atomicCoverage = new Set(atomicFlows.flatMap((f) => f.interactionIds));
    const atomicCoverageCount = interactions.filter((i) => atomicCoverage.has(i.id)).length;
    logVerbose(
      this,
      `Built ${atomicFlows.length} atomic flows covering ${atomicCoverageCount}/${interactions.length} runtime interactions`,
      verbose,
      isJson
    );

    // Step 3: Trace composite flows from entry points (tier 1)
    logStep(this, 3, 'Tracing Composite Flows from Entry Points (Tier 1)', isJson);

    const definitionCallGraph = db.interactions.getDefinitionCallGraphMap();
    const entryPointModuleIds = new Set(entryPointModules.map((ep) => ep.moduleId));
    const definitionLinks = db.interactions.getAllDefinitionLinks();
    const tracingContext = buildFlowTracingContext(
      definitionCallGraph,
      allModulesWithMembers,
      interactions,
      entryPointModuleIds,
      definitionLinks
    );
    const flowTracer = new FlowTracer(tracingContext);
    const flowSuggestions = flowTracer.traceFlowsFromEntryPoints(entryPointModules, atomicFlows);

    logVerbose(this, `Traced ${flowSuggestions.length} composite flows`, verbose, isJson);

    // Step 4: Enhance composite flow metadata with LLM (skip tier-0)
    logStep(this, 4, 'Enhancing Composite Flow Metadata with LLM', isJson);

    const sharedFlowEnhancer = new FlowEnhancer(this, isJson);
    let enhancedFlows: FlowSuggestion[] = [...atomicFlows];
    if (flowSuggestions.length > 0) {
      try {
        const enhanced = await sharedFlowEnhancer.enhanceFlowsWithLLM(flowSuggestions, interactions, model, llmOptions);
        enhancedFlows.push(...enhanced);
        logVerbose(this, `Enhanced ${enhanced.length} composite flows`, verbose, isJson);
      } catch (error) {
        const message = getErrorMessage(error);
        if (!isJson) {
          this.log(chalk.yellow(`LLM enhancement failed: ${message}`));
        }
        enhancedFlows.push(...flowSuggestions);
      }
    }

    // Step 5: Create gap flows for uncovered interactions (tier 0)
    logStep(this, 5, 'Creating Gap Flows for Uncovered Interactions', isJson);

    let coveredIds = new Set(enhancedFlows.flatMap((f) => f.interactionIds));
    const gapFlowGenerator = new GapFlowGenerator();
    let gapFlows = gapFlowGenerator.createGapFlows(coveredIds, interactions);
    enhancedFlows.push(...gapFlows);

    logVerbose(this, `Created ${gapFlows.length} gap flows for uncovered interactions`, verbose, isJson);

    // Step 6: Validate flow completeness (LLM review) with auto-retry loop
    logStep(this, 6, 'Validating Flow Completeness (LLM Review)', isJson);

    const maxGateRetries = flags['max-gate-retries'] as number;
    const thresholds = {
      minInteractionCoverage: flags['min-interaction-coverage'] as number,
      maxGapFlowRatio: flags['max-gap-flow-ratio'] as number,
      minEntryPointYield: flags['min-entry-point-yield'] as number,
      minInferredCoverage: flags['min-inferred-coverage'] as number,
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
          entryPointModules,
          atomicFlows
        );

        // Post-validation gate: reject flows whose actionType doesn't exist in entry point definitions
        let verifiedFlows = this.filterUnverifiedFlows(validatorFlows, entryPointModules);
        const gateRejects = validatorFlows.length - verifiedFlows.length;
        if (gateRejects > 0) {
          logVerbose(
            this,
            `  Rejected ${gateRejects} flows: actionType not found in entry point definitions`,
            verbose,
            isJson
          );
        }

        // Cap validator output to prevent flow explosion
        const maxValidatorFlows = flags['max-validator-flows'] as number;
        if (verifiedFlows.length > maxValidatorFlows) {
          // Rank by quality: grounded flows (with actionType+targetEntity) first, then by interaction count
          verifiedFlows.sort((a, b) => {
            const aScore = (a.actionType ? 2 : 0) + (a.targetEntity ? 1 : 0) + Math.min(a.interactionIds.length, 5);
            const bScore = (b.actionType ? 2 : 0) + (b.targetEntity ? 1 : 0) + Math.min(b.interactionIds.length, 5);
            return bScore - aScore;
          });
          const dropped = verifiedFlows.length - maxValidatorFlows;
          verifiedFlows = verifiedFlows.slice(0, maxValidatorFlows);
          logVerbose(
            this,
            `  Capped validator flows: kept ${maxValidatorFlows}, dropped ${dropped} lowest-quality`,
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

    // Interaction-overlap dedup across all tiers
    const preDedup = enhancedFlows.length;
    enhancedFlows = deduplicateByInteractionOverlap(enhancedFlows);
    const dedupRemoved = preDedup - enhancedFlows.length;
    if (dedupRemoved > 0) {
      logVerbose(this, `Interaction-overlap dedup removed ${dedupRemoved} flows`, verbose, isJson);
    }

    // Post-dedup gap flow pass to restore coverage for any interactions lost during dedup
    const finalCoveredIds = new Set(enhancedFlows.flatMap((f) => f.interactionIds));
    const finalGapFlows = gapFlowGenerator.createGapFlows(finalCoveredIds, interactions);
    if (finalGapFlows.length > 0) {
      enhancedFlows.push(...finalGapFlows);
      logVerbose(this, `Post-dedup gap pass added ${finalGapFlows.length} flows to restore coverage`, verbose, isJson);
    }

    // Build tier 2 journey flows from tier 1 composites
    const journeyBuilder = new JourneyBuilder();
    const journeyFlows = journeyBuilder.buildJourneys(enhancedFlows.filter((f) => f.tier === 1));
    if (journeyFlows.length > 0) {
      enhancedFlows.push(...journeyFlows);
      logVerbose(this, `Built ${journeyFlows.length} tier 2 journey flows`, verbose, isJson);
    }

    // Step 7: Persist all tiers (atomics first, then composites with subflow refs)
    logStep(this, 7, 'Persisting Flows', isJson);

    if (!dryRun && enhancedFlows.length > 0) {
      this.persistFlows(db, enhancedFlows, verbose, isJson);
    }

    // Output results
    this.outputResults(db, enhancedFlows, gapFlows, entryPointModules, interactions, dryRun, isJson);
  }

  /**
   * Persist flows to the database.
   * Persists tier-0 first (to get IDs), then tier-1+ with subflow step refs.
   */
  private persistFlows(db: IndexDatabase, flows: FlowSuggestion[], verbose: boolean, isJson: boolean): void {
    const usedSlugs = new Set<string>();
    const slugToFlowId = new Map<string, number>();

    // Sort: tier-0 first, then tier-1, then tier-2
    const sorted = [...flows].sort((a, b) => a.tier - b.tier);

    for (const flow of sorted) {
      const slug = flow.slug;
      if (usedSlugs.has(slug)) {
        logVerbose(this, `  Skipping duplicate flow: ${flow.name} (slug: ${slug})`, verbose, isJson);
        continue;
      }
      usedSlugs.add(slug);

      try {
        const flowId = db.flows.insert(flow.name, slug, {
          entryPointModuleId: flow.entryPointModuleId ?? undefined,
          entryPointId: flow.entryPointId ?? undefined,
          entryPath: flow.entryPath,
          stakeholder: flow.stakeholder,
          description: flow.description,
          actionType: flow.actionType ?? undefined,
          targetEntity: flow.targetEntity ?? undefined,
          tier: flow.tier,
        });

        slugToFlowId.set(slug, flowId);

        // Add module-level steps
        if (flow.interactionIds.length > 0) {
          db.flows.addSteps(flowId, flow.interactionIds);
        }

        // Add definition-level steps
        if (flow.definitionSteps.length > 0) {
          db.flows.addDefinitionSteps(
            flowId,
            flow.definitionSteps.map((s) => ({
              fromDefinitionId: s.fromDefinitionId,
              toDefinitionId: s.toDefinitionId,
            }))
          );
        }

        // Add subflow step references (for composite flows)
        if (flow.subflowSlugs.length > 0) {
          const subflowIds = flow.subflowSlugs
            .map((s) => slugToFlowId.get(s))
            .filter((id): id is number => id !== undefined);
          if (subflowIds.length > 0) {
            db.flows.addSubflowSteps(flowId, subflowIds);
          }
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

    // interactions is already filtered to runtime-only
    const coveredInteractionIds = new Set(enhancedFlows.flatMap((f) => f.interactionIds));
    const coveredCount = interactions.filter((i) => coveredInteractionIds.has(i.id)).length;
    const coverage = dryRun
      ? {
          totalInteractions: interactions.length,
          coveredByFlows: coveredCount,
          percentage: calculatePercentage(coveredCount, interactions.length),
        }
      : db.flows.getCoverage();

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
        `Interaction coverage: ${coverage.coveredByFlows}/${coverage.totalInteractions} runtime (${coverage.percentage.toFixed(1)}%)`
      );

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

    // Filter to runtime interactions only (excludes ast-import and test-internal)
    const relevantInteractions = interactions.filter(isRuntimeInteraction);

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
      if (!available) return false; // Not a known entry point — reject
      return available.has(flow.actionType);
    });
  }
}
