import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Sync extends Command {
  static override description = 'Register all domains currently in use (bulk registration)';

  static override examples = [
    '<%= config.bin %> domains sync',
    '<%= config.bin %> domains sync --json',
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
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Sync);

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
    } finally {
      db.close();
    }
  }
}
