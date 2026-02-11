import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class Merge extends Command {
  static override description = 'Merge one domain into another (replaces source domain with target in all symbols)';

  static override examples = [
    '<%= config.bin %> domains merge user-mgmt customer',
    '<%= config.bin %> domains merge legacy-auth auth',
  ];

  static override args = {
    fromName: Args.string({ description: 'Source domain to merge from (will be removed)', required: true }),
    intoName: Args.string({ description: 'Target domain to merge into', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Merge);

    await withDatabase(flags.database, this, async (db) => {
      // Count symbols before merge
      const symbolsWithFrom = db.domains.getSymbolsByDomain(args.fromName).length;

      if (symbolsWithFrom === 0) {
        const domain = db.domains.get(args.fromName);
        if (!domain) {
          this.error(chalk.red(`Domain "${args.fromName}" not found (neither in registry nor in use).`));
        }
      }

      // Merge the domains
      const result = db.domains.merge(args.fromName, args.intoName);

      this.log(`Merged domain ${chalk.yellow(args.fromName)} -> ${chalk.cyan(args.intoName)}`);
      if (result.symbolsUpdated > 0) {
        this.log(`Updated ${chalk.green(result.symbolsUpdated)} symbol${result.symbolsUpdated !== 1 ? 's' : ''}`);
      }
      if (result.registryRemoved) {
        this.log(chalk.gray(`Removed "${args.fromName}" from registry`));
      }
    });
  }
}
