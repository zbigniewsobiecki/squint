import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class Orphans extends Command {
  static override description = 'Find files with no incoming imports (orphan files)';

  static override examples = [
    '<%= config.bin %> files orphans',
    '<%= config.bin %> files orphans -d ./my-index.db',
    '<%= config.bin %> files orphans --include-index',
    '<%= config.bin %> files orphans --include-tests',
  ];

  static override flags = {
    database: SharedFlags.database,
    'include-index': Flags.boolean({
      description: 'Include index.ts/index.js files (excluded by default)',
      default: false,
    }),
    'include-tests': Flags.boolean({
      description: 'Include test files (excluded by default)',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Orphans);

    await withDatabase(flags.database, this, async (db) => {
      const orphans = db.files.getOrphans({
        includeIndex: flags['include-index'],
        includeTests: flags['include-tests'],
      });

      if (orphans.length === 0) {
        this.log(chalk.green('No orphan files found.'));
      } else {
        for (const file of orphans) {
          this.log(file.path);
        }
        this.log('');
        this.log(chalk.gray(`Found ${orphans.length} orphan file(s)`));
      }
    });
  }
}
