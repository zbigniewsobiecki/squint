import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class ImportedBy extends Command {
  static override description = 'List files that import a specific file';

  static override examples = [
    '<%= config.bin %> files imported-by src/db/database.ts',
    '<%= config.bin %> files imported-by ./src/utils.ts -d ./my-index.db',
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
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ImportedBy);

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

      const importers = db.getFilesImportedBy(fileId);

      if (importers.length === 0) {
        this.log(chalk.gray('No files import this file.'));
      } else {
        for (const importer of importers) {
          this.log(importer.path);
        }
      }
    } finally {
      db.close();
    }
  }
}
