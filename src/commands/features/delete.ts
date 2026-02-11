import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { Feature } from '../../db/schema.js';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FeaturesDelete extends Command {
  static override description = 'Delete a feature';

  static override examples = ['<%= config.bin %> features delete auth', '<%= config.bin %> features delete 3'];

  static override args = {
    'id-or-slug': Args.string({ description: 'Feature ID or slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FeaturesDelete);

    await withDatabase(flags.database, this, async (db) => {
      const feature = this.findFeature(db, args['id-or-slug']);
      if (!feature) {
        this.error(chalk.red(`Feature "${args['id-or-slug']}" not found.`));
      }

      const deleted = db.features.delete(feature.id);
      if (!deleted) {
        this.error(chalk.red(`Failed to delete feature "${args['id-or-slug']}".`));
      }

      this.log(`Deleted feature ${chalk.cyan(feature.name)} (${chalk.gray(feature.slug)})`);
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
