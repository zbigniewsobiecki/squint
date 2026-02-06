import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Orphans extends Command {
  static override description = 'Find files with no incoming imports (orphan files)';

  static override examples = [
    '<%= config.bin %> files orphans',
    '<%= config.bin %> files orphans -d ./my-index.db',
    '<%= config.bin %> files orphans --include-index',
    '<%= config.bin %> files orphans --include-tests',
  ];

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    'include-index': Flags.boolean({
      description: 'Include index.ts/index.js files (excluded by default)',
      default: false,
    }),
    'include-tests': Flags.boolean({
      description: 'Include test files (excluded by default)',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Orphans);

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
      const orphans = db.getOrphanFiles({
        includeIndex: flags['include-index'],
        includeTests: flags['include-tests'],
      });

      if (orphans.length === 0) {
        this.log(chalk.green('No orphan files found.'));
      } else {
        for (const file of orphans) {
          this.log(file.path);
        }
        this.log('');
        this.log(chalk.gray(`Found ${orphans.length} orphan file(s)`));
      }
    } finally {
      db.close();
    }
  }
}
