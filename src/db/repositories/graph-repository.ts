import type Database from 'better-sqlite3';
import { ensureRelationshipTypeColumn } from '../schema-manager.js';
import type { AnnotatedEdgeInfo, AnnotatedSymbolInfo, CallGraphEdge } from '../schema.js';
import { queryCallGraphEdges } from './_shared/call-graph-query.js';
import { DefinitionRepository } from './definition-repository.js';
import { DependencyRepository } from './dependency-repository.js';
import { MetadataRepository } from './metadata-repository.js';
import { RelationshipRepository } from './relationship-repository.js';

export interface HighConnectivitySymbol {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  incomingDeps: number;
  outgoingDeps: number;
}

export interface NeighborhoodResult {
  nodes: AnnotatedSymbolInfo[];
  edges: AnnotatedEdgeInfo[];
}

export interface UnannotatedSymbol {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  dependencyCount: number;
}

export interface UnannotatedSymbolsResult {
  symbols: UnannotatedSymbol[];
  total: number;
}

/**
 * Repository for graph analysis operations.
 */
export class GraphRepository {
  private deps: DependencyRepository;
  private metadata: MetadataRepository;
  private relationships: RelationshipRepository;
  private definitions: DefinitionRepository;

  constructor(private db: Database.Database) {
    this.deps = new DependencyRepository(db);
    this.metadata = new MetadataRepository(db);
    this.relationships = new RelationshipRepository(db);
    this.definitions = new DefinitionRepository(db);
  }

  /**
   * Find strongly connected components (cycles) among unannotated symbols.
   * Uses Tarjan's algorithm to detect groups of mutually dependent symbols.
   */
  findCycles(aspect: string): number[][] {
    const { symbols: unannotated } = this.getAllUnannotated(aspect, { limit: 100000 });
    const ids = new Set(unannotated.map((s) => s.id));

    if (ids.size === 0) return [];

    // Build adjacency list (only edges between unannotated symbols)
    const adj = new Map<number, number[]>();
    for (const sym of unannotated) {
      const deps = this.deps.getUnmet(sym.id, aspect);
      adj.set(
        sym.id,
        deps.map((d) => d.dependencyId).filter((id) => ids.has(id))
      );
    }

    // Tarjan's algorithm state
    let index = 0;
    const stack: number[] = [];
    const onStack = new Set<number>();
    const indices = new Map<number, number>();
    const lowlinks = new Map<number, number>();
    const sccs: number[][] = [];

    const strongconnect = (v: number): void => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of adj.get(v) ?? []) {
        if (!indices.has(w)) {
          strongconnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const scc: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        // Only return actual cycles (size > 1)
        if (scc.length > 1) sccs.push(scc);
      }
    };

    for (const v of ids) {
      if (!indices.has(v)) strongconnect(v);
    }

