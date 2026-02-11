import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { Feature } from '../../db/schema.js';
import {
  SharedFlags,
  collectModuleIdsFromSteps,
  outputJsonOrPlain,
  resolveModuleIds,
  withDatabase,
} from '../_shared/index.js';

export default class FeaturesShow extends Command {
  static override description = 'Show feature details with associated flows';

  static override examples = [
    '<%= config.bin %> features show auth-feature',
    '<%= config.bin %> features show 3 --json',
  ];

  static override args = {
    'id-or-slug': Args.string({ description: 'Feature ID or slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FeaturesShow);

    await withDatabase(flags.database, this, async (db) => {
      const feature = this.findFeature(db, args['id-or-slug']);
      if (!feature) {
        this.error(chalk.red(`Feature "${args['id-or-slug']}" not found.`));
      }

      const featureWithFlows = db.features.getWithFlows(feature.id);
      const flowList = featureWithFlows?.flows ?? [];

      // Enrich flows with step count, stakeholder, and entry path
      const enrichedFlows = flowList.map((flow) => {
        const withSteps = db.flows.getWithSteps(flow.id);
        return {
          id: flow.id,
          name: flow.name,
          slug: flow.slug,
          description: flow.description,
          stakeholder: flow.stakeholder,
          entryPath: flow.entryPath,
          stepCount: withSteps?.steps.length ?? 0,
        };
      });

      // Collect modules and interactions from all flow steps (deduplicated)
      const moduleIdSet = new Set<number>();
      const interactionMap = new Map<
        number,
        { id: number; fromModulePath: string; toModulePath: string; pattern: string | null; semantic: string | null }
      >();
      for (const flow of flowList) {
        const withSteps = db.flows.getWithSteps(flow.id);
        if (withSteps) {
          const stepModuleIds = collectModuleIdsFromSteps(withSteps.steps);
          for (const id of stepModuleIds) moduleIdSet.add(id);
          for (const step of withSteps.steps) {
            if (!interactionMap.has(step.interaction.id)) {
              interactionMap.set(step.interaction.id, {
                id: step.interaction.id,
                fromModulePath: step.interaction.fromModulePath,
                toModulePath: step.interaction.toModulePath,
                pattern: step.interaction.pattern,
                semantic: step.interaction.semantic,
              });
            }
          }
        }
      }

      const modulesInvolved = resolveModuleIds(moduleIdSet, db);
      const interactions = Array.from(interactionMap.values());

      // Stats
      const byStakeholder: Record<string, number> = {};
      for (const f of enrichedFlows) {
        if (f.stakeholder) {
          byStakeholder[f.stakeholder] = (byStakeholder[f.stakeholder] ?? 0) + 1;
        }
      }
      const stats = {
        flowCount: enrichedFlows.length,
        byStakeholder,
      };

      const jsonData = {
        id: feature.id,
        name: feature.name,
        slug: feature.slug,
        description: feature.description,
        createdAt: feature.createdAt,
        flows: enrichedFlows,
        modulesInvolved,
        interactions,
        stats,
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        this.log(chalk.bold(`Feature: ${chalk.cyan(feature.name)}`));
        this.log(`Slug: ${chalk.gray(feature.slug)}`);
        if (feature.description) {
          this.log(`Description: ${feature.description}`);
        }
        if (feature.createdAt) {
          this.log(`Created: ${feature.createdAt}`);
        }

        // Stats
        this.log(`Flows: ${enrichedFlows.length}`);
        if (Object.keys(byStakeholder).length > 0) {
          const stakeholderStr = Object.entries(byStakeholder)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          this.log(`By Stakeholder: ${stakeholderStr}`);
        }

        if (enrichedFlows.length > 0) {
          this.log('');
          this.log(chalk.bold(`Associated Flows (${enrichedFlows.length})`));
          for (const flow of enrichedFlows) {
            const stakeholder = flow.stakeholder ? chalk.gray(` [${flow.stakeholder}]`) : '';
            const steps = flow.stepCount > 0 ? chalk.gray(` (${flow.stepCount} steps)`) : '';
            this.log(`  ${chalk.cyan(flow.name)} ${chalk.gray(`(${flow.slug})`)}${stakeholder}${steps}`);
            if (flow.description) {
              this.log(`    ${chalk.gray(flow.description)}`);
            }
          }
        } else {
          this.log('');
          this.log(chalk.gray('No flows associated with this feature.'));
        }

        if (modulesInvolved.length > 0) {
          this.log('');
          this.log(chalk.bold(`Modules Involved (${modulesInvolved.length})`));
          for (const m of modulesInvolved) {
            this.log(`  ${chalk.cyan(m.name)} ${chalk.gray(`(${m.fullPath})`)}`);
          }
        }

        if (interactions.length > 0) {
          this.log('');
          this.log(chalk.bold(`Interactions (${interactions.length})`));
          for (const i of interactions) {
            const pattern = i.pattern ? ` [${i.pattern}]` : '';
            const semantic = i.semantic ? ` "${i.semantic}"` : '';
            this.log(
              `  ${chalk.cyan(i.fromModulePath)} -> ${chalk.cyan(i.toModulePath)}${pattern}${chalk.gray(semantic)}`
            );
          }
        }
      });
    });
  }

  private findFeature(
    db: { features: { getById(id: number): Feature | null; getBySlug(slug: string): Feature | null } },
    identifier: string
  ): Feature | null {
    const id = Number.parseInt(identifier, 10);
    if (!Number.isNaN(id)) {
      const feature = db.features.getById(id);
      if (feature) return feature;
    }
    return db.features.getBySlug(identifier);
  }
}
