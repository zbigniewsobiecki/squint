import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

export default class DomainsShow extends Command {
  static override description = 'Show domain details including symbols';

  static override examples = ['<%= config.bin %> domains show auth', '<%= config.bin %> domains show payment --json'];

  static override args = {
    name: Args.string({ description: 'Domain name', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DomainsShow);

    await withDatabase(flags.database, this, async (db) => {
      const domain = db.domains.get(args.name);
      if (!domain) {
        this.error(chalk.red(`Domain "${args.name}" not found.`));
      }

      const symbols = db.domains.getSymbolsByDomain(args.name);

      const jsonData = {
        domain,
        symbols,
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        this.log(chalk.bold(`Domain: ${chalk.cyan(domain.name)}`));
        if (domain.description) {
          this.log(`Description: ${domain.description}`);
        }
        this.log(`Created: ${domain.createdAt}`);

        this.log('');
        this.log(chalk.bold(`Symbols (${symbols.length})`));
        if (symbols.length === 0) {
          this.log(chalk.gray('  No symbols tagged with this domain.'));
        } else {
          for (const s of symbols) {
            const purpose = s.purpose ? chalk.gray(` - ${s.purpose}`) : '';
            this.log(
              `  ${chalk.cyan(s.name)} ${chalk.yellow(s.kind)} ${chalk.gray(`${s.filePath}:${s.line}`)}${purpose}`
            );
          }
        }
      });
    });
  }
}
