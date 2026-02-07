import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DependencyWithMetadata, IndexDatabase } from '../../db/database.js';

interface DepsOutput {
  symbol: {
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
  };
  dependencies: DependencyWithMetadata[];
  totalCount: number;
  unmetCount: number;
  aspect?: string;
}

export default class Deps extends Command {
  static override description = 'Show dependencies of a symbol with their metadata status';

  static override examples = [
    '<%= config.bin %> symbols deps extractDefinitions',
    '<%= config.bin %> symbols deps parseFile --aspect purpose',
    '<%= config.bin %> symbols deps --id 42 --aspect understood',
    '<%= config.bin %> symbols deps MyClass --file src/models/ --json',
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
      description: 'Highlight status of specific aspect',
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Deps);

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

      // Get dependencies with metadata
      const dependencies = db.getDependenciesWithMetadata(definition.id, flags.aspect);
      const defDetails = db.getDefinitionById(definition.id);

      if (!defDetails) {
        this.error(chalk.red(`Definition not found`));
      }

      const unmetCount = dependencies.filter(d => !d.hasAspect).length;

      const output: DepsOutput = {
        symbol: {
          id: defDetails.id,
          name: defDetails.name,
          kind: defDetails.kind,
          filePath: defDetails.filePath,
          line: defDetails.line,
        },
        dependencies,
        totalCount: dependencies.length,
        unmetCount,
        aspect: flags.aspect,
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

  private outputPlainText(output: DepsOutput): void {
    if (output.dependencies.length === 0) {
      this.log(`${chalk.yellow(output.symbol.name)} has no dependencies.`);
      return;
    }

    // Print header
    const aspectInfo = output.aspect
      ? `, ${chalk.yellow(output.unmetCount)} unmet for '${chalk.cyan(output.aspect)}'`
      : '';
    this.log(`Dependencies for ${chalk.yellow(output.symbol.name)} (${output.totalCount} total${aspectInfo}):`);
    this.log(chalk.gray('─'.repeat(70)));

    // Calculate column widths
    const nameWidth = Math.max(20, ...output.dependencies.map(d => d.name.length));
    const kindWidth = Math.max(10, ...output.dependencies.map(d => d.kind.length));

    // Header row
    if (output.aspect) {
      const header = `  ${'Name'.padEnd(nameWidth)}  ${'Kind'.padEnd(kindWidth)}  Status  ${output.aspect}`;
      this.log(chalk.gray(header));
    } else {
      const header = `  ${'Name'.padEnd(nameWidth)}  ${'Kind'.padEnd(kindWidth)}  Location`;
      this.log(chalk.gray(header));
    }

    // Print rows
    for (const dep of output.dependencies) {
      const name = dep.name.padEnd(nameWidth);
      const kind = dep.kind.padEnd(kindWidth);

      if (output.aspect) {
        const status = dep.hasAspect ? chalk.green('✓') : chalk.red('✗');
        const value = dep.aspectValue
          ? this.truncate(dep.aspectValue, 40)
          : chalk.gray('-');
        this.log(`  ${name}  ${chalk.gray(kind)}  ${status}       ${value}`);
      } else {
        const location = `${dep.filePath}:${dep.line}`;
        this.log(`  ${name}  ${chalk.gray(kind)}  ${chalk.gray(location)}`);
      }
    }

    this.log(chalk.gray('─'.repeat(70)));
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + '...';
  }
}
