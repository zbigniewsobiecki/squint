import fs from 'node:fs/promises';
import path from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { type IIndexWriter, IndexDatabase, computeHash } from '../db/database.js';
import { type ParsedFile, parseFile } from '../parser/ast-parser.js';
import { buildWorkspaceMap } from '../parser/workspace-resolver.js';
import { scanDirectory } from '../utils/file-scanner.js';

export interface IndexingResult {
  definitionCount: number;
  referenceCount: number;
  usageCount: number;
  inheritanceRelationships: {
    extendsCreated: number;
    implementsCreated: number;
    notFound: number;
  };
}

/**
 * Populates the database with parsed file data.
 * Extracted for testability - takes pre-parsed files and a database writer.
 */
export function indexParsedFiles(
  parsedFiles: Map<string, ParsedFile>,
  db: IIndexWriter,
  sourceDirectory: string
): IndexingResult {
  // Set metadata
  db.setMetadata('indexed_at', new Date().toISOString());
  db.setMetadata('source_directory', sourceDirectory);
  db.setMetadata('version', '1.0.0');

  // First pass: Insert all files and their definitions
  const fileIdMap = new Map<string, number>();
  const definitionMap = new Map<string, Map<string, number>>(); // filePath -> (name -> defId) for exported
  const allDefinitionMap = new Map<string, Map<string, number>>(); // filePath -> (name -> defId) for all

  for (const [filePath, parsed] of parsedFiles) {
    const fileId = db.insertFile({
      path: path.relative(sourceDirectory, filePath),
      language: parsed.language,
      contentHash: computeHash(parsed.content),
      sizeBytes: parsed.sizeBytes,
      modifiedAt: parsed.modifiedAt,
    });
    fileIdMap.set(filePath, fileId);

    // Insert definitions for this file
    const defMap = new Map<string, number>();
    const allDefMap = new Map<string, number>();
    for (const def of parsed.definitions) {
      const defId = db.insertDefinition(fileId, def);
      allDefMap.set(def.name, defId);
      if (def.isExported) {
        defMap.set(def.name, defId);
      }
    }
    definitionMap.set(filePath, defMap);
    allDefinitionMap.set(filePath, allDefMap);
  }

  // Second pass: Insert references and link symbols to definitions
  for (const [filePath, parsed] of parsedFiles) {
    const fromFileId = fileIdMap.get(filePath)!;

    for (const ref of parsed.references) {
      // Resolve the target file
      const toFileId = ref.resolvedPath ? (fileIdMap.get(ref.resolvedPath) ?? null) : null;

      const refId = db.insertReference(fromFileId, toFileId, ref);

      // Insert symbols for this reference
      for (const sym of ref.imports) {
        // Try to link to the definition if we have a resolved path
        let defId: number | null = null;
        if (ref.resolvedPath && !ref.isExternal) {
          const targetDefMap = definitionMap.get(ref.resolvedPath);
          if (targetDefMap) {
            // For default imports, look for 'default' export
            // For named imports, look for the original name
            const lookupName = sym.kind === 'default' ? 'default' : sym.name;
            defId = targetDefMap.get(lookupName) ?? null;

            // Also try the original name for default exports that use a named function/class
            if (defId === null && sym.kind === 'default') {
              // Default exports might be named exports marked as default
              for (const [name, id] of targetDefMap) {
                const defCheck = db.getDefinitionByName(fileIdMap.get(ref.resolvedPath)!, name);
                if (defCheck !== null) {
                  // Check if this is the default export by querying the database
                  // For simplicity, we already tracked default in the definition
                  defId = id;
                  break;
                }
              }
            }
          }
        }

        // Follow re-export chains when definition wasn't found directly
        if (defId === null && ref.resolvedPath && !ref.isExternal) {
          defId = followReExportChain(
            sym.kind === 'default' ? 'default' : sym.name,
            ref.resolvedPath,
            parsedFiles,
            definitionMap,
            new Set()
          );
        }

        const symbolId = db.insertSymbol(refId, defId, sym);

        // Insert usages for this symbol
        for (const usage of sym.usages) {
          db.insertUsage(symbolId, usage);
        }
      }
    }
  }

  // Third pass: Insert internal usages (same-file calls)
  for (const [filePath, parsed] of parsedFiles) {
    const fileId = fileIdMap.get(filePath)!;
    const allDefMap = allDefinitionMap.get(filePath);

    for (const internalUsage of parsed.internalUsages) {
      // Find the definition ID for this symbol
      const defId = allDefMap?.get(internalUsage.definitionName) ?? null;

      // Create a symbol entry for internal usage (no reference_id, has file_id)
      const symbolId = db.insertSymbol(
        null, // no reference_id
        defId,
        {
          name: internalUsage.definitionName,
          localName: internalUsage.definitionName,
          kind: 'named',
          usages: internalUsage.usages,
        },
        fileId // file_id for internal symbols
      );

      // Insert usages for this internal symbol
      for (const usage of internalUsage.usages) {
        db.insertUsage(symbolId, usage);
      }
    }
  }

  return {
    definitionCount: db.getDefinitionCount(),
    referenceCount: db.getReferenceCount(),
    usageCount: db.getUsageCount(),
    inheritanceRelationships: { extendsCreated: 0, implementsCreated: 0, notFound: 0 },
  };
}

