import fs from 'node:fs/promises';
import path from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IndexDatabase } from '../../db/database.js';

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
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Merge);

    const dbPath = path.resolve(flags.database);

    // Check if database exists
    try {
      await fs.access(dbPath);
    } catch {
      this.error(
        chalk.red(`Database file "${dbPath}" does not exist.\nRun 'squint parse <directory>' first to create an index.`)
      );
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
      // Count symbols before merge
      const symbolsWithFrom = db.getSymbolsByDomain(args.fromName).length;

      if (symbolsWithFrom === 0) {
        const domain = db.getDomain(args.fromName);
        if (!domain) {
          this.error(chalk.red(`Domain "${args.fromName}" not found (neither in registry nor in use).`));
        }
      }

      // Merge the domains
      const result = db.mergeDomains(args.fromName, args.intoName);

      this.log(`Merged domain ${chalk.yellow(args.fromName)} -> ${chalk.cyan(args.intoName)}`);
      if (result.symbolsUpdated > 0) {
        this.log(`Updated ${chalk.green(result.symbolsUpdated)} symbol${result.symbolsUpdated !== 1 ? 's' : ''}`);
      }
      if (result.registryRemoved) {
        this.log(chalk.gray(`Removed "${args.fromName}" from registry`));
      }
    } finally {
      db.close();
    }
  }
}
