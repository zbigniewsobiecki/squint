import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Definition } from '../parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../parser/reference-extractor.js';
import { type CallsiteResult, type FileInsert, type IIndexWriter, SCHEMA } from './schema.js';

import { CallGraphService } from './repositories/call-graph-service.js';
import { DefinitionRepository } from './repositories/definition-repository.js';
import { DependencyRepository } from './repositories/dependency-repository.js';
import { DomainRepository } from './repositories/domain-repository.js';
import { FeatureRepository } from './repositories/feature-repository.js';
import { FileRepository } from './repositories/file-repository.js';
import { FlowRepository } from './repositories/flow-repository.js';
import { GraphRepository } from './repositories/graph-repository.js';
import { InteractionAnalysis } from './repositories/interaction-analysis.js';
import { InteractionRepository } from './repositories/interaction-repository.js';
import { MetadataRepository } from './repositories/metadata-repository.js';
import { ModuleRepository } from './repositories/module-repository.js';
import { RelationshipRepository } from './repositories/relationship-repository.js';

/**
 * Database access layer that owns the connection and exposes repositories.
 * Implements IIndexWriter for the parse/indexing pipeline.
 */
export class IndexDatabase implements IIndexWriter {
  private conn: Database.Database;

  // Repositories
  public readonly files: FileRepository;
  public readonly definitions: DefinitionRepository;
  public readonly metadata: MetadataRepository;
  public readonly dependencies: DependencyRepository;
  public readonly relationships: RelationshipRepository;
  public readonly domains: DomainRepository;
  public readonly modules: ModuleRepository;
  public readonly interactions: InteractionRepository;
  public readonly features: FeatureRepository;
  public readonly flows: FlowRepository;
  public readonly graph: GraphRepository;
  public readonly callGraph: CallGraphService;
  public readonly interactionAnalysis: InteractionAnalysis;

  constructor(dbPath: string) {
    this.conn = new Database(dbPath);
    this.conn.pragma('journal_mode = WAL');

    // Initialize all repositories
    this.files = new FileRepository(this.conn);
    this.definitions = new DefinitionRepository(this.conn);
    this.metadata = new MetadataRepository(this.conn);
    this.dependencies = new DependencyRepository(this.conn);
    this.relationships = new RelationshipRepository(this.conn);
    this.domains = new DomainRepository(this.conn);
    this.modules = new ModuleRepository(this.conn);
    this.interactions = new InteractionRepository(this.conn);
    this.features = new FeatureRepository(this.conn);
    this.flows = new FlowRepository(this.conn);
    this.graph = new GraphRepository(this.conn);
    this.callGraph = new CallGraphService(this.conn);
    this.interactionAnalysis = new InteractionAnalysis(this.conn);
  }

  // ============================================================
  // Schema & Lifecycle
  // ============================================================

  initialize(): void {
    this.conn.exec(`
      DROP TABLE IF EXISTS flows;
      DROP TABLE IF EXISTS module_members;
      DROP TABLE IF EXISTS modules;
      DROP TABLE IF EXISTS domains;
      DROP TABLE IF EXISTS relationship_annotations;
      DROP TABLE IF EXISTS definition_metadata;
      DROP TABLE IF EXISTS usages;
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS imports;
      DROP TABLE IF EXISTS definitions;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS metadata;
    `);
    this.conn.exec(SCHEMA);
  }

  close(): void {
    this.conn.close();
  }

  // ============================================================
  // IIndexWriter Implementation
  // ============================================================

