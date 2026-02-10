import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, SymbolResolver, withDatabase } from '../_shared/index.js';

// biome-ignore lint/suspicious/noShadowRestrictedNames: Command class must match CLI command name
export default class Set extends Command {
  static override description = 'Set a semantic annotation on a relationship between two symbols';

  static override examples = [
    '<%= config.bin %> relationships set "delegates credential validation" --from loginController --to authService',
    '<%= config.bin %> relationships set "persists customer data to PostgreSQL" --from-id 42 --to-id 15',
  ];

  static override args = {
    semantic: Args.string({
      description: 'Semantic description of why this relationship exists',
      required: true,
    }),
  };

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
    const { args, flags } = await this.parse(Set);

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

      // Set the relationship annotation
      db.relationships.set(fromDef.id, toDef.id, args.semantic);

      const fromDetails = db.definitions.getById(fromDef.id);
      const toDetails = db.definitions.getById(toDef.id);

      this.log(
        `Set relationship: ${chalk.yellow(fromDetails?.name ?? String(fromDef.id))} ${chalk.gray('->')} ${chalk.cyan(toDetails?.name ?? String(toDef.id))}`
      );
      this.log(`  ${args.semantic}`);
    });
  }
}
