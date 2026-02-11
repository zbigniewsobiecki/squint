import { Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

export default class FeaturesList extends Command {
  static override description = 'List all features with flow counts';

  static override examples = ['<%= config.bin %> features', '<%= config.bin %> features --json'];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(FeaturesList);

    await withDatabase(flags.database, this, async (db) => {
      const features = db.features.getAll();

      // Get flow counts for each feature
      const featuresWithFlows = features.map((f) => {
        const withFlows = db.features.getWithFlows(f.id);
        return {
          ...f,
          flowCount: withFlows?.flows.length ?? 0,
        };
      });

      const jsonData = {
        features: featuresWithFlows,
        count: features.length,
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        if (features.length === 0) {
          this.log(chalk.gray('No features found.'));
          this.log(chalk.gray('Run `squint features create <name> <slug>` to create a feature.'));
          return;
        }

        this.log(chalk.bold(`Features (${features.length})`));
        this.log('');

        for (const f of featuresWithFlows) {
          this.log(`  ${chalk.cyan(f.name)} ${chalk.gray(`(${f.slug})`)} - ${f.flowCount} flow(s)`);
          if (f.description) {
            this.log(`    ${chalk.gray(f.description)}`);
          }
        }
      });
    });
  }
}
