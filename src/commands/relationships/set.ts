import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class Set extends Command {
  static override description = 'Set a semantic annotation on a relationship between two symbols';

  static override examples = [
    '<%= config.bin %> relationships set "delegates credential validation" --from loginController --to authService',
    '<%= config.bin %> relationships set "persists customer data to PostgreSQL" --from-id 42 --to-id 15',
  ];

  static override args = {
    semantic: Args.string({
      description: 'Semantic description of why this relationship exists',
      required: true,
    }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    from: Flags.string({
      description: 'Source symbol name',
    }),
    to: Flags.string({
      description: 'Target symbol name',
    }),
    'from-id': Flags.integer({
      description: 'Source definition ID',
    }),
    'to-id': Flags.integer({
      description: 'Target definition ID',
    }),
    'from-file': Flags.string({
      description: 'Disambiguate source symbol by file path',
    }),
    'to-file': Flags.string({
      description: 'Disambiguate target symbol by file path',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Set);

    // Validate that we have both from and to
    const hasFrom = flags.from !== undefined || flags['from-id'] !== undefined;
    const hasTo = flags.to !== undefined || flags['to-id'] !== undefined;

    if (!hasFrom || !hasTo) {
      this.error(chalk.red('Both --from/--from-id and --to/--to-id are required'));
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
      // Resolve the from definition
      const fromDef = this.resolveDefinition(db, flags.from, flags['from-id'], flags['from-file'], 'from');
      if (!fromDef) return;

      // Resolve the to definition
      const toDef = this.resolveDefinition(db, flags.to, flags['to-id'], flags['to-file'], 'to');
      if (!toDef) return;

      // Set the relationship annotation
      db.setRelationshipAnnotation(fromDef.id, toDef.id, args.semantic);

      const fromDetails = db.getDefinitionById(fromDef.id);
      const toDetails = db.getDefinitionById(toDef.id);

      this.log(`Set relationship: ${chalk.yellow(fromDetails?.name ?? String(fromDef.id))} ${chalk.gray('->')} ${chalk.cyan(toDetails?.name ?? String(toDef.id))}`);
      this.log(`  ${args.semantic}`);
    } finally {
      db.close();
    }
  }

  private resolveDefinition(
    db: IndexDatabase,
    name: string | undefined,
    id: number | undefined,
    filePath: string | undefined,
    prefix: string
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
      this.error(chalk.red(`--${prefix} or --${prefix}-id is required`));
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
        this.log(`  ${chalk.cyan(`--${prefix}-id`)} ${match.id}\t${match.kind}\t${match.filePath}:${match.line}`);
      }
      this.log('');
      this.log(chalk.gray(`Use --${prefix}-id or --${prefix}-file to disambiguate`));
      return null;
    }

    return { id: matches[0].id };
  }
}
