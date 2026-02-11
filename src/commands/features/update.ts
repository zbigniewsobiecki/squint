import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { Feature } from '../../db/schema.js';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FeaturesUpdate extends Command {
  static override description = 'Update a feature';

  static override examples = [
    '<%= config.bin %> features update auth --name "Authentication"',
    '<%= config.bin %> features update 3 --description "Updated description"',
  ];

  static override args = {
    'id-or-slug': Args.string({ description: 'Feature ID or slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    name: Flags.string({
      description: 'New feature name',
    }),
    description: Flags.string({
      description: 'New feature description',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FeaturesUpdate);

    if (!flags.name && !flags.description) {
      this.error(chalk.red('At least one of --name or --description is required.'));
    }

    await withDatabase(flags.database, this, async (db) => {
      const feature = this.findFeature(db, args['id-or-slug']);
      if (!feature) {
        this.error(chalk.red(`Feature "${args['id-or-slug']}" not found.`));
      }

      const updates: { name?: string; description?: string } = {};
      if (flags.name) updates.name = flags.name;
      if (flags.description) updates.description = flags.description;

      const updated = db.features.update(feature.id, updates);
      if (!updated) {
        this.error(chalk.red(`Failed to update feature "${args['id-or-slug']}".`));
      }

      this.log(`Updated feature ${chalk.cyan(feature.name)} (${chalk.gray(feature.slug)})`);
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
