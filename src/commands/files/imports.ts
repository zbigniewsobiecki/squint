import path from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class Imports extends Command {
  static override description = 'List files imported by a specific file';

  static override examples = [
    '<%= config.bin %> files imports src/index.ts',
    '<%= config.bin %> files imports ./src/db/database.ts -d ./my-index.db',
    '<%= config.bin %> files imports src/index.ts --exclude-external',
  ];

  static override args = {
    file: Args.string({
      description: 'Path to the file to analyze',
      required: true,
    }),
  };

  static override flags = {
    database: SharedFlags.database,
    'exclude-external': Flags.boolean({
      description: 'Exclude external imports (node_modules, etc.)',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Imports);
    const filePath = path.resolve(args.file);

    await withDatabase(flags.database, this, async (db) => {
      const fileId = db.files.getIdByPath(db.toRelativePath(filePath)) ?? db.files.getIdByPath(filePath);
      if (fileId === null) {
        this.error(chalk.red(`File "${filePath}" not found in the index.`));
      }

      const imports = db.files.getImports(fileId);
      const filteredImports = flags['exclude-external']
        ? imports.filter((imp) => !imp.isExternal && imp.toFilePath)
        : imports;

      if (filteredImports.length === 0) {
        this.log(chalk.gray('No imports found.'));
      } else {
        for (const imp of filteredImports) {
          this.log(imp.toFilePath ?? imp.source);
        }
      }
    });
  }
}