  setMetadata(key: string, value: string): void {
    const stmt = this.conn.prepare(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)
    `);
    stmt.run(key, value);
  }

  insertFile(file: FileInsert): number {
    return this.files.insert(file);
  }

  insertDefinition(fileId: number, def: Definition): number {
    return this.files.insertDefinition(fileId, def);
  }

  insertReference(fromFileId: number, toFileId: number | null, ref: FileReference): number {
    return this.files.insertReference(fromFileId, toFileId, ref);
  }

  insertSymbol(refId: number | null, defId: number | null, sym: ImportedSymbol, fileId?: number): number {
    return this.files.insertSymbol(refId, defId, sym, fileId);
  }

  insertUsage(symbolId: number, usage: SymbolUsage): void {
    this.files.insertUsage(symbolId, usage);
  }

  getDefinitionByName(fileId: number, name: string): number | null {
    return this.definitions.getByName(fileId, name);
  }

  getDefinitionCount(): number {
    return this.definitions.getCount();
  }

  getReferenceCount(): number {
    return this.files.getReferenceCount();
  }

  getUsageCount(): number {
    return this.files.getUsageCount();
  }

  getCallsites(definitionId: number): CallsiteResult[] {
    return this.dependencies.getCallsites(definitionId);
  }

  getCallsitesForFile(fileId: number): CallsiteResult[] {
    return this.dependencies.getCallsitesForFile(fileId);
  }

  getCallsiteCount(): number {
    return this.dependencies.getCallsiteCount();
  }

  // ============================================================
  // Composite Methods
  // ============================================================

  /**
   * Get overall database stats (cross-repo aggregation)
   */
  getStats() {
    const files = this.files.getCount();
    const definitions = this.definitions.getCount();
    const imports = this.files.getReferenceCount();
    const usages = this.files.getUsageCount();
    const callsites = this.dependencies.getCallsiteCount();
    const moduleStats = this.modules.getStats();
    const flowStats = this.flows.getStats();
    const relationships = this.relationships.getCount();

    const interactionCount = this.interactions.getCount();

    return {
      files,
      definitions,
      imports,
      usages,
      callsites,
      modules: moduleStats.moduleCount,
      assignedSymbols: moduleStats.assigned,
      unassignedSymbols: moduleStats.unassigned,
      flows: flowStats.flowCount,
      interactions: interactionCount,
      relationships,
    };
  }

  /**
   * Get exported definitions that are not called by anything (entry points)
   */
  getRootDefinitions(): Array<{ id: number; name: string; kind: string; filePath: string; line: number }> {
    const callGraph = this.modules.getCallGraph();
    const calledIds = new Set<number>();
    for (const edge of callGraph) {
      calledIds.add(edge.toId);
    }

    const allDefs = this.conn
      .prepare(`
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.is_exported = 1
      ORDER BY f.path, d.line
    `)
      .all() as Array<{ id: number; name: string; kind: string; filePath: string; line: number }>;

    return allDefs.filter((def) => !calledIds.has(def.id));
  }

  /**
   * Find ghost rows: rows referencing entities that no longer exist.
   * Each query is wrapped in try/catch since tables may not exist.
   */
  findGhostRows(): {
    ghostRelationships: Array<{ id: number; table: string }>;
    ghostMembers: Array<{ definitionId: number; table: string }>;
    ghostEntryPoints: Array<{ id: number; table: string }>;
    ghostEntryModules: Array<{ id: number; table: string }>;
    ghostInteractions: Array<{ id: number; table: string }>;
    ghostSubflows: Array<{ rowid: number; table: string }>;
  } {
    const result = {
      ghostRelationships: [] as Array<{ id: number; table: string }>,
      ghostMembers: [] as Array<{ definitionId: number; table: string }>,
      ghostEntryPoints: [] as Array<{ id: number; table: string }>,
      ghostEntryModules: [] as Array<{ id: number; table: string }>,
      ghostInteractions: [] as Array<{ id: number; table: string }>,
      ghostSubflows: [] as Array<{ rowid: number; table: string }>,
    };

    // ghost-relationship: relationship_annotations where definition_id NOT IN definitions
    try {
      const rows = this.conn
        .prepare(
          `SELECT ra.id FROM relationship_annotations ra
           LEFT JOIN definitions d1 ON ra.from_definition_id = d1.id
           LEFT JOIN definitions d2 ON ra.to_definition_id = d2.id
           WHERE d1.id IS NULL OR d2.id IS NULL`
        )
        .all() as Array<{ id: number }>;
      result.ghostRelationships = rows.map((r) => ({ id: r.id, table: 'relationship_annotations' }));
    } catch {
      // Table doesn't exist
    }

    // ghost-member: module_members where definition_id NOT IN definitions OR module_id NOT IN modules
    try {
      const rows = this.conn
        .prepare(
          `SELECT mm.definition_id as definitionId FROM module_members mm
           LEFT JOIN definitions d ON mm.definition_id = d.id
           LEFT JOIN modules m ON mm.module_id = m.id
           WHERE d.id IS NULL OR m.id IS NULL`
        )
        .all() as Array<{ definitionId: number }>;
      result.ghostMembers = rows.map((r) => ({ definitionId: r.definitionId, table: 'module_members' }));
    } catch {
      // Table doesn't exist
    }

    // ghost-entry-point: flows where entry_point_id IS NOT NULL AND NOT IN definitions
    try {
      const rows = this.conn
        .prepare(
          `SELECT f.id FROM flows f
           LEFT JOIN definitions d ON f.entry_point_id = d.id
           WHERE f.entry_point_id IS NOT NULL AND d.id IS NULL`
        )
        .all() as Array<{ id: number }>;
      result.ghostEntryPoints = rows.map((r) => ({ id: r.id, table: 'flows' }));
    } catch {
      // Table doesn't exist
    }

    // ghost-entry-module: flows where entry_point_module_id IS NOT NULL AND NOT IN modules
    try {
      const rows = this.conn
        .prepare(
          `SELECT f.id FROM flows f
           LEFT JOIN modules m ON f.entry_point_module_id = m.id
           WHERE f.entry_point_module_id IS NOT NULL AND m.id IS NULL`
        )
        .all() as Array<{ id: number }>;
      result.ghostEntryModules = rows.map((r) => ({ id: r.id, table: 'flows' }));
    } catch {
      // Table doesn't exist
    }

    // ghost-interaction: interactions where from_module_id or to_module_id NOT IN modules
    try {
      const rows = this.conn
        .prepare(
          `SELECT i.id FROM interactions i
           LEFT JOIN modules m1 ON i.from_module_id = m1.id
           LEFT JOIN modules m2 ON i.to_module_id = m2.id
           WHERE m1.id IS NULL OR m2.id IS NULL`
        )
        .all() as Array<{ id: number }>;
      result.ghostInteractions = rows.map((r) => ({ id: r.id, table: 'interactions' }));
    } catch {
      // Table doesn't exist
    }

    // ghost-subflow: flow_subflow_steps where subflow_id NOT IN flows
    try {
      const rows = this.conn
        .prepare(
          `SELECT fss.rowid FROM flow_subflow_steps fss
           LEFT JOIN flows f ON fss.subflow_id = f.id
           WHERE f.id IS NULL`
        )
        .all() as Array<{ rowid: number }>;
      result.ghostSubflows = rows.map((r) => ({ rowid: r.rowid, table: 'flow_subflow_steps' }));
    } catch {
      // Table doesn't exist
    }

    return result;
  }

  /**
   * Delete a ghost row by table and primary key.
   * Uses an allowlist of table names to prevent injection.
   */
  deleteGhostRow(table: string, id: number): boolean {
    const ALLOWED_TABLES: Record<string, string> = {
      relationship_annotations: 'DELETE FROM relationship_annotations WHERE id = ?',
      module_members: 'DELETE FROM module_members WHERE definition_id = ?',
      flows: 'UPDATE flows SET entry_point_id = NULL, entry_point_module_id = NULL WHERE id = ?',
      interactions: 'DELETE FROM interactions WHERE id = ?',
      flow_subflow_steps: 'DELETE FROM flow_subflow_steps WHERE rowid = ?',
    };

    const sql = ALLOWED_TABLES[table];
    if (!sql) return false;

    try {
      const result = this.conn.prepare(sql).run(id);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  /**
   * Remove stale file entries (files that no longer exist on disk).
   */
  cleanStaleFiles(): { removed: number; paths: string[] } {
    const allFiles = this.files.getAll();
    const stalePaths: string[] = [];

    for (const file of allFiles) {
      try {
        fs.accessSync(file.path);
      } catch {
        stalePaths.push(file.path);
      }
    }

    if (stalePaths.length === 0) return { removed: 0, paths: [] };

    const deleteDefinitions = this.conn.prepare('DELETE FROM definitions WHERE file_id = ?');
    const deleteFile = this.conn.prepare('DELETE FROM files WHERE id = ?');

    const cleanup = this.conn.transaction(() => {
      for (const path of stalePaths) {
        const fileId = this.files.getIdByPath(path);
        if (fileId !== null) {
          deleteDefinitions.run(fileId);
          deleteFile.run(fileId);
        }
      }
    });

    cleanup();
    return { removed: stalePaths.length, paths: stalePaths };
  }
}
