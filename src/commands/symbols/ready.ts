import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase, ReadySymbolInfo, DependencyWithMetadata } from '../../db/database.js';

interface ReadySymbolWithDeps extends ReadySymbolInfo {
  dependencies?: DependencyWithMetadata[];
}

interface ReadyOutput {
  symbols: ReadySymbolWithDeps[];
  totalReady: number;
  remaining: number;
  aspect: string;
  verbose: boolean;
  filters: {
    kind?: string;
    file?: string;
    limit: number;
  };
}

export default class Ready extends Command {
  static override description = 'Find symbols ready to understand for an aspect';

  static override examples = [
    '<%= config.bin %> symbols ready --aspect understood',
    '<%= config.bin %> symbols ready -a purpose --kind function',
    '<%= config.bin %> symbols ready -a understood --file src/parser/ --limit 10',
    '<%= config.bin %> symbols ready -a understood --json',
    '<%= config.bin %> symbols ready -a purpose --verbose',
  ];

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    aspect: Flags.string({
      char: 'a',
      description: 'The metadata key (aspect) to check',
      required: true,
    }),
    limit: Flags.integer({
      char: 'l',
      description: 'Maximum number of results',
      default: 20,
    }),
    kind: Flags.string({
      char: 'k',
      description: 'Filter to specific symbol kind',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Filter to symbols in path',
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show dependency metadata inline',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Ready);

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
      const result = db.getReadyToUnderstandSymbols(flags.aspect, {
        limit: flags.limit,
        kind: flags.kind,
        filePattern: flags.file,
      });

      // Enhance symbols with dependency info when verbose
      const symbols: ReadySymbolWithDeps[] = result.symbols.map(symbol => {
        if (flags.verbose) {
          const dependencies = db.getDependenciesWithMetadata(symbol.id, flags.aspect);
          return { ...symbol, dependencies };
        }
        return symbol;
      });

      const output: ReadyOutput = {
        symbols,
        totalReady: result.totalReady,
        remaining: result.remaining,
        aspect: flags.aspect,
        verbose: flags.verbose,
        filters: {
          kind: flags.kind,
          file: flags.file,
          limit: flags.limit,
        },
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

  private outputPlainText(output: ReadyOutput): void {
    if (output.symbols.length === 0) {
      if (output.totalReady === 0 && output.remaining === 0) {
        this.log(chalk.green(`All symbols have aspect '${output.aspect}' set!`));
      } else if (output.totalReady === 0) {
        this.log(chalk.yellow(`No symbols ready yet for aspect '${output.aspect}'.`));
        this.log(chalk.gray(`${output.remaining} symbols have unmet dependencies.`));
        this.log(chalk.gray(`This may indicate circular dependencies. Try marking a symbol manually.`));
      } else {
        this.log(chalk.yellow('No symbols found matching filters.'));
      }
      return;
    }

    // Print header
    this.log(`Ready to understand for aspect '${chalk.cyan(output.aspect)}':`);
    this.log(chalk.gray('─'.repeat(50)));

    // Calculate column widths
    const nameWidth = Math.max(20, ...output.symbols.map(s => s.name.length));
    const kindWidth = Math.max(8, ...output.symbols.map(s => s.kind.length));

    const header = `  ${'Name'.padEnd(nameWidth)}  ${'Kind'.padEnd(kindWidth)}  ${'Deps'.padStart(4)}  Location`;
    this.log(chalk.gray(header));

    // Print rows
    for (const symbol of output.symbols) {
      const lineCount = symbol.endLine - symbol.line + 1;
      const location = `${symbol.filePath}:${symbol.line}:${lineCount}`;
      const depsStr = String(symbol.dependencyCount).padStart(4);
      const depsColor = symbol.dependencyCount === 0 ? chalk.green : chalk.white;

      this.log(
        `  ${symbol.name.padEnd(nameWidth)}  ${chalk.gray(symbol.kind.padEnd(kindWidth))}  ${depsColor(depsStr)}  ${chalk.gray(location)}`
      );

      // Show dependencies in verbose mode
      if (output.verbose && symbol.dependencies && symbol.dependencies.length > 0) {
        for (const dep of symbol.dependencies) {
          const status = dep.hasAspect ? chalk.green('✓') : chalk.gray('○');
          const value = dep.aspectValue
            ? chalk.gray(this.truncate(dep.aspectValue, 50))
            : '';
          this.log(`      ${status} ${chalk.cyan(dep.name)}: ${value}`);
        }
      }
    }

    this.log(chalk.gray('─'.repeat(50)));

    // Print summary
    const showingCount = output.symbols.length;
    const totalMsg = output.totalReady > showingCount
      ? `Found ${chalk.green(output.totalReady)} symbols ready (showing ${showingCount})`
      : `Found ${chalk.green(output.totalReady)} symbols ready`;
    this.log(`${totalMsg}, ${chalk.yellow(output.remaining)} remaining`);

    // Print hint
    this.log(chalk.gray(`Hint: Use 'ats symbols set ${output.aspect} <value> --name <symbol>' to mark`));
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + '...';
  }
}
