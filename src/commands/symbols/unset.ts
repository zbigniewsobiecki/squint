import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, SymbolResolver, withDatabase } from '../_shared/index.js';

export default class Unset extends Command {
  static override description = 'Remove metadata from a symbol';

  static override examples = [
    '<%= config.bin %> symbols unset purpose --name parseFile',
    '<%= config.bin %> symbols unset status --id 42',
    '<%= config.bin %> symbols unset owner --name MyClass --file src/models/user.ts',
  ];

  static override args = {
    key: Args.string({ description: 'Metadata key to remove', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    name: SharedFlags.symbolName,
    file: SharedFlags.symbolFile,
    id: Flags.integer({
      description: 'Target by definition ID directly',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Unset);

    // Validate arguments
    if (!flags.name && flags.id === undefined) {
      this.error('Either provide --name or --id to identify the symbol');
    }

    await withDatabase(flags.database, this, async (db) => {
      const resolver = new SymbolResolver(db, this);
      const definition = resolver.resolve(flags.name, flags.id, flags.file);

      if (!definition) {
        return; // Disambiguation message already shown
      }

      // Remove the metadata
      const removed = db.metadata.remove(definition.id, args.key);

      // Get the definition name for output
      const defDetails = db.definitions.getById(definition.id);
      const displayName = defDetails?.name ?? `ID ${definition.id}`;

      if (removed) {
        this.log(`Removed ${chalk.cyan(args.key)} from ${chalk.yellow(displayName)}`);
      } else {
        this.log(chalk.gray(`No metadata key "${args.key}" found on ${displayName}`));
      }
    });
  }
}
