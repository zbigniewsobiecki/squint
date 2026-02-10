import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class Add extends Command {
  static override description = 'Register a new domain';

  static override examples = [
    '<%= config.bin %> domains add auth "User authentication and authorization"',
    '<%= config.bin %> domains add payment --description "Payment processing"',
  ];

  static override args = {
    name: Args.string({ description: 'Domain name', required: true }),
    description: Args.string({ description: 'Domain description' }),
  };

  static override flags = {
    database: SharedFlags.database,
    description: Flags.string({
      description: 'Domain description (alternative to positional argument)',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Add);

    await withDatabase(flags.database, this, async (db) => {
      // Use description from args or flags
      const description = args.description || flags.description;

      // Add the domain
      const id = db.domains.add(args.name, description);

      if (id === null) {
        this.error(chalk.red(`Domain "${args.name}" already exists.`));
      }

      this.log(`Registered domain ${chalk.cyan(args.name)}${description ? `: ${description}` : ''}`);
    });
  }
}
