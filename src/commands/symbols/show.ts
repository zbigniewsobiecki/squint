import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

interface CallSiteWithContext {
  filePath: string;
  line: number;
  column: number;
  containingFunction: string | null;
  contextLines: string[];
  contextStartLine: number;
}

interface SymbolInfo {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  isExported: boolean;
  sourceCode: string[];
  callSites: CallSiteWithContext[];
  metadata: Record<string, string>;
}

export default class Show extends Command {
  static override description = 'Show detailed information about a symbol';

  static override examples = [
    '<%= config.bin %> symbols show parseFile',
    '<%= config.bin %> symbols show --id 42',
    '<%= config.bin %> symbols show MyClass --file src/models/user.ts',
    '<%= config.bin %> symbols show parseFile --json',
    '<%= config.bin %> symbols show foo -c 5',
  ];

  static override args = {
    name: Args.string({ description: 'Symbol name to look up', required: false }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Filter to specific file (for disambiguation)',
    }),
    id: Flags.integer({
      description: 'Look up by definition ID directly',
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
    'context-lines': Flags.integer({
      char: 'c',
      description: 'Number of context lines around call sites',
      default: 3,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Show);

    // Validate arguments
    if (!args.name && flags.id === undefined) {
      this.error('Either provide a symbol name or use --id');
    }

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
      // Resolve the definition
      const definition = await this.resolveDefinition(db, args.name, flags.id, flags.file);

      if (!definition) {
        return; // Error already shown in resolveDefinition
      }

      // Get full definition details
      const defDetails = db.getDefinitionById(definition.id);
      if (!defDetails) {
        this.error(chalk.red(`Definition with ID ${definition.id} not found`));
      }

      // Read source code
      const sourceCode = await this.readSourceCode(defDetails.filePath, defDetails.line, defDetails.endLine);

      // Get call sites with context
      const callSites = await this.getCallSitesWithContext(db, definition.id, flags['context-lines']);

      // Get metadata
      const metadata = db.getDefinitionMetadata(definition.id);

      const symbolInfo: SymbolInfo = {
        id: defDetails.id,
        name: defDetails.name,
        kind: defDetails.kind,
        filePath: defDetails.filePath,
        line: defDetails.line,
        endLine: defDetails.endLine,
        isExported: defDetails.isExported,
        sourceCode,
        callSites,
        metadata,
      };

      if (flags.json) {
        this.log(JSON.stringify(symbolInfo, null, 2));
      } else {
        this.outputPlainText(symbolInfo);
      }
    } finally {
      db.close();
    }
  }

  private async resolveDefinition(
    db: IndexDatabase,
    name: string | undefined,
    id: number | undefined,
    filePath: string | undefined
  ): Promise<{ id: number } | null> {
    // Direct ID lookup
    if (id !== undefined) {
      const def = db.getDefinitionById(id);
      if (!def) {
        this.error(chalk.red(`No definition found with ID ${id}`));
      }
      return { id };
    }

    // Name lookup
    if (!name) {
      this.error(chalk.red('Symbol name is required'));
    }

    let matches = db.getDefinitionsByName(name);

    if (matches.length === 0) {
      this.error(chalk.red(`No symbol found with name "${name}"`));
    }

    // Filter by file if specified
    if (filePath) {
      const resolvedPath = path.resolve(filePath);
      matches = matches.filter(m => m.filePath === resolvedPath || m.filePath.endsWith(filePath));

      if (matches.length === 0) {
        this.error(chalk.red(`No symbol "${name}" found in file "${filePath}"`));
      }
    }

    // Disambiguation needed
    if (matches.length > 1) {
      this.log(chalk.yellow(`Multiple symbols found with name "${name}":`));
      this.log('');
      for (const match of matches) {
        this.log(`  ${chalk.cyan('--id')} ${match.id}\t${match.kind}\t${match.filePath}:${match.line}`);
      }
      this.log('');
      this.log(chalk.gray('Use --id or --file to disambiguate'));
      return null;
    }

    return { id: matches[0].id };
  }

  private async readSourceCode(filePath: string, startLine: number, endLine: number): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      // Convert to 0-based indexing for array access
      return lines.slice(startLine - 1, endLine);
    } catch {
      return ['<source code not available>'];
    }
  }

  private async getCallSitesWithContext(
    db: IndexDatabase,
    definitionId: number,
    contextLines: number
  ): Promise<CallSiteWithContext[]> {
    const callsites = db.getCallsites(definitionId);

    // Group call sites by file for efficient reading
    const byFile = new Map<string, typeof callsites>();
    for (const cs of callsites) {
      if (!byFile.has(cs.filePath)) {
        byFile.set(cs.filePath, []);
      }
      byFile.get(cs.filePath)!.push(cs);
    }

    const result: CallSiteWithContext[] = [];

    for (const [filePath, fileCallsites] of byFile) {
      // Read file content once
      let fileLines: string[] = [];
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        fileLines = content.split('\n');
      } catch {
        // File not readable, add callsites without context
        for (const cs of fileCallsites) {
          result.push({
            filePath: cs.filePath,
            line: cs.line,
            column: cs.column,
            containingFunction: null,
            contextLines: ['<source not available>'],
            contextStartLine: cs.line,
          });
        }
        continue;
      }

      // Get definitions in this file to find containing functions
      const fileId = db.getFileId(filePath);
      const fileDefs = fileId ? db.getFileDefinitions(fileId) : [];

      for (const cs of fileCallsites) {
        // Find containing function (smallest definition that contains this line)
        const containingDef = fileDefs
          .filter(def => def.line <= cs.line && cs.line <= def.endLine)
          .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];

        const containingFunction = containingDef?.name ?? null;

        // Extract context lines
        const startLine = Math.max(1, cs.line - contextLines);
        const endLine = Math.min(fileLines.length, cs.line + contextLines);
        const context = fileLines.slice(startLine - 1, endLine);

        result.push({
          filePath: cs.filePath,
          line: cs.line,
          column: cs.column,
          containingFunction,
          contextLines: context,
          contextStartLine: startLine,
        });
      }
    }

    return result;
  }

  private outputPlainText(info: SymbolInfo): void {
    // Definition section
    this.log(chalk.bold('=== Definition ==='));
    this.log('');
    this.log(`Name:       ${chalk.cyan(info.name)}`);
    this.log(`Kind:       ${info.kind}`);
    this.log(`File:       ${info.filePath}`);
    this.log(`Lines:      ${info.line}-${info.endLine}`);
    this.log(`Exported:   ${info.isExported ? 'yes' : 'no'}`);

    // Metadata section
    const metadataKeys = Object.keys(info.metadata);
    if (metadataKeys.length > 0) {
      this.log('');
      this.log(chalk.bold('=== Metadata ==='));
      this.log('');
      for (const key of metadataKeys.sort()) {
        this.log(`${key}:`.padEnd(12) + info.metadata[key]);
      }
    }

    // Source code section
    this.log('');
    this.log(chalk.bold('=== Source Code ==='));
    this.log('');
    for (let i = 0; i < info.sourceCode.length; i++) {
      const lineNum = info.line + i;
      const lineNumStr = String(lineNum).padStart(5, ' ');
      this.log(`${chalk.gray(lineNumStr)} | ${info.sourceCode[i]}`);
    }

    // Call sites section
    this.log('');
    this.log(chalk.bold(`=== Call Sites (${info.callSites.length}) ===`));

    if (info.callSites.length === 0) {
      this.log('');
      this.log(chalk.gray('No call sites found.'));
      return;
    }

    for (const callSite of info.callSites) {
      this.log('');
      const location = `${callSite.filePath}:${callSite.line}`;
      const inFunction = callSite.containingFunction ? ` in ${chalk.cyan(callSite.containingFunction)}()` : '';
      this.log(`${chalk.yellow(location)}${inFunction}`);
      this.log(chalk.gray('─'.repeat(60)));

      for (let i = 0; i < callSite.contextLines.length; i++) {
        const lineNum = callSite.contextStartLine + i;
        const lineNumStr = String(lineNum).padStart(5, ' ');
        const isTargetLine = lineNum === callSite.line;
        const prefix = isTargetLine ? chalk.red('>') : ' ';
        const line = callSite.contextLines[i];
        const formattedLine = isTargetLine ? chalk.white(line) : line;
        this.log(`${prefix}${chalk.gray(lineNumStr)} | ${formattedLine}`);
      }
    }
  }
}
