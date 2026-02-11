import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class DomainsUpdate extends Command {
  static override description = 'Update a domain description';

  static override examples = ['<%= config.bin %> domains update auth --description "Authentication and authorization"'];

  static override args = {
    name: Args.string({ description: 'Domain name', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    description: Flags.string({
      description: 'New domain description',
      required: true,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DomainsUpdate);

    await withDatabase(flags.database, this, async (db) => {
      const updated = db.domains.updateDescription(args.name, flags.description);

      if (!updated) {
        this.error(chalk.red(`Domain "${args.name}" not found.`));
      }

      this.log(`Updated domain ${chalk.cyan(args.name)} description`);
    });
  }
}
