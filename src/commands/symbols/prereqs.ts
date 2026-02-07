import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DependencyInfo, IndexDatabase } from '../../db/database.js';

interface PrereqInfo extends DependencyInfo {
  unmetDepCount: number;
}

interface PrereqsOutput {
  symbol: {
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
  };
  aspect: string;
  prerequisites: PrereqInfo[];
  readyCount: number;
  totalCount: number;
}

export default class Prereqs extends Command {
  static override description = 'Show unmet dependencies in topological order (what to understand first)';

  static override examples = [
    '<%= config.bin %> symbols prereqs extractDefinitions --aspect purpose',
    '<%= config.bin %> symbols prereqs --id 42 --aspect understood',
    '<%= config.bin %> symbols prereqs IndexDatabase --aspect purpose --json',
  ];

  static override args = {
    name: Args.string({ description: 'Symbol name to inspect' }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    id: Flags.integer({
      description: 'Symbol ID (alternative to name)',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Disambiguate by file path',
    }),
    aspect: Flags.string({
      char: 'a',
      description: 'The aspect to check',
      required: true,
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Prereqs);

    // Validate arguments
    if (!args.name && flags.id === undefined) {
      this.error('Either provide a symbol name or --id to identify the symbol');
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
      const definition = this.resolveDefinition(db, args.name, flags.id, flags.file);
      if (!definition) {
        return; // Error already shown
      }

      // Get prerequisite chain
      const prerequisites = db.getPrerequisiteChain(definition.id, flags.aspect);
      const defDetails = db.getDefinitionById(definition.id);

      if (!defDetails) {
        this.error(chalk.red(`Definition not found`));
      }

      const readyCount = prerequisites.filter(p => p.unmetDepCount === 0).length;

      const output: PrereqsOutput = {
        symbol: {
          id: defDetails.id,
          name: defDetails.name,
          kind: defDetails.kind,
          filePath: defDetails.filePath,
          line: defDetails.line,
        },
        aspect: flags.aspect,
        prerequisites,
        readyCount,
        totalCount: prerequisites.length,
      };

      if (flags.json) {
        this.log(JSON.stringify(output, null, 2));
      } else {
        this.outputPlainText(output);
      }
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

  private outputPlainText(output: PrereqsOutput): void {
    if (output.prerequisites.length === 0) {
      this.log(chalk.green(`No prerequisites needed for ${chalk.yellow(output.symbol.name)} for aspect '${output.aspect}'.`));
      this.log(chalk.gray('The symbol is ready to understand!'));
      return;
    }

    // Print header
    this.log(`Prerequisites to understand ${chalk.yellow(output.symbol.name)} for aspect '${chalk.cyan(output.aspect)}':`);
    this.log(chalk.gray('─'.repeat(70)));

    // Calculate column widths
    const nameWidth = Math.max(20, ...output.prerequisites.map(p => p.name.length));
    const kindWidth = Math.max(10, ...output.prerequisites.map(p => p.kind.length));

    // Header row
    const header = `${'#'.padStart(3)}  ${'Name'.padEnd(nameWidth)}  ${'Kind'.padEnd(kindWidth)}  ${'Deps'.padStart(4)}  Location`;
    this.log(chalk.gray(header));

    // Print rows
    let order = 1;
    for (const prereq of output.prerequisites) {
      const orderStr = String(order).padStart(3);
      const name = prereq.name.padEnd(nameWidth);
      const kind = prereq.kind.padEnd(kindWidth);
      const deps = String(prereq.unmetDepCount).padStart(4);
      const location = `${prereq.filePath}:${prereq.line}`;

      const depsColor = prereq.unmetDepCount === 0 ? chalk.green : chalk.yellow;
      const orderColor = prereq.unmetDepCount === 0 ? chalk.green : chalk.white;

      this.log(`${orderColor(orderStr)}  ${name}  ${chalk.gray(kind)}  ${depsColor(deps)}  ${chalk.gray(location)}`);
      order++;
    }

    this.log(chalk.gray('─'.repeat(70)));

    // Print summary
    this.log(`${chalk.yellow(output.totalCount)} prerequisites remaining.`);
    if (output.readyCount > 0) {
      this.log(chalk.green(`${output.readyCount} are ready to understand now (0 deps).`));
    } else {
      this.log(chalk.yellow('None are immediately ready - there may be circular dependencies.'));
      this.log(chalk.gray('Try manually marking one of the symbols to break the cycle.'));
    }
  }
}
