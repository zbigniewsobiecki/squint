import { Command } from '@oclif/core';
import chalk from 'chalk';
import { withDatabase, SharedFlags } from '../_shared/index.js';

export default class Sync extends Command {
  static override description = 'Register all domains currently in use (bulk registration)';

  static override examples = [
    '<%= config.bin %> domains sync',
    '<%= config.bin %> domains sync --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Sync);

    await withDatabase(flags.database, this, async (db) => {
      // Sync domains from metadata
      const registered = db.syncDomainsFromMetadata();

      if (flags.json) {
        this.log(JSON.stringify({ registered }, null, 2));
      } else if (registered.length === 0) {
        this.log(chalk.green('All domains in use are already registered.'));
      } else {
        this.log(`Registered ${chalk.green(registered.length)} new domain(s):`);
        for (const domain of registered) {
          this.log(`  ${chalk.cyan(domain)}`);
        }
        this.log('');
        this.log(chalk.gray(`Use 'ats domains' to see all registered domains.`));
      }
    });
  }
}
