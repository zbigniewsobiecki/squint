import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class DomainsDelete extends Command {
  static override description = 'Remove a domain from the registry';

  static override examples = [
    '<%= config.bin %> domains delete deprecated-domain',
    '<%= config.bin %> domains delete old-domain --force',
  ];

  static override args = {
    name: Args.string({ description: 'Domain name to remove', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    force: Flags.boolean({
      char: 'f',
      description: 'Remove even if symbols still use this domain',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DomainsDelete);

    await withDatabase(flags.database, this, async (db) => {
      // Remove the domain
      const result = db.domains.remove(args.name, flags.force);

      if (!result.removed && result.symbolsUsingDomain > 0) {
        this.log(
          chalk.yellow(`Cannot remove domain "${args.name}" - ${result.symbolsUsingDomain} symbol(s) still use it.`)
        );
        this.log(chalk.gray('Use --force to remove anyway, or merge into another domain first.'));
        return;
      }

      if (!result.removed) {
        this.error(chalk.red(`Domain "${args.name}" not found in registry.`));
      }

      this.log(`Removed domain ${chalk.cyan(args.name)} from registry`);
      if (result.symbolsUsingDomain > 0) {
        this.log(chalk.yellow(`Warning: ${result.symbolsUsingDomain} symbol(s) still use this domain`));
      }
    });
  }
}
