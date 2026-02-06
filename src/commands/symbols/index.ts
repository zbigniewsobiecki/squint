import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Symbols extends Command {
  static override description = 'List all symbols in the index';

  static override examples = [
    '<%= config.bin %> symbols',
    '<%= config.bin %> symbols --kind function',
    '<%= config.bin %> symbols --kind class',
    '<%= config.bin %> symbols --file src/index.ts',
    '<%= config.bin %> symbols -d ./my-index.db',
  ];

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    kind: Flags.string({
      description: 'Filter by kind (function, class, variable, type, interface, enum)',
    }),
    file: Flags.string({
      description: 'Filter to symbols in a specific file',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Symbols);

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
      // Resolve file path if provided
      let fileId: number | null = null;
      if (flags.file) {
        const filePath = path.resolve(flags.file);
        fileId = db.getFileId(filePath);
        if (fileId === null) {
          this.error(chalk.red(`File "${filePath}" not found in the index.`));
        }
      }

      const symbols = db.getSymbols({
        kind: flags.kind,
        fileId: fileId ?? undefined,
      });

      if (symbols.length === 0) {
        this.log(chalk.gray('No symbols found.'));
      } else {
        for (const sym of symbols) {
          this.log(`${sym.name}\t${sym.kind}\t${sym.filePath}:${sym.line}`);
        }
        this.log('');
        this.log(chalk.gray(`Found ${symbols.length} symbol(s)`));
      }
    } finally {
      db.close();
    }
  }
}
