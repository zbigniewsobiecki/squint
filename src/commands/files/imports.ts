import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Imports extends Command {
  static override description = 'List files imported by a specific file';

  static override examples = [
    '<%= config.bin %> files imports src/index.ts',
    '<%= config.bin %> files imports ./src/db/database.ts -d ./my-index.db',
    '<%= config.bin %> files imports src/index.ts --exclude-external',
  ];

  static override args = {
    file: Args.string({
      description: 'Path to the file to analyze',
      required: true,
    }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    'exclude-external': Flags.boolean({
      description: 'Exclude external imports (node_modules, etc.)',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Imports);

    const dbPath = path.resolve(flags.database);
    const filePath = path.resolve(args.file);

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
      const fileId = db.getFileId(filePath);
      if (fileId === null) {
        this.error(chalk.red(`File "${filePath}" not found in the index.`));
      }

      const imports = db.getFileImports(fileId);
      const filteredImports = flags['exclude-external']
        ? imports.filter(imp => !imp.isExternal && imp.toFilePath)
        : imports;

      if (filteredImports.length === 0) {
        this.log(chalk.gray('No imports found.'));
      } else {
        for (const imp of filteredImports) {
          this.log(imp.toFilePath ?? imp.source);
        }
      }
    } finally {
      db.close();
    }
  }
}
