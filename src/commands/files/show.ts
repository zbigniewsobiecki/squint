import path from 'node:path';
import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, formatModuleRef, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

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

      // Enrich each definition with module and metadata
      const enrichedDefinitions = definitions.map((d) => {
        const moduleResult = db.modules.getDefinitionModule(d.id);
        const metadata = db.metadata.get(d.id);
        return {
          id: d.id,
          name: d.name,
          kind: d.kind,
          isExported: d.isExported,
          line: d.line,
          endLine: d.endLine,
          module: formatModuleRef(moduleResult),
          metadata: Object.keys(metadata).length > 0 ? metadata : null,
        };
      });

      // Get relationships from definitions in this file
      const relationships: Array<{
        fromName: string;
        toName: string;
        toFilePath: string;
        toLine: number;
        relationshipType: string;
        semantic: string;
      }> = [];
      for (const d of definitions) {
        const rels = db.relationships.getFrom(d.id);
        for (const r of rels) {
          relationships.push({
            fromName: r.fromName,
            toName: r.toName,
            toFilePath: r.toFilePath,
            toLine: r.toLine,
            relationshipType: r.relationshipType,
            semantic: r.semantic,
          });
        }
      }

      const jsonData = {
        file: fileInfo,
        definitions: enrichedDefinitions,
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
        relationships,
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
          for (const d of enrichedDefinitions) {
            const exported = d.isExported ? chalk.green('[exported]') : chalk.gray('[local]');
            const moduleName = d.module ? chalk.gray(` @${d.module.name}`) : '';
            const purpose = d.metadata?.purpose ? chalk.gray(` - ${d.metadata.purpose}`) : '';
            this.log(
              `  ${chalk.cyan(d.name)} ${chalk.yellow(d.kind)} ${exported} L${d.line}-${d.endLine}${moduleName}${purpose}`
            );
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

        if (relationships.length > 0) {
          this.log('');
          this.log(chalk.bold(`Relationships (${relationships.length})`));
          for (const r of relationships) {
            const semantic = r.semantic ? ` "${r.semantic}"` : '';
            this.log(
              `  ${chalk.cyan(r.fromName)} -> ${chalk.cyan(r.toName)} (${r.toFilePath}:${r.toLine}) [${r.relationshipType}]${chalk.gray(semantic)}`
            );
          }
        }
      });
    });
  }
}
