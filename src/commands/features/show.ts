import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { Feature } from '../../db/schema.js';
import { SharedFlags, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

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

      outputJsonOrPlain(this, flags.json, featureWithFlows, () => {
        this.log(chalk.bold(`Feature: ${chalk.cyan(feature.name)}`));
        this.log(`Slug: ${chalk.gray(feature.slug)}`);
        if (feature.description) {
          this.log(`Description: ${feature.description}`);
        }
        if (feature.createdAt) {
          this.log(`Created: ${feature.createdAt}`);
        }

        if (featureWithFlows && featureWithFlows.flows.length > 0) {
          this.log('');
          this.log(chalk.bold(`Associated Flows (${featureWithFlows.flows.length})`));
          for (const flow of featureWithFlows.flows) {
            this.log(`  ${chalk.cyan(flow.name)} ${chalk.gray(`(${flow.slug})`)}`);
            if (flow.description) {
              this.log(`    ${chalk.gray(flow.description)}`);
            }
          }
        } else {
          this.log('');
          this.log(chalk.gray('No flows associated with this feature.'));
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
