import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class Rename extends Command {
  static override description = 'Rename a domain (updates registry and all symbol metadata)';

  static override examples = ['<%= config.bin %> domains rename auth authentication'];

  static override args = {
    oldName: Args.string({ description: 'Current domain name', required: true }),
    newName: Args.string({ description: 'New domain name', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Rename);

    await withDatabase(flags.database, this, async (db) => {
      // Check if new name already exists
      if (db.getDomain(args.newName)) {
        this.error(chalk.red(`Domain "${args.newName}" already exists.`));
      }

      // Rename the domain
      const result = db.renameDomain(args.oldName, args.newName);

      if (!result.updated && result.symbolsUpdated === 0) {
        this.error(chalk.red(`Domain "${args.oldName}" not found.`));
      }

      this.log(`Renamed domain ${chalk.yellow(args.oldName)} -> ${chalk.cyan(args.newName)}`);
      if (result.symbolsUpdated > 0) {
        this.log(`Updated ${chalk.green(result.symbolsUpdated)} symbol${result.symbolsUpdated !== 1 ? 's' : ''}`);
      }
    });
  }
}
