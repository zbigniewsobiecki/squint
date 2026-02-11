import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FeaturesCreate extends Command {
  static override description = 'Create a new feature';

  static override examples = [
    '<%= config.bin %> features create "User Authentication" auth',
    '<%= config.bin %> features create "Payment Processing" payment --description "Handles all payment flows"',
  ];

  static override args = {
    name: Args.string({ description: 'Feature name', required: true }),
    slug: Args.string({ description: 'Feature slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    description: Flags.string({
      description: 'Feature description',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FeaturesCreate);

    await withDatabase(flags.database, this, async (db) => {
      const id = db.features.insert(args.name, args.slug, {
        description: flags.description,
      });

      this.log(`Created feature ${chalk.cyan(args.name)} (${chalk.gray(args.slug)}) with id ${chalk.cyan(String(id))}`);
    });
  }
}
