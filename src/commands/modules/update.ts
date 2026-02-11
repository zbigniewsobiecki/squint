import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class ModulesUpdate extends Command {
  static override description = 'Update a module name or description';

  static override examples = [
    '<%= config.bin %> modules update project.backend.auth --name "Auth Module"',
    '<%= config.bin %> modules update project.backend.auth --description "Handles authentication"',
    '<%= config.bin %> modules update project.backend.auth --name "Auth" --description "Auth module"',
  ];

  static override args = {
    path: Args.string({ description: 'Module path', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    name: Flags.string({
      description: 'New module name',
    }),
    description: Flags.string({
      description: 'New module description',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ModulesUpdate);

    if (!flags.name && !flags.description) {
      this.error(chalk.red('At least one of --name or --description is required.'));
    }

    await withDatabase(flags.database, this, async (db) => {
      const module = db.modules.getByPath(args.path);
      if (!module) {
        this.error(chalk.red(`Module "${args.path}" not found.`));
      }

      const updates: { name?: string; description?: string } = {};
      if (flags.name) updates.name = flags.name;
      if (flags.description) updates.description = flags.description;

      const updated = db.modules.update(module.id, updates);

      if (!updated) {
        this.error(chalk.red(`Failed to update module "${args.path}".`));
      }

      this.log(`Updated module ${chalk.cyan(args.path)}`);
      if (flags.name) this.log(`  Name: ${flags.name}`);
      if (flags.description) this.log(`  Description: ${flags.description}`);
    });
  }
}
