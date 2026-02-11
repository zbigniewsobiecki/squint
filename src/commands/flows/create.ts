import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FlowsCreate extends Command {
  static override description = 'Create a new flow';

  static override examples = [
    '<%= config.bin %> flows create "User Login" user-login',
    '<%= config.bin %> flows create "User Login" user-login --stakeholder user --description "Login flow"',
  ];

  static override args = {
    name: Args.string({ description: 'Flow name', required: true }),
    slug: Args.string({ description: 'Flow slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    description: Flags.string({
      description: 'Flow description',
    }),
    stakeholder: Flags.string({
      description: 'Flow stakeholder',
      options: ['user', 'admin', 'system', 'developer', 'external'],
    }),
    'entry-point-module-id': Flags.integer({
      description: 'Entry point module ID',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FlowsCreate);

    await withDatabase(flags.database, this, async (db) => {
      const id = db.flows.insert(args.name, args.slug, {
        description: flags.description,
        stakeholder: flags.stakeholder as 'user' | 'admin' | 'system' | 'developer' | 'external' | undefined,
        entryPointModuleId: flags['entry-point-module-id'],
      });

      this.log(`Created flow ${chalk.cyan(args.name)} (${chalk.gray(args.slug)}) with id ${chalk.cyan(String(id))}`);
    });
  }
}
