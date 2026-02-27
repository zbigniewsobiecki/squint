/**
 * Flows Generate Command - LLM-first flow architecture.
 *
 * 6-step pipeline:
 * 1. EntryPointDetector.detectEntryPointModules() — LLM entry point classification
 * 2. FlowArchitect.designFlows()                  — Single LLM call designs all flows
 * 3. FlowArchitect.validateFlows()                 — Deterministic validation
 * 4. FlowArchitect.enrichWithDefinitionSteps()     — Linear definition walk
 * 5. JourneyBuilder.buildJourneys()                — Compose tier-2 journeys
 * 6. Dedup + persist                               — Safety net dedup
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
  EntryPointDetector,
  FlowArchitect,
  type FlowSuggestion,
  JourneyBuilder,
  deduplicateByInteractionOverlap,
  deduplicateByInteractionSet,
} from '../llm/flows/index.js';

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
    incremental: Flags.boolean({
      description: 'Skip if no dirty flows, otherwise full rebuild',
      default: false,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, verbose, model, llmOptions } = ctx;

    // Incremental mode: skip entirely if no dirty flows, otherwise fall back to full rebuild
    if (flags.incremental as boolean) {
      const dirtyFlowCount = db.syncDirty.count('flows');
      if (dirtyFlowCount === 0) {
        if (!isJson) {
          this.log(chalk.gray('No dirty flows — skipping flow generation.'));
        }
        return;
      }
      if (!isJson && verbose) {
        this.log(chalk.gray(`${dirtyFlowCount} dirty flow entries — running full flow rebuild.`));
      }
      db.flows.clear();
      db.features.clear();
    } else {
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

    // Load data
    const allInteractions = db.interactions.getAll();
    const interactions = allInteractions.filter(isRuntimeInteraction);
    const allModules = db.modules.getAll();
    const allModulesWithMembers = db.modules.getAllWithMembers();

    logVerbose(
      this,
      `Filtered to ${interactions.length}/${allInteractions.length} runtime interactions`,
      verbose,
      isJson
    );

    // Build lookup maps
    const modulePathToId = new Map<string, number>();
    for (const m of allModules) {
      modulePathToId.set(m.fullPath, m.id);
    }

    const interactionByModulePair = new Map<string, number>();
    for (const i of interactions) {
      interactionByModulePair.set(`${i.fromModuleId}->${i.toModuleId}`, i.id);
    }

    const flowArchitect = new FlowArchitect(this, isJson, verbose);

    // ── Step 1: Entry Point Detection ──
    logStep(this, 1, 'Detecting Entry Point Modules (LLM Classification)', isJson);

    const entryPointDetector = new EntryPointDetector(db, this, isJson, verbose);
    const entryPointModules = await entryPointDetector.detectEntryPointModules(model, llmOptions);

    logVerbose(this, `Found ${entryPointModules.length} entry point modules`, verbose, isJson);

    if (entryPointModules.length === 0 && !isJson) {
      this.log(chalk.yellow('No entry point modules detected.'));
      return;
    }

    // ── Step 2: Flow Architecture (LLM designs all flows) ──
    logStep(this, 2, 'Designing Flows (LLM Architecture)', isJson);

    const modulesForLlm = allModules.map((m) => ({
      id: m.id,
      fullPath: m.fullPath,
      description: m.description,
    }));

    const interactionsForLlm = interactions.map((i) => ({
      id: i.id,
      fromModuleId: i.fromModuleId,
      toModuleId: i.toModuleId,
      fromModulePath: i.fromModulePath,
      toModulePath: i.toModulePath,
      source: i.source,
      semantic: i.semantic,
      weight: i.weight,
    }));

    let designedFlows: Awaited<ReturnType<FlowArchitect['designFlows']>>;
    try {
      designedFlows = await flowArchitect.designFlows(
        model,
        modulesForLlm,
        entryPointModules,
        interactionsForLlm,
        llmOptions
      );
    } catch (error) {
      const message = getErrorMessage(error);
      logWarning(this, `Flow design failed: ${message}`, isJson);
      return;
    }

    logVerbose(this, `LLM designed ${designedFlows.length} flows`, verbose, isJson);

    if (designedFlows.length === 0) {
      logWarning(this, 'LLM returned 0 flows — nothing to validate.', isJson);
      return;
    }

    // ── Step 3: Flow Validation ──
    logStep(this, 3, 'Validating Flows Against Interaction Graph', isJson);

    let validationResult = flowArchitect.validateFlows(
      designedFlows,
      interactionByModulePair,
      modulePathToId,
      entryPointModules
    );

    // Retry once if >20% failure rate
    const totalDesigned = designedFlows.length;
    if (totalDesigned > 0 && validationResult.failedCount / totalDesigned > 0.2) {
      logVerbose(
        this,
        `  High failure rate (${validationResult.failedCount}/${totalDesigned}), retrying with feedback`,
        verbose,
        isJson
      );

      try {
        designedFlows = await flowArchitect.designFlows(
          model,
          modulesForLlm,
          entryPointModules,
          interactionsForLlm,
          llmOptions,
          validationResult.failureReasons.slice(0, 20) // Cap feedback
        );

        validationResult = flowArchitect.validateFlows(
          designedFlows,
          interactionByModulePair,
          modulePathToId,
          entryPointModules
        );
      } catch (error) {
        const message = getErrorMessage(error);
        logWarning(this, `  Retry failed: ${message}`, isJson);
      }
    }

    let flows = validationResult.validFlows;

    // Resolve entry point IDs
    FlowArchitect.resolveEntryPointIds(flows, entryPointModules);

    logVerbose(this, `Validated: ${flows.length} flows (${validationResult.failedCount} failed)`, verbose, isJson);

    // ── Step 4: Definition Enrichment ──
    logStep(this, 4, 'Enriching Flows with Definition Steps', isJson);

    try {
      const definitionCallGraph = db.interactions.getDefinitionCallGraphMap();
      const definitionLinks = db.interactions.getAllDefinitionLinks();
      const ctx = FlowArchitect.buildDefinitionContext(definitionCallGraph, definitionLinks, allModulesWithMembers);

      let enrichedCount = 0;
      for (const flow of flows) {
        const defSteps = flowArchitect.enrichWithDefinitionSteps(flow, ctx, flow.entryPointId, interactionByModulePair);
        if (defSteps.length > 0) {
          flow.definitionSteps = defSteps;
          enrichedCount++;
        }
      }
      logVerbose(this, `Enriched ${enrichedCount}/${flows.length} flows with definition steps`, verbose, isJson);
    } catch (error) {
      const message = getErrorMessage(error);
      logVerbose(this, `  Definition enrichment skipped: ${message}`, verbose, isJson);
    }

    // ── Step 5: Journey Composition ──
    logStep(this, 5, 'Building Journey Flows', isJson);

    const journeyBuilder = new JourneyBuilder();
    const journeyFlows = journeyBuilder.buildJourneys(flows.filter((f) => f.tier === 1));
    if (journeyFlows.length > 0) {
      flows.push(...journeyFlows);
      logVerbose(this, `Built ${journeyFlows.length} tier 2 journey flows`, verbose, isJson);
    }

    // ── Step 6: Dedup & Persist ──
    logStep(this, 6, 'Deduplicating and Persisting Flows', isJson);

    const preDedup = flows.length;
    flows = deduplicateByInteractionOverlap(flows, 0.75);
    const afterOverlap = flows.length;
    flows = deduplicateByInteractionSet(flows);
    const afterSet = flows.length;

    if (preDedup - afterOverlap > 0) {
      logVerbose(this, `Overlap dedup removed ${preDedup - afterOverlap} flows`, verbose, isJson);
    }
    if (afterOverlap - afterSet > 0) {
      logVerbose(this, `Exact-set dedup removed ${afterOverlap - afterSet} flows`, verbose, isJson);
    }

    let persistedCount = flows.length;
    if (!dryRun && flows.length > 0) {
      persistedCount = this.persistFlows(db, flows, verbose, isJson);
    }

    // Output results
    this.outputResults(db, flows, persistedCount, entryPointModules, interactions, dryRun, isJson);
  }

  /**
   * Persist flows to the database.
   */
  private persistFlows(db: IndexDatabase, flows: FlowSuggestion[], verbose: boolean, isJson: boolean): number {
    const usedSlugs = new Set<string>();
    const slugToFlowId = new Map<string, number>();

    // Sort: tier-1 first, then tier-2
    const sorted = [...flows].sort((a, b) => a.tier - b.tier);
    let persistedCount = 0;

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
        persistedCount++;

        if (flow.interactionIds.length > 0) {
          db.flows.addSteps(flowId, flow.interactionIds);
        }

        if (flow.definitionSteps.length > 0) {
          db.flows.addDefinitionSteps(
            flowId,
            flow.definitionSteps.map((s) => ({
              fromDefinitionId: s.fromDefinitionId,
              toDefinitionId: s.toDefinitionId,
            }))
          );
        }

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

    return persistedCount;
  }

  /**
   * Output results in JSON or human-readable format.
   */
  private outputResults(
    db: IndexDatabase,
    flows: FlowSuggestion[],
    persistedCount: number,
    entryPointModules: Array<{ moduleId: number }>,
    interactions: InteractionWithPaths[],
    dryRun: boolean,
    isJson: boolean
  ): void {
    const coveredInteractionIds = new Set(flows.flatMap((f) => f.interactionIds));
    const coveredCount = interactions.filter((i) => coveredInteractionIds.has(i.id)).length;
    const coverage = dryRun
      ? {
          totalInteractions: interactions.length,
          coveredByFlows: coveredCount,
          percentage: calculatePercentage(coveredCount, interactions.length),
        }
      : db.flows.getCoverage();

    const tier1Count = flows.filter((f) => f.tier === 1).length;
    const tier2Count = flows.filter((f) => f.tier === 2).length;

    const result = {
      entryPointModules: entryPointModules.length,
      flowsCreated: persistedCount,
      tier1Flows: tier1Count,
      tier2Journeys: tier2Count,
      // Backward compatibility: old JSON shape aliases
      userFlows: tier1Count + tier2Count,
      internalFlows: 0,
      coverage,
    };

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    } else {
      logSection(this, 'Results', false);
      this.log(`Entry point modules detected: ${result.entryPointModules} (LLM classified)`);
      this.log(`Flows created: ${result.flowsCreated}`);
      this.log(`  - Tier 1 (operations): ${result.tier1Flows}`);
      this.log(`  - Tier 2 (journeys): ${result.tier2Journeys}`);
      this.log(
        `Interaction coverage: ${coverage.coveredByFlows}/${coverage.totalInteractions} runtime (${coverage.percentage.toFixed(1)}%)`
      );

      if (dryRun) {
        this.log('');
        this.log(chalk.gray('(Dry run - no changes persisted)'));
      }
    }
  }
}
