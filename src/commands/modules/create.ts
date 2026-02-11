import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class ModulesCreate extends Command {
  static override description = 'Create a new module under a parent';

  static override examples = [
    '<%= config.bin %> modules create project.backend "Auth Service"',
    '<%= config.bin %> modules create project "Backend" --slug backend --description "Backend services"',
  ];

  static override args = {
    path: Args.string({ description: 'Parent module path', required: true }),
    name: Args.string({ description: 'Module name', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    description: Flags.string({
      description: 'Module description',
    }),
    slug: Flags.string({
      description: 'Module slug (defaults from name)',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ModulesCreate);

    await withDatabase(flags.database, this, async (db) => {
      // Find parent module
      const parent = db.modules.getByPath(args.path);
      if (!parent) {
        this.error(chalk.red(`Parent module "${args.path}" not found.`));
      }

      const slug = flags.slug ?? args.name.toLowerCase().replace(/\s+/g, '-');

      const id = db.modules.insert(parent.id, slug, args.name, flags.description);

      this.log(`Created module ${chalk.cyan(args.name)} (id: ${id}) under ${chalk.gray(args.path)}`);
    });
  }
}
