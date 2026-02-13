import path from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import type { InteractionWithPaths } from '../../db/schema.js';
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

interface MappedInteraction {
  id: number;
  fromModulePath: string;
  toModulePath: string;
  pattern: string | null;
  semantic: string | null;
  weight: number;
  direction: string;
  source: string;
}

function mapInteraction(i: InteractionWithPaths): MappedInteraction {
  return {
    id: i.id,
    fromModulePath: i.fromModulePath,
    toModulePath: i.toModulePath,
    pattern: i.pattern,
    semantic: i.semantic,
    weight: i.weight,
    direction: i.direction,
    source: i.source,
  };
}

export default class Show extends Command {
  static override description = 'Show detailed information about a symbol or file';

  static override examples = [
    '<%= config.bin %> symbols show parseFile',
    '<%= config.bin %> symbols show --id 42',
    '<%= config.bin %> symbols show MyClass --file src/models/user.ts',
    '<%= config.bin %> symbols show parseFile --json',
    '<%= config.bin %> symbols show foo -c 5',
    '<%= config.bin %> symbols show --file src/auth/service.ts',
  ];

  static override args = {
    name: Args.string({ description: 'Symbol name to look up', required: false }),
  };

  static override flags = {
    database: SharedFlags.database,
    file: Flags.string({
      char: 'f',
      description: 'Filter to specific file (for disambiguation or file-level aggregation)',
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

    // File aggregation mode: --file without name or --id
    if (flags.file && !args.name && flags.id === undefined) {
      await withDatabase(flags.database, this, async (db) => {
        await this.runFileMode(db, flags.file!, flags.json);
      });
      return;
    }

    // Validate arguments for single-symbol mode
    if (!args.name && flags.id === undefined) {
      this.error('Either provide a symbol name, use --id, or use --file for file-level aggregation');
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

      // Get interactions involving this symbol
      const moduleId = moduleResult?.module.id;
      let incomingInteractions: InteractionWithPaths[] = [];
      let outgoingInteractions: InteractionWithPaths[] = [];
      if (moduleId) {
        const depNames = dependencies.map((d) => d.name);
        incomingInteractions = db.interactions.getIncomingForSymbols(moduleId, [defDetails.name]);
        outgoingInteractions = db.interactions.getOutgoingForSymbols(moduleId, depNames);
      }

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
        interactions: {
          incoming: incomingInteractions.map(mapInteraction),
          outgoing: outgoingInteractions.map(mapInteraction),
        },
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
          moduleResult,
          incomingInteractions,
          outgoingInteractions
        );
      });
    });
  }

  private async runFileMode(db: IndexDatabase, filePath: string, jsonFlag: boolean | undefined): Promise<void> {
    // Resolve file path
    const resolvedPath = path.resolve(filePath);
    const relativePath = db.toRelativePath(resolvedPath);

    // Try both relative and resolved paths
    let fileId = db.files.getIdByPath(relativePath);
    if (!fileId) {
      fileId = db.files.getIdByPath(resolvedPath);
    }
    if (!fileId) {
      // Try matching by suffix
      fileId = db.files.getIdByPath(filePath);
    }
    if (!fileId) {
      this.error(chalk.red(`File not found in index: "${filePath}"`));
    }

    // Get all definitions in file
    const fileDefs = db.definitions.getForFile(fileId);
    if (fileDefs.length === 0) {
      this.error(chalk.red(`No symbols found in file: "${filePath}"`));
    }

    // Get all unique modules these definitions belong to
    const moduleMap = new Map<number, { name: string; fullPath: string }>();
    for (const def of fileDefs) {
      const modResult = db.modules.getDefinitionModule(def.id);
      if (modResult && !moduleMap.has(modResult.module.id)) {
        moduleMap.set(modResult.module.id, { name: modResult.module.name, fullPath: modResult.module.fullPath });
      }
    }

    // Aggregate relationships across all definitions (deduplicate by a composite key)
    const outRelMap = new Map<string, (typeof outgoingRels)[0]>();
    const inRelMap = new Map<string, (typeof incomingRels)[0]>();
    const outgoingRels: Array<{
      toDefinitionId: number;
      toName: string;
      toKind: string;
      relationshipType: string;
      semantic: string;
      toFilePath: string;
      toLine: number;
    }> = [];
    const incomingRels: Array<{
      fromDefinitionId: number;
      fromName: string;
      fromKind: string;
      relationshipType: string;
      semantic: string;
      fromFilePath: string;
      fromLine: number;
    }> = [];

    for (const def of fileDefs) {
      for (const r of db.relationships.getFrom(def.id)) {
        const key = `${def.id}-${r.toDefinitionId}-${r.relationshipType}`;
        if (!outRelMap.has(key)) {
          const mapped = {
            toDefinitionId: r.toDefinitionId,
            toName: r.toName,
            toKind: r.toKind,
            relationshipType: r.relationshipType,
            semantic: r.semantic,
            toFilePath: r.toFilePath,
            toLine: r.toLine,
          };
          outRelMap.set(key, mapped);
          outgoingRels.push(mapped);
        }
      }
      for (const r of db.relationships.getTo(def.id)) {
        const key = `${r.fromDefinitionId}-${def.id}-${r.relationshipType}`;
        if (!inRelMap.has(key)) {
          const mapped = {
            fromDefinitionId: r.fromDefinitionId,
            fromName: r.fromName,
            fromKind: r.fromKind,
            relationshipType: r.relationshipType,
            semantic: r.semantic,
            fromFilePath: r.fromFilePath,
            fromLine: r.fromLine,
          };
          inRelMap.set(key, mapped);
          incomingRels.push(mapped);
        }
      }
    }

    // Aggregate flows (deduplicate by flow id)
    const flowMap = new Map<number, { id: number; name: string; slug: string; stakeholder: string | null }>();
    for (const def of fileDefs) {
      for (const f of db.flows.getFlowsWithDefinition(def.id)) {
        if (!flowMap.has(f.id)) {
          flowMap.set(f.id, { id: f.id, name: f.name, slug: f.slug, stakeholder: f.stakeholder });
        }
      }
    }

    // Aggregate interactions using all file symbol names
    const allSymbolNames = fileDefs.map((d) => d.name);
    // Collect all dependency names across all definitions for outgoing
    const allDepNames: string[] = [];
    for (const def of fileDefs) {
      for (const dep of db.dependencies.getForDefinition(def.id)) {
        allDepNames.push(dep.name);
      }
    }
    const uniqueDepNames = [...new Set(allDepNames)];

    const inInteractionMap = new Map<number, MappedInteraction>();
    const outInteractionMap = new Map<number, MappedInteraction>();
    for (const [moduleId] of moduleMap) {
      for (const i of db.interactions.getIncomingForSymbols(moduleId, allSymbolNames)) {
        if (!inInteractionMap.has(i.id)) {
          inInteractionMap.set(i.id, mapInteraction(i));
        }
      }
      for (const i of db.interactions.getOutgoingForSymbols(moduleId, uniqueDepNames)) {
        if (!outInteractionMap.has(i.id)) {
          outInteractionMap.set(i.id, mapInteraction(i));
        }
      }
    }

    const jsonData = {
      file: relativePath || filePath,
      symbols: fileDefs.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        line: d.line,
        endLine: d.endLine,
        isExported: d.isExported,
      })),
      modules: [...moduleMap.entries()].map(([, m]) => ({ name: m.name, fullPath: m.fullPath })),
      relationships: {
        outgoing: outgoingRels,
        incoming: incomingRels,
      },
      interactions: {
        incoming: [...inInteractionMap.values()],
        outgoing: [...outInteractionMap.values()],
      },
      flows: [...flowMap.values()],
    };

    outputJsonOrPlain(this, jsonFlag ?? false, jsonData, () => {
      this.outputFileModePlainText(jsonData);
    });
  }

  private outputFileModePlainText(data: {
    file: string;
    symbols: Array<{ id: number; name: string; kind: string; line: number; endLine: number; isExported: boolean }>;
    modules: Array<{ name: string; fullPath: string }>;
    relationships: {
      outgoing: Array<{
        toName: string;
        toKind: string;
        relationshipType: string;
        semantic: string;
        toFilePath: string;
        toLine: number;
      }>;
      incoming: Array<{
        fromName: string;
        fromKind: string;
        relationshipType: string;
        semantic: string;
        fromFilePath: string;
        fromLine: number;
      }>;
    };
    interactions: { incoming: MappedInteraction[]; outgoing: MappedInteraction[] };
    flows: Array<{ id: number; name: string; slug: string; stakeholder: string | null }>;
  }): void {
    this.log(chalk.bold(`=== File: ${data.file} ===`));

    // Symbols
    this.log('');
    this.log(chalk.bold(`=== Symbols (${data.symbols.length}) ===`));
    this.log('');
    for (const s of data.symbols) {
      const exported = s.isExported ? chalk.green('exported') : chalk.gray('internal');
      this.log(`  ${chalk.cyan(s.name)} (${s.kind}) ${exported} ${chalk.gray(`L${s.line}-${s.endLine}`)}`);
    }

    // Modules
    if (data.modules.length > 0) {
      this.log('');
      this.log(chalk.bold(`=== Modules (${data.modules.length}) ===`));
      this.log('');
      for (const m of data.modules) {
        this.log(`  ${chalk.cyan(m.name)} ${chalk.gray(`(${m.fullPath})`)}`);
      }
    }

    // Relationships
    if (data.relationships.outgoing.length > 0) {
      this.log('');
      this.log(chalk.bold(`=== Relationships Outgoing (${data.relationships.outgoing.length}) ===`));
      this.log('');
      for (const r of data.relationships.outgoing) {
        const semantic = r.semantic ? ` "${r.semantic}"` : '';
        this.log(
          `  -> ${chalk.cyan(r.toName)} (${r.toKind}) [${r.relationshipType}]${chalk.gray(semantic)} ${chalk.gray(`${r.toFilePath}:${r.toLine}`)}`
        );
      }
    }

    if (data.relationships.incoming.length > 0) {
      this.log('');
      this.log(chalk.bold(`=== Relationships Incoming (${data.relationships.incoming.length}) ===`));
      this.log('');
      for (const r of data.relationships.incoming) {
        const semantic = r.semantic ? ` "${r.semantic}"` : '';
        this.log(
          `  <- ${chalk.cyan(r.fromName)} (${r.fromKind}) [${r.relationshipType}]${chalk.gray(semantic)} ${chalk.gray(`${r.fromFilePath}:${r.fromLine}`)}`
        );
      }
    }

    // Interactions
    this.printInteractionsSection('Incoming', data.interactions.incoming);
    this.printInteractionsSection('Outgoing', data.interactions.outgoing);

    // Flows
    if (data.flows.length > 0) {
      this.log('');
      this.log(chalk.bold(`=== Flows (${data.flows.length}) ===`));
      this.log('');
      for (const f of data.flows) {
        const stakeholder = f.stakeholder ? ` [${f.stakeholder}]` : '';
        this.log(`  ${chalk.cyan(f.name)} (${f.slug})${chalk.gray(stakeholder)}`);
      }
    }
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

  private printInteractionsSection(label: string, interactions: MappedInteraction[]): void {
    if (interactions.length === 0) return;

    this.log('');
    this.log(chalk.bold(`=== Interactions ${label} (${interactions.length}) ===`));
    this.log('');
    for (const i of interactions) {
      const arrow = i.direction === 'bi' ? '\u2194' : '\u2192';
      const patternLabel =
        i.pattern === 'business' ? chalk.cyan('[business]') : i.pattern === 'utility' ? chalk.yellow('[utility]') : '';
      const sourceLabel = i.source === 'llm-inferred' ? chalk.magenta('[inferred]') : chalk.gray('[ast]');

      const fromShort = i.fromModulePath.split('.').slice(-2).join('.');
      const toShort = i.toModulePath.split('.').slice(-2).join('.');

      this.log(`  ${fromShort} ${arrow} ${toShort} ${patternLabel} ${sourceLabel}`);

      if (i.semantic) {
        this.log(`    ${chalk.gray(`"${i.semantic}"`)}`);
      }
    }
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
    moduleResult: { module: { name: string; fullPath: string } } | null,
    incomingInteractions: InteractionWithPaths[],
    outgoingInteractions: InteractionWithPaths[]
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

    // Interactions
    this.printInteractionsSection('Incoming', incomingInteractions.map(mapInteraction));
    this.printInteractionsSection('Outgoing', outgoingInteractions.map(mapInteraction));

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
      this.log(chalk.gray('\u2500'.repeat(60)));

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
