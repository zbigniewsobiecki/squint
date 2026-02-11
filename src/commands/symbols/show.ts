import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import {
  SharedFlags,
  SymbolResolver,
  formatModuleRef,
  outputJsonOrPlain,
  readAllLines,
  readSourceLines,
  withDatabase,
} from '../_shared/index.js';

interface CallSiteWithContext {
  filePath: string;
  line: number;
  column: number;
  containingFunction: string | null;
  contextLines: string[];
  contextStartLine: number;
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
      const defDetails = db.definitions.getById(definition.id);
      if (!defDetails) {
        this.error(chalk.red(`Definition with ID ${definition.id} not found`));
      }

      // Read source code
      const sourceCode = await readSourceLines(
        db.resolveFilePath(defDetails.filePath),
        defDetails.line,
        defDetails.endLine
      );

      // Get call sites with context
      const callSites = await this.getCallSitesWithContext(db, definition.id, flags['context-lines']);

      // Get metadata
      const metadata = db.metadata.get(definition.id);

      // Get module membership
      const moduleResult = db.modules.getDefinitionModule(definition.id);

      // Get relationships (outgoing and incoming)
      const outgoingRelationships = db.relationships.getFrom(definition.id);
      const incomingRelationships = db.relationships.getTo(definition.id);

      // Get dependencies and dependents
      const dependencies = db.dependencies.getForDefinition(definition.id);
      const dependents = db.dependencies.getIncoming(definition.id, 10);
      const dependentCount = db.dependencies.getIncomingCount(definition.id);

      // Get flows involving this definition
      const flows = db.flows.getFlowsWithDefinition(definition.id);

      const jsonData = {
        id: defDetails.id,
        name: defDetails.name,
        kind: defDetails.kind,
        filePath: defDetails.filePath,
        line: defDetails.line,
        endLine: defDetails.endLine,
        isExported: defDetails.isExported,
        metadata,
        module: formatModuleRef(moduleResult),
        relationships: outgoingRelationships.map((r) => ({
          toDefinitionId: r.toDefinitionId,
          toName: r.toName,
          toKind: r.toKind,
          relationshipType: r.relationshipType,
          semantic: r.semantic,
          toFilePath: r.toFilePath,
          toLine: r.toLine,
        })),
        incomingRelationships: incomingRelationships.map((r) => ({
          fromDefinitionId: r.fromDefinitionId,
          fromName: r.fromName,
          fromKind: r.fromKind,
          relationshipType: r.relationshipType,
          semantic: r.semantic,
          fromFilePath: r.fromFilePath,
          fromLine: r.fromLine,
        })),
        dependencies: dependencies.map((d) => ({
          id: d.dependencyId,
          name: d.name,
          kind: d.kind,
          filePath: d.filePath,
          line: d.line,
        })),
        dependents: {
          count: dependentCount,
          sample: dependents.map((d) => ({
            id: d.id,
            name: d.name,
            kind: d.kind,
            filePath: d.filePath,
            line: d.line,
          })),
        },
        flows: flows.map((f) => ({
          id: f.id,
          name: f.name,
          slug: f.slug,
          stakeholder: f.stakeholder,
        })),
        sourceCode,
        callSites,
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        this.outputPlainText(
          jsonData,
          outgoingRelationships,
          incomingRelationships,
          dependencies,
          dependents,
          dependentCount,
          flows,
          moduleResult
        );
      });
    });
  }

  private async getCallSitesWithContext(
    db: IndexDatabase,
    definitionId: number,
    contextLines: number
  ): Promise<CallSiteWithContext[]> {
    const callsites = db.dependencies.getCallsites(definitionId);

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
      const fileLines = await readAllLines(db.resolveFilePath(filePath));

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
      const fileId = db.files.getIdByPath(filePath);
      const fileDefs = fileId ? db.definitions.getForFile(fileId) : [];

      for (const cs of fileCallsites) {
        // Find containing function (smallest definition that contains this line)
        const containingDef = fileDefs
          .filter((def) => def.line <= cs.line && cs.line <= def.endLine)
          .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];

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

  private outputPlainText(
    info: {
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      endLine: number;
      isExported: boolean;
      metadata: Record<string, string>;
      sourceCode: string[];
      callSites: CallSiteWithContext[];
    },
    outgoing: Array<{
      toName: string;
      toKind: string;
      relationshipType: string;
      semantic: string;
      toFilePath: string;
      toLine: number;
    }>,
    incoming: Array<{
      fromName: string;
      fromKind: string;
      relationshipType: string;
      semantic: string;
      fromFilePath: string;
      fromLine: number;
    }>,
    dependencies: Array<{ name: string; kind: string; filePath: string; line: number }>,
    dependents: Array<{ name: string; kind: string; filePath: string; line: number }>,
    dependentCount: number,
    flows: Array<{ name: string; slug: string; stakeholder: string | null }>,
    moduleResult: { module: { name: string; fullPath: string } } | null
  ): void {
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

    // Module section
    if (moduleResult) {
      this.log('');
      this.log(chalk.bold('=== Module ==='));
      this.log('');
      this.log(`${chalk.cyan(moduleResult.module.name)} ${chalk.gray(`(${moduleResult.module.fullPath})`)}`);
    }

    // Relationships (outgoing)
    if (outgoing.length > 0) {
      this.log('');
      this.log(chalk.bold(`=== Relationships Outgoing (${outgoing.length}) ===`));
      this.log('');
      for (const r of outgoing) {
        const semantic = r.semantic ? ` "${r.semantic}"` : '';
        this.log(
          `  -> ${chalk.cyan(r.toName)} (${r.toKind}) [${r.relationshipType}]${chalk.gray(semantic)} ${chalk.gray(`${r.toFilePath}:${r.toLine}`)}`
        );
      }
    }

    // Relationships (incoming)
    if (incoming.length > 0) {
      this.log('');
      this.log(chalk.bold(`=== Relationships Incoming (${incoming.length}) ===`));
      this.log('');
      for (const r of incoming) {
        const semantic = r.semantic ? ` "${r.semantic}"` : '';
        this.log(
          `  <- ${chalk.cyan(r.fromName)} (${r.fromKind}) [${r.relationshipType}]${chalk.gray(semantic)} ${chalk.gray(`${r.fromFilePath}:${r.fromLine}`)}`
        );
      }
    }

    // Dependencies
    if (dependencies.length > 0) {
      this.log('');
      this.log(chalk.bold(`=== Dependencies (${dependencies.length}) ===`));
      this.log('');
      for (const d of dependencies) {
        this.log(`  ${chalk.cyan(d.name)} (${d.kind}) ${chalk.gray(`${d.filePath}:${d.line}`)}`);
      }
    }

    // Dependents
    if (dependentCount > 0) {
      this.log('');
      this.log(chalk.bold(`=== Dependents (${dependents.length} of ${dependentCount}) ===`));
      this.log('');
      for (const d of dependents) {
        this.log(`  ${chalk.cyan(d.name)} (${d.kind}) ${chalk.gray(`${d.filePath}:${d.line}`)}`);
      }
      if (dependentCount > dependents.length) {
        this.log(chalk.gray(`  ... and ${dependentCount - dependents.length} more`));
      }
    }

    // Flows
    if (flows.length > 0) {
      this.log('');
      this.log(chalk.bold(`=== Flows (${flows.length}) ===`));
      this.log('');
      for (const f of flows) {
        const stakeholder = f.stakeholder ? ` [${f.stakeholder}]` : '';
        this.log(`  ${chalk.cyan(f.name)} (${f.slug})${chalk.gray(stakeholder)}`);
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
