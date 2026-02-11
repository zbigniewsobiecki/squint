import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class InteractionsCreate extends Command {
  static override description = 'Create a new module interaction';

  static override examples = [
    '<%= config.bin %> interactions create --from project.backend.auth --to project.backend.db',
    '<%= config.bin %> interactions create --from project.backend.auth --to project.backend.db --semantic "authenticates users" --pattern business',
  ];

  static override flags = {
    database: SharedFlags.database,
    from: Flags.string({
      description: 'Source module path',
      required: true,
    }),
    to: Flags.string({
      description: 'Target module path',
      required: true,
    }),
    semantic: Flags.string({
      description: 'Semantic description of the interaction',
    }),
    pattern: Flags.string({
      description: 'Interaction pattern',
      options: ['business', 'utility'],
    }),
    direction: Flags.string({
      description: 'Interaction direction',
      options: ['uni', 'bi'],
      default: 'uni',
    }),
    weight: Flags.integer({
      description: 'Interaction weight',
      default: 1,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InteractionsCreate);

    await withDatabase(flags.database, this, async (db) => {
      const fromModule = db.modules.getByPath(flags.from);
      if (!fromModule) {
        this.error(chalk.red(`Module "${flags.from}" not found.`));
      }

      const toModule = db.modules.getByPath(flags.to);
      if (!toModule) {
        this.error(chalk.red(`Module "${flags.to}" not found.`));
      }

      const id = db.interactions.insert(fromModule.id, toModule.id, {
        direction: flags.direction as 'uni' | 'bi',
        weight: flags.weight,
        pattern: flags.pattern as 'business' | 'utility' | undefined,
        semantic: flags.semantic,
      });

      this.log(`Created interaction ${chalk.cyan(String(id))}: ${chalk.cyan(flags.from)} -> ${chalk.cyan(flags.to)}`);
    });
  }
}
