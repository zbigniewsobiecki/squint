import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolveFileId } from '../_shared/file-resolver.js';
import { SharedFlags, SymbolResolver, outputJsonOrPlain, withDatabase } from '../_shared/index.js';
import { SymbolShowDataGatherer } from './_show-data.js';
import { SymbolShowRenderer } from './_show-renderer.js';

export default class Show extends Command {
  static override description = 'Show detailed information about a symbol or file';

  static override examples = [
    '<%= config.bin %> symbols show parseFile',
    '<%= config.bin %> symbols show --id 42',
    '<%= config.bin %> symbols show MyClass --file src/models/user.ts',
    '<%= config.bin %> symbols show parseFile --json',
    '<%= config.bin %> symbols show foo -c 5',
    '<%= config.bin %> symbols show --file src/auth/service.ts',
  ];

  static override args = {
    name: Args.string({ description: 'Symbol name to look up', required: false }),
  };

  static override flags = {
    database: SharedFlags.database,
    file: Flags.string({
      char: 'f',
      description: 'Filter to specific file (for disambiguation or file-level aggregation)',
    }),
    id: Flags.integer({
      description: 'Look up by definition ID directly',
    }),
    json: SharedFlags.json,
    'context-lines': Flags.integer({
      char: 'c',
      description: 'Number of context lines around call sites',
      default: 3,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Show);

    // File aggregation mode: --file without name or --id
    if (flags.file && !args.name && flags.id === undefined) {
      await withDatabase(flags.database, this, async (db) => {
        const gatherer = new SymbolShowDataGatherer();
        const renderer = new SymbolShowRenderer(this);

        const fileData = await gatherer.gatherFileData(db, flags.file!);
        if (!fileData) {
          this.error(chalk.red(`File not found in index or has no symbols: "${flags.file}"`));
        }

        outputJsonOrPlain(this, flags.json ?? false, fileData, () => {
          renderer.renderFile(fileData);
        });
      });
      return;
    }

    // Validate arguments for single-symbol mode
    if (!args.name && flags.id === undefined) {
      this.error('Either provide a symbol name, use --id, or use --file for file-level aggregation');
    }

    await withDatabase(flags.database, this, async (db) => {
      const resolver = new SymbolResolver(db, this);
      const definition = resolver.resolve(args.name, flags.id, flags.file);

      if (!definition) {
        return; // Disambiguation message already shown
      }

      const gatherer = new SymbolShowDataGatherer();
      const renderer = new SymbolShowRenderer(this);

      let data: Awaited<ReturnType<SymbolShowDataGatherer['gatherSymbolData']>>;
      try {
        data = await gatherer.gatherSymbolData(db, definition.id, flags['context-lines']);
      } catch (err) {
        this.error(chalk.red((err as Error).message));
      }

      outputJsonOrPlain(this, flags.json, data, () => {
        renderer.renderSymbol(data);
      });
    });
  }
}

// Re-export for convenience (used by consumers that previously imported from show.ts)
export { resolveFileId };
