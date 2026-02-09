import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

interface CoverageResult {
  aspect: string;
  covered: number;
  total: number;
  percentage: number;
}

interface UnderstoodOutput {
  coverage: CoverageResult[];
  totalSymbols: number;
  aspectsInUse: number;
  filters: {
    kind?: string;
    file?: string;
    aspect?: string;
  };
}

export default class Understood extends Command {
  static override description = 'Show understanding coverage per aspect';

  static override examples = [
    '<%= config.bin %> symbols understood',
    '<%= config.bin %> symbols understood --kind function',
    '<%= config.bin %> symbols understood --file src/parser/',
    '<%= config.bin %> symbols understood --aspect purpose',
    '<%= config.bin %> symbols understood --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    kind: Flags.string({
      char: 'k',
      description: 'Filter to specific symbol kind',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Filter to symbols in path',
    }),
    aspect: SharedFlags.aspect,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Understood);

    await withDatabase(flags.database, this, async (db) => {
      // Get coverage data
      const coverage = db.getAspectCoverage({
        kind: flags.kind,
        filePattern: flags.file,
      });

      // Get total symbol count (needed even when no aspects are defined)
      const totalSymbols = db.getFilteredDefinitionCount({
        kind: flags.kind,
        filePattern: flags.file,
      });

      // Filter to specific aspect if requested
      let filteredCoverage = coverage;
      if (flags.aspect) {
        filteredCoverage = coverage.filter((c) => c.aspect === flags.aspect);
        if (filteredCoverage.length === 0) {
          // Check if the aspect exists at all
          const allKeys = db.getMetadataKeys();
          if (!allKeys.includes(flags.aspect)) {
            this.error(
              chalk.red(`Aspect "${flags.aspect}" not found. Available aspects: ${allKeys.join(', ') || '(none)'}`)
            );
          }
        }
      }

      // Calculate totals
      const aspectsInUse = coverage.length;

      const output: UnderstoodOutput = {
        coverage: filteredCoverage,
        totalSymbols,
        aspectsInUse,
        filters: {
          kind: flags.kind,
          file: flags.file,
          aspect: flags.aspect,
        },
      };

      if (flags.json) {
        this.log(JSON.stringify(output, null, 2));
      } else {
        this.outputPlainText(output);
      }
    });
  }

  private outputPlainText(output: UnderstoodOutput): void {
    if (output.coverage.length === 0) {
      if (output.totalSymbols === 0) {
        this.log(chalk.yellow('No symbols found matching filters.'));
      } else {
        this.log(chalk.yellow('No aspects defined yet.'));
        this.log(chalk.gray(`Use 'squint symbols set <key> <value> --name <symbol>' to add metadata.`));
      }
      return;
    }

    // Print header
    const aspectWidth = Math.max(12, ...output.coverage.map((c) => c.aspect.length));
    const header = `${'Aspect'.padEnd(aspectWidth)}  ${'Covered'.padStart(8)}  ${'Total'.padStart(6)}  ${'Coverage'.padStart(10)}`;
    const separator = '─'.repeat(header.length);

    this.log(separator);
    this.log(header);
    this.log(separator);

    // Print rows
    for (const row of output.coverage) {
      const percentage = `${row.percentage.toFixed(1)}%`;
      const percentageColor = row.percentage >= 80 ? chalk.green : row.percentage >= 50 ? chalk.yellow : chalk.red;

      this.log(
        `${row.aspect.padEnd(aspectWidth)}  ${String(row.covered).padStart(8)}  ${String(row.total).padStart(6)}  ${percentageColor(percentage.padStart(10))}`
      );
    }

    this.log(separator);

    // Print summary
    this.log(`Total symbols: ${output.totalSymbols}`);
    this.log(`Aspects in use: ${output.aspectsInUse}`);
  }
}
