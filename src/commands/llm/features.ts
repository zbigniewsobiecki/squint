/**
 * Features Command - Groups flows into product-level features using LLM.
 *
 * This is a thin orchestrator that:
 * 1. Reads persisted flows from DB
 * 2. Reads module tree from DB for architectural context
 * 3. Calls FeatureGrouper to group flows into features via LLM
 * 4. Validates the grouping (all flows assigned, no hallucinated slugs)
 * 5. Persists features + feature_flows junction to DB
 */

import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';
import { logSection, logStep, logVerbose, logWarning } from './_shared/llm-utils.js';
import { FeatureGrouper, type FeatureSuggestion } from './features/index.js';

export default class Features extends Command {
  static override description = 'Group flows into product-level features using LLM';

  static override examples = [
    '<%= config.bin %> llm features',
    '<%= config.bin %> llm features --dry-run',
    '<%= config.bin %> llm features --force',
    '<%= config.bin %> llm features -d index.db --verbose',
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
      description: 'Re-group even if features exist',
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
    const { flags } = await this.parse(Features);

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
      // Check if features already exist
      const existingCount = db.getFeatureCount();
      if (existingCount > 0 && !flags.force) {
        if (isJson) {
          this.log(
            JSON.stringify({
              error: 'Features already exist',
              count: existingCount,
              hint: 'Use --force to re-group',
            })
          );
        } else {
          this.log(chalk.yellow(`${existingCount} features already exist.`));
          this.log(chalk.gray('Use --force to re-group features.'));
        }
        return;
      }

      if (!isJson) {
        this.log(chalk.bold('Feature Grouping'));
        this.log(chalk.gray(`Model: ${model}`));
        this.log('');
      }

      // Step 1: Read all persisted flows from DB
      logStep(this, 1, 'Reading Flows from Database', isJson);

      const flows = db.getAllFlows();
      if (flows.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ error: 'No flows found', hint: 'Run llm flows first' }));
        } else {
          this.log(chalk.yellow('No flows found.'));
          this.log(chalk.gray('Run `squint llm flows` first to detect flows.'));
        }
        return;
      }

      logVerbose(this, `Found ${flows.length} flows`, verbose, isJson);

      // Step 2: Read module tree from DB for architectural context
      logStep(this, 2, 'Reading Module Tree for Context', isJson);

      const modules = db.getAllModules();
      logVerbose(this, `Found ${modules.length} modules`, verbose, isJson);

      // Step 3: Group flows into features using LLM
      logStep(this, 3, 'Grouping Flows into Features (LLM)', isJson);

      const featureGrouper = new FeatureGrouper(this, isJson);
      const featureSuggestions = await featureGrouper.groupFlowsIntoFeatures(flows, modules, model, llmOptions);

      logVerbose(this, `LLM grouped flows into ${featureSuggestions.length} features`, verbose, isJson);

      // Step 4: Persist features
      logStep(this, 4, 'Persisting Features', isJson);

      // Clear existing features if force
      if (existingCount > 0 && flags.force && !dryRun) {
        db.clearFeatures();
        logVerbose(this, `Cleared ${existingCount} existing features`, verbose, isJson);
      }

      if (!dryRun) {
        this.persistFeatures(db, featureSuggestions, flows, verbose, isJson);
      }

      // Output results
      this.outputResults(featureSuggestions, dryRun, isJson);
    } finally {
      db.close();
    }
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
        const featureId = db.insertFeature(feature.name, feature.slug, {
          description: feature.description,
        });

        const flowIds = feature.flowSlugs
          .map((s) => flowSlugToId.get(s))
          .filter((id): id is number => id !== undefined);

        if (flowIds.length > 0) {
          db.addFeatureFlows(featureId, flowIds);
        }

        logVerbose(this, `  ${feature.name}: ${flowIds.length} flows`, verbose, isJson);
      } catch {
        logWarning(this, `Skipping feature: ${feature.name}`, isJson);
      }
    }
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
