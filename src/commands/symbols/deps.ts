import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { DependencyWithMetadata } from '../../db/database.js';
import { SharedFlags, SymbolResolver, truncate, withDatabase } from '../_shared/index.js';

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
    database: SharedFlags.database,
    id: Flags.integer({
      description: 'Symbol ID (alternative to name)',
    }),
    file: SharedFlags.symbolFile,
    aspect: SharedFlags.aspect,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Deps);

    // Validate arguments
    if (!args.name && flags.id === undefined) {
      this.error('Either provide a symbol name or --id to identify the symbol');
    }

    await withDatabase(flags.database, this, async (db) => {
      const resolver = new SymbolResolver(db, this);
      const definition = resolver.resolve(args.name, flags.id, flags.file);
      if (!definition) {
        return; // Disambiguation message already shown
      }

      // Get dependencies with metadata
      const dependencies = db.getDependenciesWithMetadata(definition.id, flags.aspect);
      const defDetails = db.getDefinitionById(definition.id);

      if (!defDetails) {
        this.error(chalk.red('Definition not found'));
      }

      const unmetCount = dependencies.filter((d) => !d.hasAspect).length;

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
    });
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
    const nameWidth = Math.max(20, ...output.dependencies.map((d) => d.name.length));
    const kindWidth = Math.max(10, ...output.dependencies.map((d) => d.kind.length));

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
        const value = dep.aspectValue ? truncate(dep.aspectValue, 40) : chalk.gray('-');
        this.log(`  ${name}  ${chalk.gray(kind)}  ${status}       ${value}`);
      } else {
        const location = `${dep.filePath}:${dep.line}`;
        this.log(`  ${name}  ${chalk.gray(kind)}  ${chalk.gray(location)}`);
      }
    }

    this.log(chalk.gray('─'.repeat(70)));
  }
}
