import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class InteractionsDelete extends Command {
  static override description = 'Delete an interaction';

  static override examples = ['<%= config.bin %> interactions delete 5'];

  static override args = {
    id: Args.integer({ description: 'Interaction ID', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(InteractionsDelete);

    await withDatabase(flags.database, this, async (db) => {
      const existing = db.interactions.getById(args.id);
      if (!existing) {
        this.error(chalk.red(`Interaction ${args.id} not found.`));
      }

      const deleted = db.interactions.delete(args.id);
      if (!deleted) {
        this.error(chalk.red(`Failed to delete interaction ${args.id}.`));
      }

      this.log(`Deleted interaction ${chalk.cyan(String(args.id))}`);
    });
  }
}
