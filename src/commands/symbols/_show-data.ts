import type { IndexDatabase } from '../../db/database.js';
import type { InteractionWithPaths } from '../../db/schema.js';
import { resolveFileId } from '../_shared/file-resolver.js';
import { readAllLines, readSourceLines } from '../_shared/index.js';

// ─── Shared types ────────────────────────────────────────────────────────────

export interface CallSiteWithContext {
  filePath: string;
  line: number;
  column: number;
  containingFunction: string | null;
  contextLines: string[];
  contextStartLine: number;
}

export interface MappedInteraction {
  id: number;
  fromModulePath: string;
  toModulePath: string;
  pattern: string | null;
  semantic: string | null;
  weight: number;
  direction: string;
  source: string;
}

export function mapInteraction(i: InteractionWithPaths): MappedInteraction {
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

// ─── SymbolShowData ───────────────────────────────────────────────────────────

export interface SymbolShowData {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  isExported: boolean;
  metadata: Record<string, string>;
  module: { id: number; name: string; fullPath: string } | null;
  relationships: Array<{
    toDefinitionId: number;
    toName: string;
    toKind: string;
    relationshipType: string;
    semantic: string;
    toFilePath: string;
    toLine: number;
  }>;
  incomingRelationships: Array<{
    fromDefinitionId: number;
    fromName: string;
    fromKind: string;
    relationshipType: string;
    semantic: string;
    fromFilePath: string;
    fromLine: number;
  }>;
  dependencies: Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
  }>;
  dependents: {
    count: number;
    sample: Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
    }>;
  };
  flows: Array<{
    id: number;
    name: string;
    slug: string;
    stakeholder: string | null;
  }>;
  interactions: {
    incoming: MappedInteraction[];
    outgoing: MappedInteraction[];
  };
  sourceCode: string[];
  callSites: CallSiteWithContext[];
}

// ─── FileShowData ─────────────────────────────────────────────────────────────

export interface FileShowData {
  file: string;
  symbols: Array<{
    id: number;
    name: string;
    kind: string;
    line: number;
    endLine: number;
    isExported: boolean;
  }>;
  modules: Array<{ name: string; fullPath: string }>;
  relationships: {
    outgoing: Array<{
      toDefinitionId: number;
      toName: string;
      toKind: string;
      relationshipType: string;
      semantic: string;
      toFilePath: string;
      toLine: number;
    }>;
    incoming: Array<{
      fromDefinitionId: number;
      fromName: string;
      fromKind: string;
      relationshipType: string;
      semantic: string;
      fromFilePath: string;
      fromLine: number;
    }>;
  };
  interactions: {
    incoming: MappedInteraction[];
    outgoing: MappedInteraction[];
  };
  flows: Array<{ id: number; name: string; slug: string; stakeholder: string | null }>;
}

// ─── SymbolShowDataGatherer ───────────────────────────────────────────────────

/**
 * Pure data-gathering class for the `symbols show` command.
 * Separates data collection from rendering concerns.
 */
