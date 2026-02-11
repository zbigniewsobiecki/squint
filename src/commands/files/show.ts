import path from 'node:path';
import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

export default class FilesShow extends Command {
  static override description = 'Show file details including definitions and imports';

  static override examples = [
    '<%= config.bin %> files show src/index.ts',
    '<%= config.bin %> files show ./src/db/database.ts --json',
  ];

  static override args = {
    path: Args.string({ description: 'File path to show', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FilesShow);
    const filePath = path.resolve(args.path);

    await withDatabase(flags.database, this, async (db) => {
      const fileId = db.files.getIdByPath(db.toRelativePath(filePath)) ?? db.files.getIdByPath(filePath);
      if (fileId === null) {
        this.error(chalk.red(`File "${filePath}" not found in the index.`));
      }

      const fileInfo = db.files.getById(fileId);
      const definitions = db.definitions.getForFile(fileId);
      const imports = db.files.getImports(fileId);
      const importedBy = db.files.getImportedBy(fileId);

      const jsonData = {
        file: fileInfo,
        definitions: definitions.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          isExported: d.isExported,
          line: d.line,
          endLine: d.endLine,
        })),
        imports: imports.map((i) => ({
          source: i.source,
          toFilePath: i.toFilePath,
          isExternal: i.isExternal,
          isTypeOnly: i.isTypeOnly,
        })),
        importedBy: importedBy.map((i) => ({
          id: i.id,
          path: i.path,
          line: i.line,
        })),
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        this.log(chalk.bold(`File: ${filePath}`));
        if (fileInfo) {
          this.log(`Language: ${fileInfo.language}`);
          this.log(`Size: ${fileInfo.sizeBytes} bytes`);
        }

        this.log('');
        this.log(chalk.bold(`Definitions (${definitions.length})`));
        if (definitions.length === 0) {
          this.log(chalk.gray('  No definitions found.'));
        } else {
          for (const d of definitions) {
            const exported = d.isExported ? chalk.green('[exported]') : chalk.gray('[local]');
            this.log(`  ${chalk.cyan(d.name)} ${chalk.yellow(d.kind)} ${exported} L${d.line}-${d.endLine}`);
          }
        }

        this.log('');
        this.log(chalk.bold(`Imports (${imports.length})`));
        if (imports.length === 0) {
          this.log(chalk.gray('  No imports found.'));
        } else {
          for (const imp of imports) {
            const target = imp.toFilePath ?? imp.source;
            const typeOnly = imp.isTypeOnly ? chalk.gray(' [type-only]') : '';
            this.log(`  ${target}${typeOnly}`);
          }
        }

        this.log('');
        this.log(chalk.bold(`Imported By (${importedBy.length})`));
        if (importedBy.length === 0) {
          this.log(chalk.gray('  No files import this file.'));
        } else {
          for (const imp of importedBy) {
            this.log(`  ${imp.path}:${imp.line}`);
          }
        }
      });
    });
  }
}