    return sccs;
  }

  /**
   * Get call graph neighborhood for a starting definition.
   */
  getNeighborhood(startId: number, maxDepth: number, maxNodes: number): NeighborhoodResult {
    // BFS to collect nodes
    const visited = new Set<number>();
    const queue: Array<{ id: number; depth: number }> = [{ id: startId, depth: 0 }];
    const nodeIds: number[] = [];

    // Get all edges for the neighborhood
    const allEdges = this.getCallGraph();
    const adjacency = new Map<number, Array<{ toId: number; weight: number }>>();
    const reverseAdjacency = new Map<number, Array<{ fromId: number; weight: number }>>();

    for (const edge of allEdges) {
      if (!adjacency.has(edge.fromId)) adjacency.set(edge.fromId, []);
      adjacency.get(edge.fromId)!.push({ toId: edge.toId, weight: edge.weight });

      if (!reverseAdjacency.has(edge.toId)) reverseAdjacency.set(edge.toId, []);
      reverseAdjacency.get(edge.toId)!.push({ fromId: edge.fromId, weight: edge.weight });
    }

    // BFS in both directions
    while (queue.length > 0 && nodeIds.length < maxNodes) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id)) continue;
      if (depth > maxDepth) continue;

      visited.add(id);
      nodeIds.push(id);

      if (depth < maxDepth) {
        // Forward edges
        for (const neighbor of adjacency.get(id) ?? []) {
          if (!visited.has(neighbor.toId)) {
            queue.push({ id: neighbor.toId, depth: depth + 1 });
          }
        }
        // Backward edges (incoming)
        for (const neighbor of reverseAdjacency.get(id) ?? []) {
          if (!visited.has(neighbor.fromId)) {
            queue.push({ id: neighbor.fromId, depth: depth + 1 });
          }
        }
      }
    }

    // Get annotated node info
    const nodes: AnnotatedSymbolInfo[] = [];
    for (const id of nodeIds) {
      const def = this.definitions.getById(id);
      if (!def) continue;

      const meta = this.metadata.get(id);
      let domains: string[] | null = null;
      if (meta.domain) {
        try {
          domains = JSON.parse(meta.domain);
        } catch {
          /* ignore */
        }
      }

      nodes.push({
        id,
        name: def.name,
        kind: def.kind,
        filePath: def.filePath,
        line: def.line,
        endLine: def.endLine,
        isExported: def.isExported,
        purpose: meta.purpose ?? null,
        domain: domains,
        role: meta.role ?? null,
        extendsName: def.extendsName ?? null,
        extendedByCount: 0,
      });
    }

    // Get edges between neighborhood nodes
    const nodeIdSet = new Set(nodeIds);
    const edges: AnnotatedEdgeInfo[] = [];

    for (const edge of allEdges) {
      if (nodeIdSet.has(edge.fromId) && nodeIdSet.has(edge.toId)) {
        const relationship = this.relationships.get(edge.fromId, edge.toId);
        edges.push({
          fromId: edge.fromId,
          toId: edge.toId,
          weight: edge.weight,
          semantic: relationship?.semantic ?? null,
        });
      }
    }

    return { nodes, edges };
  }

  /**
   * Get high-connectivity symbols (many incoming/outgoing deps).
   */
  getHighConnectivitySymbols(
    options: {
      minIncoming?: number;
      minOutgoing?: number;
      exported?: boolean;
      limit?: number;
    } = {}
  ): HighConnectivitySymbol[] {
    const minIncoming = options.minIncoming ?? 0;
    const minOutgoing = options.minOutgoing ?? 0;
    const limit = options.limit ?? 100;

    const edges = this.getCallGraph();

    const incomingCount = new Map<number, number>();
    const outgoingCount = new Map<number, number>();

    for (const edge of edges) {
      incomingCount.set(edge.toId, (incomingCount.get(edge.toId) ?? 0) + 1);
      outgoingCount.set(edge.fromId, (outgoingCount.get(edge.fromId) ?? 0) + 1);
    }

    const allIds = new Set<number>();
    for (const edge of edges) {
      allIds.add(edge.fromId);
      allIds.add(edge.toId);
    }

    const results: HighConnectivitySymbol[] = [];

    for (const id of allIds) {
      const incoming = incomingCount.get(id) ?? 0;
      const outgoing = outgoingCount.get(id) ?? 0;

      if (incoming >= minIncoming || outgoing >= minOutgoing) {
        const def = this.definitions.getById(id);
        if (!def) continue;

        if (options.exported !== undefined && def.isExported !== options.exported) {
          continue;
        }

        results.push({
          id,
          name: def.name,
          kind: def.kind,
          filePath: def.filePath,
          incomingDeps: incoming,
          outgoingDeps: outgoing,
        });
      }
    }

    results.sort((a, b) => b.incomingDeps + b.outgoingDeps - (a.incomingDeps + a.outgoingDeps));
    return results.slice(0, limit);
  }

  /**
   * Check if an edge exists between two definitions in the call graph.
   */
  edgeExists(fromId: number, toId: number): boolean {
    const edges = this.getCallGraph();
    return edges.some((e) => e.fromId === fromId && e.toId === toId);
  }

  /**
   * Resolve which definition ID a given target name refers to,
   * using import paths to disambiguate when multiple definitions share the same name.
   */
  private resolveInheritanceTarget(defId: number, targetName: string, nameToIds: Map<string, number[]>): number | null {
    const candidateIds = nameToIds.get(targetName);
    if (!candidateIds || candidateIds.length === 0) return null;
    if (candidateIds.length === 1) return candidateIds[0];

    // Get the file_id of the source definition
    const defRow = this.db.prepare('SELECT file_id FROM definitions WHERE id = ?').get(defId) as
      | { file_id: number }
      | undefined;
    if (!defRow) return candidateIds[0];

    // Get all file_ids reachable via imports from the source file
    const importRows = this.db
      .prepare('SELECT to_file_id FROM imports WHERE from_file_id = ? AND to_file_id IS NOT NULL')
      .all(defRow.file_id) as Array<{ to_file_id: number }>;
    const reachableFileIds = new Set<number>(importRows.map((r) => r.to_file_id));
    reachableFileIds.add(defRow.file_id); // same-file reference

    // Get file_ids for each candidate
    const candidateFileIds = new Map<number, number>();
    for (const cId of candidateIds) {
      const cRow = this.db.prepare('SELECT file_id FROM definitions WHERE id = ?').get(cId) as
        | { file_id: number }
        | undefined;
      if (cRow) candidateFileIds.set(cId, cRow.file_id);
    }

    // Filter candidates to those whose file_id is reachable
    const filtered = candidateIds.filter((cId) => {
      const fid = candidateFileIds.get(cId);
      return fid !== undefined && reachableFileIds.has(fid);
    });

    if (filtered.length === 1) return filtered[0];
    if (filtered.length > 1) return filtered[0]; // still ambiguous, pick first
    return candidateIds[0]; // no import match, fall back to first
  }

  /**
   * Create relationship annotations for inheritance edges.
   */
  createInheritanceRelationships(): { created: number } {
    ensureRelationshipTypeColumn(this.db);

    // Get all definitions with extends_name, implements_names, or extends_interfaces
    const stmt = this.db.prepare(`
      SELECT
        d.id,
        d.name,
        d.extends_name as extendsName,
        d.implements_names as implementsNames,
        d.extends_interfaces as extendsInterfaces
      FROM definitions d
      WHERE d.extends_name IS NOT NULL
        OR d.implements_names IS NOT NULL
        OR d.extends_interfaces IS NOT NULL
    `);
    const rows = stmt.all() as Array<{
      id: number;
      name: string;
      extendsName: string | null;
      implementsNames: string | null;
      extendsInterfaces: string | null;
    }>;

    // Build a map of name -> definition ids
    const nameToIds = new Map<string, number[]>();
    const allDefs = this.db.prepare('SELECT id, name FROM definitions').all() as Array<{
      id: number;
      name: string;
    }>;
    for (const d of allDefs) {
      if (!nameToIds.has(d.name)) {
        nameToIds.set(d.name, []);
      }
      nameToIds.get(d.name)!.push(d.id);
    }

    let created = 0;

    for (const row of rows) {
      // Handle extends — resolve to single target using imports
      if (row.extendsName) {
        const parentId = this.resolveInheritanceTarget(row.id, row.extendsName, nameToIds);
        if (parentId !== null) {
          const existing = this.relationships.get(row.id, parentId);
          if (!existing) {
            this.relationships.set(row.id, parentId, 'PENDING_LLM_ANNOTATION', 'extends');
            created++;
          }
        }
      }

      // Handle implements — resolve each interface to single target
      if (row.implementsNames) {
        try {
          const interfaces = JSON.parse(row.implementsNames) as string[];
          for (const iface of interfaces) {
            const ifaceId = this.resolveInheritanceTarget(row.id, iface, nameToIds);
            if (ifaceId !== null) {
              const existing = this.relationships.get(row.id, ifaceId);
              if (!existing) {
                this.relationships.set(row.id, ifaceId, 'PENDING_LLM_ANNOTATION', 'implements');
                created++;
              }
            }
          }
        } catch {
          /* ignore */
        }
      }

      // Handle extends_interfaces — resolve each interface to single target (extends relationship)
      if (row.extendsInterfaces) {
        try {
          const interfaces = JSON.parse(row.extendsInterfaces) as string[];
          for (const iface of interfaces) {
            const ifaceId = this.resolveInheritanceTarget(row.id, iface, nameToIds);
            if (ifaceId !== null) {
              const existing = this.relationships.get(row.id, ifaceId);
              if (!existing) {
                this.relationships.set(row.id, ifaceId, 'PENDING_LLM_ANNOTATION', 'extends');
                created++;
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    return { created };
  }

  /**
   * Get the next unannotated symbols for an aspect.
   */
  getNextToAnnotate(
    aspect: string,
    options?: { limit?: number; kind?: string; filePattern?: string }
  ): { symbols: UnannotatedSymbol[]; total: number } {
    const result = this.deps.getReadySymbols(aspect, options);
    return {
      symbols: result.symbols,
      total: result.totalReady + result.remaining,
    };
  }

  /**
   * Get all unannotated symbols for an aspect.
   */
  getAllUnannotated(
    aspect: string,
    options?: { limit?: number; kind?: string; filePattern?: string; excludePattern?: string }
  ): UnannotatedSymbolsResult {
    const limit = options?.limit ?? 100;

    // Build filter conditions
    let filterConditions = '';
    const filterParams: (string | number)[] = [];

    if (options?.kind) {
      filterConditions += ' AND d.kind = ?';
      filterParams.push(options.kind);
    }
    if (options?.filePattern) {
      filterConditions += ' AND f.path LIKE ?';
      filterParams.push(`%${options.filePattern}%`);
    }
    if (options?.excludePattern) {
      filterConditions += ' AND f.path NOT LIKE ?';
      filterParams.push(`%${options.excludePattern}%`);
    }

    // Query for all unannotated symbols (no aspect metadata set)
    const sql = `
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        d.end_line as endLine,
        0 as dependencyCount
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.id NOT IN (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      )
      ${filterConditions}
      ORDER BY f.path, d.line
      LIMIT ?
    `;

    const params: (string | number)[] = [aspect, ...filterParams, limit];
    const stmt = this.db.prepare(sql);
    const symbols = stmt.all(...params) as UnannotatedSymbol[];

    // Get total count
    const countSql = `
      SELECT COUNT(*) as count
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.id NOT IN (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      )
      ${filterConditions}
    `;
    const countParams: (string | number)[] = [aspect, ...filterParams];
    const countStmt = this.db.prepare(countSql);
    const countResult = countStmt.get(...countParams) as { count: number };

    return {
      symbols,
      total: countResult.count,
    };
  }

  // Private helper to get call graph
  private getCallGraph(): CallGraphEdge[] {
    return queryCallGraphEdges(this.db);
  }
}
