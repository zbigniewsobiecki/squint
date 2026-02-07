import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Rename extends Command {
  static override description = 'Rename a domain (updates registry and all symbol metadata)';

  static override examples = [
    '<%= config.bin %> domains rename auth authentication',
  ];

  static override args = {
    oldName: Args.string({ description: 'Current domain name', required: true }),
    newName: Args.string({ description: 'New domain name', required: true }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Rename);

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
      // Check if new name already exists
      if (db.getDomain(args.newName)) {
        this.error(chalk.red(`Domain "${args.newName}" already exists.`));
      }

      // Rename the domain
      const result = db.renameDomain(args.oldName, args.newName);

      if (!result.updated && result.symbolsUpdated === 0) {
        this.error(chalk.red(`Domain "${args.oldName}" not found.`));
      }

      this.log(`Renamed domain ${chalk.yellow(args.oldName)} -> ${chalk.cyan(args.newName)}`);
      if (result.symbolsUpdated > 0) {
        this.log(`Updated ${chalk.green(result.symbolsUpdated)} symbol${result.symbolsUpdated !== 1 ? 's' : ''}`);
      }
    } finally {
      db.close();
    }
  }
}
