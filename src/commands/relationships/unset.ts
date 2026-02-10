import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, SymbolResolver, withDatabase } from '../_shared/index.js';

export default class Unset extends Command {
  static override description = 'Remove a relationship annotation between two symbols';

  static override examples = [
    '<%= config.bin %> relationships unset --from loginController --to authService',
    '<%= config.bin %> relationships unset --from-id 42 --to-id 15',
  ];

  static override flags = {
    database: SharedFlags.database,
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
    const { flags } = await this.parse(Unset);

    // Validate that we have both from and to
    const hasFrom = flags.from !== undefined || flags['from-id'] !== undefined;
    const hasTo = flags.to !== undefined || flags['to-id'] !== undefined;

    if (!hasFrom || !hasTo) {
      this.error(chalk.red('Both --from/--from-id and --to/--to-id are required'));
    }

    await withDatabase(flags.database, this, async (db) => {
      const resolver = new SymbolResolver(db, this);

      // Resolve the from definition
      const fromDef = resolver.resolve(flags.from, flags['from-id'], flags['from-file'], 'from');
      if (!fromDef) return;

      // Resolve the to definition
      const toDef = resolver.resolve(flags.to, flags['to-id'], flags['to-file'], 'to');
      if (!toDef) return;

      const fromDetails = db.definitions.getById(fromDef.id);
      const toDetails = db.definitions.getById(toDef.id);

      // Remove the relationship annotation
      const removed = db.relationships.remove(fromDef.id, toDef.id);

      if (removed) {
        this.log(
          `Removed relationship: ${chalk.yellow(fromDetails?.name ?? String(fromDef.id))} ${chalk.gray('->')} ${chalk.cyan(toDetails?.name ?? String(toDef.id))}`
        );
      } else {
        this.log(
          chalk.gray(
            `No relationship annotation found between ${fromDetails?.name ?? String(fromDef.id)} and ${toDetails?.name ?? String(toDef.id)}`
          )
        );
      }
    });
  }
}
