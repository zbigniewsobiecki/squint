import { Command, Flags } from '@oclif/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Files extends Command {
  static override description = 'List all indexed files';

  static override examples = [
    '<%= config.bin %> files',
    '<%= config.bin %> files --stats',
    '<%= config.bin %> files -d ./my-index.db',
  ];

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    stats: Flags.boolean({
      description: 'Include import statistics (imported-by count, imports count)',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Files);

    const dbPath = path.resolve(flags.database);

    // Check if database exists
    try {
      await fs.access(dbPath);
    } catch {
      this.error(`Database file "${dbPath}" does not exist.\nRun 'ats parse <directory>' first to create an index.`);
    }

    // Open database
    let db: IndexDatabase;
    try {
      db = new IndexDatabase(dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(`Failed to open database: ${message}`);
    }

    try {
      if (flags.stats) {
        const files = db.getAllFilesWithStats();
        for (const file of files) {
          this.log(`${file.path}\t${file.importedByCount}\t${file.importsCount}`);
        }
      } else {
        const files = db.getAllFiles();
        for (const file of files) {
          this.log(file.path);
        }
      }
    } finally {
      db.close();
    }
  }
}
