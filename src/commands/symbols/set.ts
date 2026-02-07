import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Set extends Command {
  static override description = 'Set metadata on a symbol';

  static override examples = [
    '<%= config.bin %> symbols set purpose "Parse TS files" --name parseFile',
    '<%= config.bin %> symbols set purpose "Main entry point" --id 42',
    '<%= config.bin %> symbols set status "deprecated" --name MyClass --file src/models/user.ts',
  ];

  static override args = {
    key: Args.string({ description: 'Metadata key', required: true }),
    value: Args.string({ description: 'Metadata value', required: true }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    name: Flags.string({
      char: 'n',
      description: 'Symbol name',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Disambiguate by file path',
    }),
    id: Flags.integer({
      description: 'Set by definition ID directly',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Set);

    // Validate arguments
    if (!flags.name && flags.id === undefined) {
      this.error('Either provide --name or --id to identify the symbol');
    }

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
      // Resolve the definition
      const definition = this.resolveDefinition(db, flags.name, flags.id, flags.file);

      if (!definition) {
        return; // Error already shown in resolveDefinition
      }

      // Set the metadata
      db.setDefinitionMetadata(definition.id, args.key, args.value);

      // Get the definition name for output
      const defDetails = db.getDefinitionById(definition.id);
      const displayName = defDetails?.name ?? `ID ${definition.id}`;

      this.log(`Set ${chalk.cyan(args.key)}="${args.value}" on ${chalk.yellow(displayName)}`);
    } finally {
      db.close();
    }
  }

  private resolveDefinition(
    db: IndexDatabase,
    name: string | undefined,
    id: number | undefined,
    filePath: string | undefined
  ): { id: number } | null {
    // Direct ID lookup
    if (id !== undefined) {
      const def = db.getDefinitionById(id);
      if (!def) {
        this.error(chalk.red(`No definition found with ID ${id}`));
      }
      return { id };
    }

    // Name lookup
    if (!name) {
      this.error(chalk.red('Symbol name is required'));
    }

    let matches = db.getDefinitionsByName(name);

    if (matches.length === 0) {
      this.error(chalk.red(`No symbol found with name "${name}"`));
    }

    // Filter by file if specified
    if (filePath) {
      const resolvedPath = path.resolve(filePath);
      matches = matches.filter(m => m.filePath === resolvedPath || m.filePath.endsWith(filePath));

      if (matches.length === 0) {
        this.error(chalk.red(`No symbol "${name}" found in file "${filePath}"`));
      }
    }

    // Disambiguation needed
    if (matches.length > 1) {
      this.log(chalk.yellow(`Multiple symbols found with name "${name}":`));
      this.log('');
      for (const match of matches) {
        this.log(`  ${chalk.cyan('--id')} ${match.id}\t${match.kind}\t${match.filePath}:${match.line}`);
      }
      this.log('');
      this.log(chalk.gray('Use --id or --file to disambiguate'));
      return null;
    }

    return { id: matches[0].id };
  }
}
