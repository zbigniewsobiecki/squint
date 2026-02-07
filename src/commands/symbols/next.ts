import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase, ReadySymbolInfo, DependencyWithMetadata } from '../../db/database.js';

interface UnannotatedRelationship {
  toDefinitionId: number;
  toName: string;
  toKind: string;
}

interface NextSymbolInfo extends ReadySymbolInfo {
  sourceCode: string;
  dependencies: DependencyWithMetadata[];
  unannotatedRelationships: UnannotatedRelationship[];
}

interface NextOutput {
  symbol: NextSymbolInfo;
  remaining: number;
  totalSymbols: number;
}

export default class Next extends Command {
  static override description = 'Show the next symbol ready to understand, with source code';

  static override examples = [
    '<%= config.bin %> symbols next -a purpose',
    '<%= config.bin %> symbols next -a purpose --count 3',
    '<%= config.bin %> symbols next -a understood --json',
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
    count: Flags.integer({
      char: 'c',
      description: 'Number of symbols to show',
      default: 1,
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
    'max-lines': Flags.integer({
      char: 'm',
      description: 'Maximum lines of source code to show (0 = unlimited)',
      default: 50,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Next);

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
        limit: flags.count,
      });

      if (result.symbols.length === 0) {
        if (result.totalReady === 0 && result.remaining === 0) {
          this.log(chalk.green(`All symbols have aspect '${flags.aspect}' set!`));
        } else if (result.totalReady === 0) {
          this.log(chalk.yellow(`No symbols ready yet for aspect '${flags.aspect}'.`));
          this.log(chalk.gray(`${result.remaining} symbols have unmet dependencies.`));
          this.log(chalk.gray(`This may indicate circular dependencies. Try marking a symbol manually.`));
        }
        return;
      }

      // Enhance each symbol with source code and dependencies
      const totalRemaining = result.remaining + result.totalReady;
      const symbols: NextSymbolInfo[] = [];

      for (const symbol of result.symbols) {
        const sourceCode = await this.readSourceCode(symbol.filePath, symbol.line, symbol.endLine);
        const dependencies = db.getDependenciesWithMetadata(symbol.id, flags.aspect);
        const unannotatedRels = db.getUnannotatedRelationships({ fromDefinitionId: symbol.id, limit: 10 });
        const unannotatedRelationships: UnannotatedRelationship[] = unannotatedRels.map(rel => ({
          toDefinitionId: rel.toDefinitionId,
          toName: rel.toName,
          toKind: rel.toKind,
        }));
        symbols.push({
          ...symbol,
          sourceCode,
          dependencies,
          unannotatedRelationships,
        });
      }

      if (flags.json) {
        if (flags.count === 1) {
          // Single symbol: output simpler structure
          const output: NextOutput = {
            symbol: symbols[0],
            remaining: totalRemaining,
            totalSymbols: db.getDefinitionCount(),
          };
          this.log(JSON.stringify(output, null, 2));
        } else {
          // Multiple symbols: output array
          const output = {
            symbols,
            remaining: totalRemaining,
            totalSymbols: db.getDefinitionCount(),
          };
          this.log(JSON.stringify(output, null, 2));
        }
      } else {
        for (let i = 0; i < symbols.length; i++) {
          if (i > 0) {
            this.log('');
          }
          this.outputSymbol(symbols[i], i + 1, symbols.length, totalRemaining, flags.aspect, flags['max-lines']);
        }
      }
    } finally {
      db.close();
    }
  }

  private async readSourceCode(filePath: string, startLine: number, endLine: number): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      // Convert to 0-based indexing for array access
      return lines.slice(startLine - 1, endLine).join('\n');
    } catch {
      return '<source code not available>';
    }
  }

  private outputSymbol(
    symbol: NextSymbolInfo,
    index: number,
    total: number,
    remaining: number,
    aspect: string,
    maxLines: number
  ): void {
    // Header
    const countInfo = total > 1 ? `${index} of ${total} shown, ` : '';
    this.log(`Next to understand for '${chalk.cyan(aspect)}' (${countInfo}${chalk.yellow(remaining)} remaining):`);
    this.log(chalk.gray('═'.repeat(68)));
    this.log('');

    // Symbol info
    const lineRange = symbol.line === symbol.endLine
      ? `${symbol.line}`
      : `${symbol.line}-${symbol.endLine}`;
    this.log(`${chalk.bold(symbol.name)} (${symbol.kind}) - ${symbol.filePath}:${lineRange}`);

    // Dependencies
    if (symbol.dependencies.length === 0) {
      this.log(`Dependencies: ${chalk.green('none')}`);
    } else {
      const depNames = symbol.dependencies.map(d => d.name).join(', ');
      this.log(`Dependencies: ${chalk.cyan(depNames)}`);
    }

    this.log('');

    // Source code
    this.log('Source:');
    this.log(chalk.gray('─'.repeat(68)));

    const sourceLines = symbol.sourceCode.split('\n');
    const totalLines = sourceLines.length;
    const linesToShow = maxLines > 0 && totalLines > maxLines ? maxLines : totalLines;
    const truncated = maxLines > 0 && totalLines > maxLines;

    for (let i = 0; i < linesToShow; i++) {
      const lineNum = symbol.line + i;
      const lineNumStr = String(lineNum).padStart(5, ' ');
      this.log(`${chalk.gray(lineNumStr)} | ${sourceLines[i]}`);
    }

    if (truncated) {
      this.log(chalk.gray(`  ... ${totalLines - maxLines} more lines (use -m 0 to show all)`));
    }

    this.log(chalk.gray('─'.repeat(68)));
    this.log('');

    // Hint - use --id for unambiguous reference
    this.log('To mark as understood:');
    this.log(chalk.gray(`  ats symbols set ${aspect} "<description>" --id ${symbol.id}`));

    // Show unannotated relationships if any
    if (symbol.unannotatedRelationships.length > 0) {
      this.log('');
      this.log(`Relationships needing annotation (${chalk.yellow(symbol.unannotatedRelationships.length)}):`);
      for (const rel of symbol.unannotatedRelationships) {
        this.log(`  ${chalk.gray('->')} ${chalk.cyan(rel.toName)} (${rel.toKind})`);
      }
      this.log('');
      this.log(chalk.gray('After understanding this symbol, consider annotating relationships:'));
      this.log(chalk.gray(`  ats relationships next --from-id ${symbol.id}`));
    }
  }
}
