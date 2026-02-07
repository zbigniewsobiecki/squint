import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withDatabase, SharedFlags } from '../_shared/index.js';

export default class Domains extends Command {
  static override description = 'List all registered domains with symbol counts';

  static override examples = [
    '<%= config.bin %> domains',
    '<%= config.bin %> domains --json',
    '<%= config.bin %> domains --unregistered',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    unregistered: Flags.boolean({
      description: 'Show domains in use but not registered',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Domains);

    await withDatabase(flags.database, this, async (db) => {
      if (flags.unregistered) {
        // Show unregistered domains
        const unregistered = db.getUnregisteredDomains();

        if (flags.json) {
          this.log(JSON.stringify({ unregistered }, null, 2));
        } else if (unregistered.length === 0) {
          this.log(chalk.green('All domains in use are registered.'));
        } else {
          this.log(chalk.yellow('Unregistered domains in use:'));
          for (const domain of unregistered) {
            const count = db.getSymbolsByDomain(domain).length;
            this.log(`  ${chalk.cyan(domain)} (${count} symbol${count !== 1 ? 's' : ''})`);
          }
          this.log('');
          this.log(chalk.gray(`Run 'ats domains sync' to register all domains in use.`));
        }
        return;
      }

      // List registered domains with counts
      const domainsWithCounts = db.getDomainsWithCounts();

      if (flags.json) {
        this.log(JSON.stringify({ domains: domainsWithCounts }, null, 2));
      } else if (domainsWithCounts.length === 0) {
        this.log(chalk.gray('No domains registered.'));
        this.log(chalk.gray(`Use 'ats domains add <name> "<description>"' to register a domain.`));
        this.log(chalk.gray(`Or use 'ats domains sync' to register all domains currently in use.`));
      } else {
        // Calculate column widths
        const maxNameLen = Math.max(...domainsWithCounts.map(d => d.name.length), 10);
        const maxCountLen = Math.max(...domainsWithCounts.map(d => String(d.symbolCount).length + 8), 10);

        for (const domain of domainsWithCounts) {
          const countStr = `${domain.symbolCount} symbol${domain.symbolCount !== 1 ? 's' : ''}`;
          const desc = domain.description || chalk.gray('(no description)');
          this.log(
            `${chalk.cyan(domain.name.padEnd(maxNameLen))}  ${countStr.padEnd(maxCountLen)}  ${desc}`
          );
        }
        this.log('');
        this.log(chalk.gray(`${domainsWithCounts.length} domain(s) registered`));
      }
    });
  }
}
