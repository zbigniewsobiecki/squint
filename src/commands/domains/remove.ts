import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Remove extends Command {
  static override description = 'Remove a domain from the registry';

  static override examples = [
    '<%= config.bin %> domains remove deprecated-domain',
    '<%= config.bin %> domains remove old-domain --force',
  ];

  static override args = {
    name: Args.string({ description: 'Domain name to remove', required: true }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Remove even if symbols still use this domain',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Remove);

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
      // Remove the domain
      const result = db.removeDomain(args.name, flags.force);

      if (!result.removed && result.symbolsUsingDomain > 0) {
        this.log(chalk.yellow(`Cannot remove domain "${args.name}" - ${result.symbolsUsingDomain} symbol(s) still use it.`));
        this.log(chalk.gray(`Use --force to remove anyway, or merge into another domain first.`));
        return;
      }

      if (!result.removed) {
        this.error(chalk.red(`Domain "${args.name}" not found in registry.`));
      }

      this.log(`Removed domain ${chalk.cyan(args.name)} from registry`);
      if (result.symbolsUsingDomain > 0) {
        this.log(chalk.yellow(`Warning: ${result.symbolsUsingDomain} symbol(s) still use this domain`));
      }
    } finally {
      db.close();
    }
  }
}
