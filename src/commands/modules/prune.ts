import { Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class ModulesPrune extends Command {
  static override description = 'Prune empty leaf modules';

  static override examples = ['<%= config.bin %> modules prune', '<%= config.bin %> modules prune -d ./my-index.db'];

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ModulesPrune);

    await withDatabase(flags.database, this, async (db) => {
      const pruned = db.modules.pruneEmptyLeaves();

      if (pruned === 0) {
        this.log(chalk.gray('No empty leaf modules to prune.'));
      } else {
        this.log(`Pruned ${chalk.cyan(String(pruned))} empty leaf module(s)`);
      }
    });
  }
}
