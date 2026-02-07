import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Domains extends Command {
  static override description = 'List all registered domains with symbol counts';

  static override examples = [
    '<%= config.bin %> domains',
    '<%= config.bin %> domains --json',
    '<%= config.bin %> domains --unregistered',
  ];

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
    unregistered: Flags.boolean({
      description: 'Show domains in use but not registered',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Domains);

    const dbPath = path.resolve(flags.database);

    // Check if database exists
    try {
      await fs.access(dbPath);
    } catch {
      this.error(chalk.red(`Database file "${dbPath}" does not exist.\nRun 'ats parse <directory>' first to create an index.`));
    }

    // Open database
    let db: IndexDatabase;
    try {
      db = new IndexDatabase(dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(chalk.red(`Failed to open database: ${message}`));
    }

    try {
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
    } finally {
      db.close();
    }
  }
}
