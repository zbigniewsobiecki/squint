import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IndexDatabase } from '../../db/database.js';
import { withDatabase, SymbolResolver, SharedFlags, readSourceLines, readAllLines } from '../_shared/index.js';

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
    database: SharedFlags.database,
    file: Flags.string({
      char: 'f',
      description: 'Filter to specific file (for disambiguation)',
    }),
    id: Flags.integer({
      description: 'Look up by definition ID directly',
    }),
    json: SharedFlags.json,
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

    await withDatabase(flags.database, this, async (db) => {
      const resolver = new SymbolResolver(db, this);
      const definition = resolver.resolve(args.name, flags.id, flags.file);

      if (!definition) {
        return; // Disambiguation message already shown
      }

      // Get full definition details
      const defDetails = db.getDefinitionById(definition.id);
      if (!defDetails) {
        this.error(chalk.red(`Definition with ID ${definition.id} not found`));
      }

      // Read source code
      const sourceCode = await readSourceLines(defDetails.filePath, defDetails.line, defDetails.endLine);

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
    });
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
      // Read file content once using shared utility
      const fileLines = await readAllLines(filePath);

      if (fileLines.length === 0) {
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
