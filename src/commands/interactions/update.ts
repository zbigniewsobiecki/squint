import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class InteractionsUpdate extends Command {
  static override description = 'Update an interaction';

  static override examples = [
    '<%= config.bin %> interactions update 5 --semantic "handles auth requests"',
    '<%= config.bin %> interactions update 5 --pattern business --direction bi',
  ];

  static override args = {
    id: Args.integer({ description: 'Interaction ID', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    semantic: Flags.string({
      description: 'Semantic description',
    }),
    pattern: Flags.string({
      description: 'Interaction pattern',
      options: ['business', 'utility'],
    }),
    direction: Flags.string({
      description: 'Interaction direction',
      options: ['uni', 'bi'],
    }),
    symbols: Flags.string({
      description: 'Comma-separated list of symbol names',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(InteractionsUpdate);

    await withDatabase(flags.database, this, async (db) => {
      const existing = db.interactions.getById(args.id);
      if (!existing) {
        this.error(chalk.red(`Interaction ${args.id} not found.`));
      }

      const updates: {
        direction?: 'uni' | 'bi';
        pattern?: 'utility' | 'business';
        symbols?: string[];
        semantic?: string;
      } = {};
      if (flags.semantic) updates.semantic = flags.semantic;
      if (flags.pattern) updates.pattern = flags.pattern as 'business' | 'utility';
      if (flags.direction) updates.direction = flags.direction as 'uni' | 'bi';
      if (flags.symbols) updates.symbols = flags.symbols.split(',').map((s) => s.trim());

      if (Object.keys(updates).length === 0) {
        this.error(chalk.red('At least one update flag is required (--semantic, --pattern, --direction, --symbols).'));
      }

      const updated = db.interactions.update(args.id, updates);
      if (!updated) {
        this.error(chalk.red(`Failed to update interaction ${args.id}.`));
      }

      this.log(`Updated interaction ${chalk.cyan(String(args.id))}`);
    });
  }
}
