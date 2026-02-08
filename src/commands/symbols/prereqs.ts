import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { DependencyInfo } from '../../db/database.js';
import { SharedFlags, SymbolResolver, withDatabase } from '../_shared/index.js';

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
    database: SharedFlags.database,
    id: Flags.integer({
      description: 'Symbol ID (alternative to name)',
    }),
    file: SharedFlags.symbolFile,
    aspect: Flags.string({
      char: 'a',
      description: 'The aspect to check',
      required: true,
    }),
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Prereqs);

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

      // Get prerequisite chain
      const prerequisites = db.getPrerequisiteChain(definition.id, flags.aspect);
      const defDetails = db.getDefinitionById(definition.id);

      if (!defDetails) {
        this.error(chalk.red('Definition not found'));
      }

      const readyCount = prerequisites.filter((p) => p.unmetDepCount === 0).length;

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
    });
  }

  private outputPlainText(output: PrereqsOutput): void {
    if (output.prerequisites.length === 0) {
      this.log(
        chalk.green(`No prerequisites needed for ${chalk.yellow(output.symbol.name)} for aspect '${output.aspect}'.`)
      );
      this.log(chalk.gray('The symbol is ready to understand!'));
      return;
    }

    // Print header
    this.log(
      `Prerequisites to understand ${chalk.yellow(output.symbol.name)} for aspect '${chalk.cyan(output.aspect)}':`
    );
    this.log(chalk.gray('─'.repeat(70)));

    // Calculate column widths
    const nameWidth = Math.max(20, ...output.prerequisites.map((p) => p.name.length));
    const kindWidth = Math.max(10, ...output.prerequisites.map((p) => p.kind.length));

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