export class SymbolShowDataGatherer {
  /**
   * Gather all data for a single-symbol display.
   */
  async gatherSymbolData(db: IndexDatabase, definitionId: number, contextLines: number): Promise<SymbolShowData> {
    const defDetails = db.definitions.getById(definitionId);
    if (!defDetails) {
      throw new Error(`Definition with ID ${definitionId} not found`);
    }

    const sourceCode = await readSourceLines(
      db.resolveFilePath(defDetails.filePath),
      defDetails.line,
      defDetails.endLine
    );

    const callSites = await this.getCallSitesWithContext(db, definitionId, contextLines);
    const metadata = db.metadata.get(definitionId);
    const moduleResult = db.modules.getDefinitionModule(definitionId);
    const outgoingRelationships = db.relationships.getFrom(definitionId);
    const incomingRelationships = db.relationships.getTo(definitionId);
    const dependencies = db.dependencies.getForDefinition(definitionId);
    const dependents = db.dependencies.getIncoming(definitionId, 10);
    const dependentCount = db.dependencies.getIncomingCount(definitionId);
    const flows = db.flows.getFlowsWithDefinition(definitionId);

    const moduleId = moduleResult?.module.id;
    let incomingInteractions: InteractionWithPaths[] = [];
    let outgoingInteractions: InteractionWithPaths[] = [];
    if (moduleId) {
      const depNames = dependencies.map((d) => d.name);
      incomingInteractions = db.interactions.getIncomingForSymbols(moduleId, [defDetails.name]);
      outgoingInteractions = db.interactions.getOutgoingForSymbols(moduleId, depNames);
    }

    return {
      id: defDetails.id,
      name: defDetails.name,
      kind: defDetails.kind,
      filePath: defDetails.filePath,
      line: defDetails.line,
      endLine: defDetails.endLine,
      isExported: defDetails.isExported,
      metadata,
      module: moduleResult
        ? { id: moduleResult.module.id, name: moduleResult.module.name, fullPath: moduleResult.module.fullPath }
        : null,
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
  }

  /**
   * Gather all data for file-level aggregation display.
   */
  async gatherFileData(db: IndexDatabase, filePath: string): Promise<FileShowData | null> {
    const fileId = resolveFileId(db, filePath);
    if (!fileId) return null;

    const relativePath = db.toRelativePath(filePath) || filePath;
    const fileDefs = db.definitions.getForFile(fileId);
    if (fileDefs.length === 0) return null;

    // Collect unique modules
    const moduleMap = new Map<number, { name: string; fullPath: string }>();
    for (const def of fileDefs) {
      const modResult = db.modules.getDefinitionModule(def.id);
      if (modResult && !moduleMap.has(modResult.module.id)) {
        moduleMap.set(modResult.module.id, {
          name: modResult.module.name,
          fullPath: modResult.module.fullPath,
        });
      }
    }

    // Aggregate relationships (deduplicated)
    const outRelMap = new Map<
      string,
      {
        toDefinitionId: number;
        toName: string;
        toKind: string;
        relationshipType: string;
        semantic: string;
        toFilePath: string;
        toLine: number;
      }
    >();
    const inRelMap = new Map<
      string,
      {
        fromDefinitionId: number;
        fromName: string;
        fromKind: string;
        relationshipType: string;
        semantic: string;
        fromFilePath: string;
        fromLine: number;
      }
    >();

    for (const def of fileDefs) {
      for (const r of db.relationships.getFrom(def.id)) {
        const key = `${def.id}-${r.toDefinitionId}-${r.relationshipType}`;
        if (!outRelMap.has(key)) {
          outRelMap.set(key, {
            toDefinitionId: r.toDefinitionId,
            toName: r.toName,
            toKind: r.toKind,
            relationshipType: r.relationshipType,
            semantic: r.semantic,
            toFilePath: r.toFilePath,
            toLine: r.toLine,
          });
        }
      }
      for (const r of db.relationships.getTo(def.id)) {
        const key = `${r.fromDefinitionId}-${def.id}-${r.relationshipType}`;
        if (!inRelMap.has(key)) {
          inRelMap.set(key, {
            fromDefinitionId: r.fromDefinitionId,
            fromName: r.fromName,
            fromKind: r.fromKind,
            relationshipType: r.relationshipType,
            semantic: r.semantic,
            fromFilePath: r.fromFilePath,
            fromLine: r.fromLine,
          });
        }
      }
    }

    // Aggregate flows (deduplicated)
    const flowMap = new Map<number, { id: number; name: string; slug: string; stakeholder: string | null }>();
    for (const def of fileDefs) {
      for (const f of db.flows.getFlowsWithDefinition(def.id)) {
        if (!flowMap.has(f.id)) {
          flowMap.set(f.id, { id: f.id, name: f.name, slug: f.slug, stakeholder: f.stakeholder });
        }
      }
    }

    // Aggregate interactions
    const allSymbolNames = fileDefs.map((d) => d.name);
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

    return {
      file: relativePath,
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
        outgoing: [...outRelMap.values()],
        incoming: [...inRelMap.values()],
      },
      interactions: {
        incoming: [...inInteractionMap.values()],
        outgoing: [...outInteractionMap.values()],
      },
      flows: [...flowMap.values()],
    };
  }

  /**
   * Fetch call sites for a definition and enrich them with source context.
   */
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
      const fileLines = await readAllLines(db.resolveFilePath(filePath));

      if (fileLines.length === 0) {
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

      const fileId = db.files.getIdByPath(filePath);
      const fileDefs = fileId ? db.definitions.getForFile(fileId) : [];

      for (const cs of fileCallsites) {
        const containingDef = fileDefs
          .filter((def) => def.line <= cs.line && cs.line <= def.endLine)
          .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];

        const containingFunction = containingDef?.name ?? null;

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
}
