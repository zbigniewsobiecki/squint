import path from 'node:path';
import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class ImportedBy extends Command {
  static override description = 'List files that import a specific file';

  static override examples = [
    '<%= config.bin %> files imported-by src/db/database.ts',
    '<%= config.bin %> files imported-by ./src/utils.ts -d ./my-index.db',
  ];

  static override args = {
    file: Args.string({
      description: 'Path to the file to analyze',
      required: true,
    }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ImportedBy);
    const filePath = path.resolve(args.file);

    await withDatabase(flags.database, this, async (db) => {
      const fileId = db.files.getIdByPath(filePath);
      if (fileId === null) {
        this.error(chalk.red(`File "${filePath}" not found in the index.`));
      }

      const importers = db.files.getImportedBy(fileId);

      if (importers.length === 0) {
        this.log(chalk.gray('No files import this file.'));
      } else {
        for (const importer of importers) {
          this.log(importer.path);
        }
      }
    });
  }
}
