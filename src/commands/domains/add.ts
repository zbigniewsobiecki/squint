import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

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
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    description: Flags.string({
      description: 'Domain description (alternative to positional argument)',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Add);

    const dbPath = path.resolve(flags.database);

    // Check if database exists
    try {
      await fs.access(dbPath);
    } catch {
      this.error(chalk.red(`Database file "${dbPath}" does not exist.\nRun 'ats parse <directory>' first to create an index.`));
    }

    // Open database
    let db: IndexDatabase;
    try {
      db = new IndexDatabase(dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(chalk.red(`Failed to open database: ${message}`));
    }

    try {
      // Use description from args or flags
      const description = args.description || flags.description;

      // Add the domain
      const id = db.addDomain(args.name, description);

      if (id === null) {
        this.error(chalk.red(`Domain "${args.name}" already exists.`));
      }

      this.log(`Registered domain ${chalk.cyan(args.name)}${description ? `: ${description}` : ''}`);
    } finally {
      db.close();
    }
  }
}
