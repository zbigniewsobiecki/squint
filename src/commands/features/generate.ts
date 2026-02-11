/**
 * Features Generate Command - Groups flows into product-level features using LLM.
 *
 * This is a thin orchestrator that:
 * 1. Reads persisted flows from DB
 * 2. Reads module tree from DB for architectural context
 * 3. Calls FeatureGrouper to group flows into features via LLM
 * 4. Validates the grouping (all flows assigned, no hallucinated slugs)
 * 5. Persists features + feature_flows junction to DB
 */

import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import type { Flow } from '../../db/schema.js';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { logSection, logStep, logVerbose, logWarning } from '../llm/_shared/llm-utils.js';
import { FeatureGrouper, type FeatureSuggestion } from '../llm/features/index.js';

export default class FeaturesGenerate extends BaseLlmCommand {
  static override description = 'Group flows into product-level features using LLM';

  static override examples = [
    '<%= config.bin %> features generate',
    '<%= config.bin %> features generate --dry-run',
    '<%= config.bin %> features generate --force',
    '<%= config.bin %> features generate -d index.db --verbose',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, verbose, model, llmOptions } = ctx;

    // Check if features already exist
    const existingCount = db.features.getCount();
    if (
      !this.checkExistingAndClear(ctx, {
        entityName: 'Features',
        existingCount,
        force: flags.force as boolean,
        clearFn: () => db.features.clear(),
        forceHint: 'Use --force to re-group',
      })
    ) {
      return;
    }

    this.logHeader(ctx, 'Feature Grouping');

    // Step 1: Read all persisted flows from DB
    logStep(this, 1, 'Reading Flows from Database', isJson);

    const allFlows = db.flows.getAll();
    if (allFlows.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ error: 'No flows found', hint: 'Run llm flows first' }));
      } else {
        this.log(chalk.yellow('No flows found.'));
        this.log(chalk.gray('Run `squint llm flows` first to detect flows.'));
      }
      return;
    }

    // Only send tier-1+ flows to LLM — tier-0 atomics are assigned post-hoc
    const llmFlows = allFlows.filter((f) => f.tier >= 1);
    const atomicFlows = allFlows.filter((f) => f.tier === 0);

    logVerbose(
      this,
      `Found ${allFlows.length} flows: ${llmFlows.length} for LLM grouping, ${atomicFlows.length} atomic for post-hoc assignment`,
      verbose,
      isJson
    );

    // Step 2: Read module tree from DB for architectural context
    logStep(this, 2, 'Reading Module Tree for Context', isJson);

    const modules = db.modules.getAll();
    logVerbose(this, `Found ${modules.length} modules`, verbose, isJson);

    // Step 3: Group flows into features using LLM
    logStep(this, 3, 'Grouping Flows into Features (LLM)', isJson);

    const featureGrouper = new FeatureGrouper(this, isJson);
    const featureSuggestions = await featureGrouper.groupFlowsIntoFeatures(llmFlows, modules, model, llmOptions);

    logVerbose(this, `LLM grouped flows into ${featureSuggestions.length} features`, verbose, isJson);

    // Step 4: Persist features
    logStep(this, 4, 'Persisting Features', isJson);

    if (!dryRun) {
      this.persistFeatures(db, featureSuggestions, llmFlows, verbose, isJson);

      // Auto-assign tier-0 flows to features based on entry point module overlap
      if (atomicFlows.length > 0) {
        this.assignAtomicFlows(db, featureSuggestions, atomicFlows, llmFlows, verbose, isJson);
      }
    }

    // Output results
    this.outputResults(featureSuggestions, dryRun, isJson);
  }

  private persistFeatures(
    db: IndexDatabase,
    featureSuggestions: FeatureSuggestion[],
    flows: Array<{ id: number; slug: string }>,
    verbose: boolean,
    isJson: boolean
  ): void {
    const flowSlugToId = new Map(flows.map((f) => [f.slug, f.id]));

    for (const feature of featureSuggestions) {
      try {
        const featureId = db.features.insert(feature.name, feature.slug, {
          description: feature.description,
        });

        const flowIds = feature.flowSlugs
          .map((s) => flowSlugToId.get(s))
          .filter((id): id is number => id !== undefined);

        if (flowIds.length > 0) {
          db.features.addFlows(featureId, flowIds);
        }

        logVerbose(this, `  ${feature.name}: ${flowIds.length} flows`, verbose, isJson);
      } catch {
        logWarning(this, `Skipping feature: ${feature.name}`, isJson);
      }
    }
  }

  /**
   * Auto-assign tier-0 (atomic) flows to features based on shared entry point modules.
   * Unmatched atomics go to an "Internal Infrastructure" catch-all feature.
   */
  private assignAtomicFlows(
    db: IndexDatabase,
    features: FeatureSuggestion[],
    atomicFlows: Flow[],
    llmFlows: Flow[],
    verbose: boolean,
    isJson: boolean
  ): void {
    // Build: flow slug -> feature slug (from LLM-assigned flows)
    const flowSlugToFeature = new Map<string, string>();
    for (const feat of features) {
      for (const slug of feat.flowSlugs) {
        flowSlugToFeature.set(slug, feat.slug);
      }
    }

    // Build: entryPointModuleId -> feature slug (first feature wins)
    const moduleToFeature = new Map<number, string>();
    for (const flow of llmFlows) {
      if (flow.entryPointModuleId && flowSlugToFeature.has(flow.slug)) {
        const featSlug = flowSlugToFeature.get(flow.slug)!;
        if (!moduleToFeature.has(flow.entryPointModuleId)) {
          moduleToFeature.set(flow.entryPointModuleId, featSlug);
        }
      }
    }

    // Resolve feature slug -> feature DB ID
    const allFeatures = db.features.getAll();
    const featureSlugToId = new Map(allFeatures.map((f) => [f.slug, f.id]));

    let assigned = 0;
    const unassigned: Flow[] = [];

    for (const flow of atomicFlows) {
      const featSlug = flow.entryPointModuleId ? moduleToFeature.get(flow.entryPointModuleId) : undefined;
      const featId = featSlug ? featureSlugToId.get(featSlug) : undefined;
      if (featId) {
        db.features.addFlows(featId, [flow.id]);
        assigned++;
      } else {
        unassigned.push(flow);
      }
    }

    // Create catch-all for remaining atomics
    if (unassigned.length > 0) {
      let infraId = featureSlugToId.get('internal-infrastructure');
      if (!infraId) {
        infraId = db.features.insert('Internal Infrastructure', 'internal-infrastructure', {
          description: 'Atomic internal flows not associated with a specific product feature',
        });
      }
      db.features.addFlows(
        infraId,
        unassigned.map((f) => f.id)
      );
      assigned += unassigned.length;
    }

    logVerbose(
      this,
      `  Assigned ${assigned} atomic flows to features (${unassigned.length} to Internal Infrastructure)`,
      verbose,
      isJson
    );
  }

  private outputResults(features: FeatureSuggestion[], dryRun: boolean, isJson: boolean): void {
    const result = {
      featuresCreated: features.length,
      features: features.map((f) => ({
        name: f.name,
        slug: f.slug,
        description: f.description,
        flowCount: f.flowSlugs.length,
      })),
    };

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    } else {
      logSection(this, 'Results', false);
      this.log(`Features created: ${result.featuresCreated}`);

      for (const f of result.features) {
        this.log(`  - ${f.name} (${f.flowCount} flows)`);
      }

      if (dryRun) {
        this.log('');
        this.log(chalk.gray('(Dry run - no changes persisted)'));
      }
    }
  }
}