/**
 * Follow re-export chains to find the original definition.
 * When a module re-exports a symbol from another module, this traces through
 * the chain to find where the symbol is actually defined.
 */
function followReExportChain(
  symbolName: string,
  filePath: string,
  parsedFiles: Map<string, ParsedFile>,
  definitionMap: Map<string, Map<string, number>>,
  visited: Set<string>
): number | null {
  if (visited.has(filePath) || visited.size >= 5) return null;
  visited.add(filePath);

  const parsed = parsedFiles.get(filePath);
  if (!parsed) return null;

  for (const ref of parsed.references) {
    if ((ref.type !== 're-export' && ref.type !== 'export-all') || !ref.resolvedPath) continue;

    if (ref.type === 'export-all') {
      // export * from './source' — symbol might come from here
      const defId = definitionMap.get(ref.resolvedPath)?.get(symbolName) ?? null;
      if (defId !== null) return defId;
      const found = followReExportChain(symbolName, ref.resolvedPath, parsedFiles, definitionMap, visited);
      if (found !== null) return found;
    } else {
      // export { X } from './source' — check if X matches
      for (const sym of ref.imports) {
        if (sym.name === symbolName || sym.localName === symbolName) {
          const defId = definitionMap.get(ref.resolvedPath)?.get(sym.name) ?? null;
          if (defId !== null) return defId;
          const found = followReExportChain(sym.name, ref.resolvedPath, parsedFiles, definitionMap, visited);
          if (found !== null) return found;
        }
      }
    }
  }
  return null;
}

export default class Parse extends Command {
  static override description = 'Index TypeScript/JavaScript files into an SQLite database';

  static override examples = [
    '<%= config.bin %> ./src',
    '<%= config.bin %> ./src --output ./.squint.db',
    '<%= config.bin %> ./src -o ./.squint.db',
  ];

  static override args = {
    directory: Args.string({
      description: 'Directory to scan for TypeScript/JavaScript files',
      required: true,
    }),
  };

  static override flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output database file path (default: <directory>/.squint.db)',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Parse);

    const directory = path.resolve(args.directory);
    const outputPath = flags.output
      ? path.resolve(flags.output)
      : process.env.SQUINT_DB_PATH
        ? path.resolve(process.env.SQUINT_DB_PATH)
        : path.join(directory, '.squint.db');

    // Check if directory exists
    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) {
        this.error(chalk.red(`"${directory}" is not a directory`));
      }
    } catch {
      this.error(chalk.red(`Directory "${directory}" does not exist`));
    }

    // Scan for files
    this.log(chalk.blue('Scanning for TypeScript/JavaScript files...'));
    const files = await scanDirectory(directory);

    if (files.length === 0) {
      this.warn(chalk.yellow('No TypeScript or JavaScript files found in the directory'));
      return;
    }

    this.log(chalk.green(`Found ${files.length} file(s)`));

    // Parse files
    this.log(chalk.blue('Parsing files...'));
    const parsedFiles: Map<string, ParsedFile> = new Map();
    const knownFiles = new Set(files);
    const workspaceMap = buildWorkspaceMap(directory, knownFiles);
    let successCount = 0;
    let errorCount = 0;

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);
      try {
        process.stdout.write(chalk.gray(`  Parsing ${relativePath}...`));
        const parsed = await parseFile(filePath, knownFiles, workspaceMap);
        parsedFiles.set(filePath, parsed);
        successCount++;
        process.stdout.write(chalk.green(' done\n'));
      } catch (error) {
        errorCount++;
        process.stdout.write(chalk.red(' failed\n'));
        const message = error instanceof Error ? error.message : String(error);
        this.warn(chalk.yellow(`    Error: ${message}`));
      }
    }

    if (successCount === 0) {
      this.error(chalk.red('No files were successfully parsed'));
    }

    // Remove old database if exists
    try {
      await fs.unlink(outputPath);
    } catch {
      // File doesn't exist, that's fine
    }

    // Create database and initialize schema
    this.log(chalk.blue('Indexing to database...'));
    const db = new IndexDatabase(outputPath);
    db.initialize();

    // Index parsed files
    const { definitionCount, referenceCount, usageCount } = indexParsedFiles(parsedFiles, db, directory);

    // Create inheritance relationships (extends/implements)
    const inheritanceResult = db.graph.createInheritanceRelationships();

    db.close();

    // Summary
    this.log('');
    this.log(chalk.green.bold('✓ Indexing complete!'));
    this.log(chalk.white(`  Files indexed: ${successCount}`));
    this.log(chalk.white(`  Definitions found: ${definitionCount}`));
    this.log(chalk.white(`  References found: ${referenceCount}`));
    this.log(chalk.white(`  Symbol usages: ${usageCount}`));
    if (inheritanceResult.created > 0) {
      this.log(chalk.white(`  Inheritance relationships: ${inheritanceResult.created}`));
    }
    if (errorCount > 0) {
      this.log(chalk.yellow(`  Files with errors: ${errorCount}`));
    }
    this.log(chalk.white(`  Database written to: ${outputPath}`));
  }
}
