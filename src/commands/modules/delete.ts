import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class ModulesDelete extends Command {
  static override description = 'Delete a module';

  static override examples = [
    '<%= config.bin %> modules delete project.backend.old-module',
    '<%= config.bin %> modules delete project.backend.old-module --force',
  ];

  static override args = {
    path: Args.string({ description: 'Module path to delete', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    force: Flags.boolean({
      char: 'f',
      description: 'Delete even if module has members',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ModulesDelete);

    await withDatabase(flags.database, this, async (db) => {
      const module = db.modules.getByPath(args.path);
      if (!module) {
        this.error(chalk.red(`Module "${args.path}" not found.`));
      }

      if (flags.force) {
        // Unassign all members first
        const members = db.modules.getSymbols(module.id);
        for (const member of members) {
          db.modules.unassignSymbol(member.id);
        }
      }

      try {
        const deleted = db.modules.delete(module.id);
        if (!deleted) {
          this.error(chalk.red(`Failed to delete module "${args.path}".`));
        }
        this.log(`Deleted module ${chalk.cyan(args.path)}`);
      } catch (error) {
        if (error instanceof Error && error.message.includes('member(s)')) {
          this.log(chalk.yellow(error.message));
          this.log(chalk.gray('Use --force to remove members and delete the module.'));
        } else {
          throw error;
        }
      }
    });
  }
}
