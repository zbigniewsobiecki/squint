import type Database from 'better-sqlite3';
import { ensureInteractionsTables, ensureModulesTables } from '../schema-manager.js';
import type { CallGraphEdge, Interaction, InteractionSource, InteractionWithPaths } from '../schema.js';
import { queryCallGraphEdges } from './_shared/call-graph-query.js';

export interface InteractionInsertOptions {
  direction?: 'uni' | 'bi';
  weight?: number;
  pattern?: 'utility' | 'business' | 'test-internal';
  symbols?: string[];
  semantic?: string;
  source?: InteractionSource;
  confidence?: 'high' | 'medium';
}

export interface InteractionUpdateOptions {
  direction?: 'uni' | 'bi';
  pattern?: 'utility' | 'business' | 'test-internal';
  symbols?: string[];
  semantic?: string;
}

export interface InteractionStats {
  totalCount: number;
  businessCount: number;
  utilityCount: number;
  biDirectionalCount: number;
}

const INTERACTION_COLS = `
  id,
  from_module_id as fromModuleId,
  to_module_id as toModuleId,
  direction,
  weight,
  pattern,
  symbols,
  semantic,
  source,
  confidence,
  created_at as createdAt`;

const INTERACTION_WITH_PATHS_SELECT = `
  SELECT
    i.id,
    i.from_module_id as fromModuleId,
    i.to_module_id as toModuleId,
    i.direction,
    i.weight,
    i.pattern,
    i.symbols,
    i.semantic,
    i.source,
    i.confidence,
    i.created_at as createdAt,
    from_m.full_path as fromModulePath,
    to_m.full_path as toModulePath
  FROM interactions i
  JOIN modules from_m ON i.from_module_id = from_m.id
  JOIN modules to_m ON i.to_module_id = to_m.id`;

function parseSymbols(row: Interaction): Interaction {
  if (row.symbols) {
    row.symbols = JSON.parse(row.symbols as unknown as string);
  }
  return row;
}

/**
 * Repository for interaction (module-to-module edge) operations.
 */
export class InteractionRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert a new interaction.
   * Throws if an interaction between these modules already exists.
   */
  insert(fromModuleId: number, toModuleId: number, options?: InteractionInsertOptions): number {
    ensureInteractionsTables(this.db);

    const stmt = this.db.prepare(`
      INSERT INTO interactions (from_module_id, to_module_id, direction, weight, pattern, symbols, semantic, source, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      fromModuleId,
      toModuleId,
      options?.direction ?? 'uni',
      options?.weight ?? 1,
      options?.pattern ?? null,
      options?.symbols ? JSON.stringify(options.symbols) : null,
      options?.semantic ?? null,
      options?.source ?? 'ast',
      options?.confidence ?? null
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Upsert an interaction (insert or update on conflict).
   */
  upsert(fromModuleId: number, toModuleId: number, options?: InteractionInsertOptions): number {
    ensureInteractionsTables(this.db);

    const existing = this.getByModules(fromModuleId, toModuleId);
    if (existing) {
      this.update(existing.id, {
        direction: options?.direction,
        pattern: options?.pattern,
        symbols: options?.symbols,
        semantic: options?.semantic,
      });
      // Update weight separately if provided
      if (options?.weight !== undefined) {
        this.db.prepare('UPDATE interactions SET weight = ? WHERE id = ?').run(options.weight, existing.id);
      }
      // Update confidence if provided
      if (options?.confidence !== undefined) {
        this.db.prepare('UPDATE interactions SET confidence = ? WHERE id = ?').run(options.confidence, existing.id);
      }
      return existing.id;
    }

    return this.insert(fromModuleId, toModuleId, options);
  }

  /**
   * Get interaction by ID.
   */
  getById(id: number): Interaction | null {
    ensureInteractionsTables(this.db);
    const stmt = this.db.prepare(`SELECT ${INTERACTION_COLS} FROM interactions WHERE id = ?`);
    const row = stmt.get(id) as Interaction | undefined;
    if (!row) return null;
    return parseSymbols(row);
  }

  /**
   * Get interaction by module pair.
   */
  getByModules(fromModuleId: number, toModuleId: number): Interaction | null {
    ensureInteractionsTables(this.db);
    const stmt = this.db.prepare(
      `SELECT ${INTERACTION_COLS} FROM interactions WHERE from_module_id = ? AND to_module_id = ?`
    );
    const row = stmt.get(fromModuleId, toModuleId) as Interaction | undefined;
    if (!row) return null;
    return parseSymbols(row);
  }

  /**
   * Get all interactions with module paths.
   */
  getAll(): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);
    return this.db.prepare(`${INTERACTION_WITH_PATHS_SELECT} ORDER BY i.weight DESC`).all() as InteractionWithPaths[];
  }

  /**
   * Get interactions by pattern.
   */
  getByPattern(pattern: 'utility' | 'business'): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);
    return this.db
      .prepare(`${INTERACTION_WITH_PATHS_SELECT} WHERE i.pattern = ? ORDER BY i.weight DESC`)
      .all(pattern) as InteractionWithPaths[];
  }

  /**
   * Get interactions from a specific module.
   */
  getFromModule(moduleId: number): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);
    return this.db
      .prepare(`${INTERACTION_WITH_PATHS_SELECT} WHERE i.from_module_id = ? ORDER BY i.weight DESC`)
      .all(moduleId) as InteractionWithPaths[];
  }

  /**
   * Get interactions to a specific module.
   */
  getToModule(moduleId: number): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);
    return this.db
      .prepare(`${INTERACTION_WITH_PATHS_SELECT} WHERE i.to_module_id = ? ORDER BY i.weight DESC`)
      .all(moduleId) as InteractionWithPaths[];
  }

  /**
   * Update an interaction.
   */
  update(id: number, updates: InteractionUpdateOptions): boolean {
    ensureInteractionsTables(this.db);

    const sets: string[] = [];
    const params: (string | null)[] = [];

    if (updates.direction !== undefined) {
      sets.push('direction = ?');
      params.push(updates.direction);
    }
    if (updates.pattern !== undefined) {
      sets.push('pattern = ?');
      params.push(updates.pattern);
    }
    if (updates.symbols !== undefined) {
      sets.push('symbols = ?');
      params.push(JSON.stringify(updates.symbols));
    }
    if (updates.semantic !== undefined) {
      sets.push('semantic = ?');
      params.push(updates.semantic);
    }

    if (sets.length === 0) return false;

    params.push(String(id));
    const stmt = this.db.prepare(`UPDATE interactions SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Delete an interaction.
   */
  delete(id: number): boolean {
    ensureInteractionsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM interactions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all interactions.
   */
  clear(): number {
    ensureInteractionsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM interactions');
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Get count of interactions.
   */
  getCount(): number {
    ensureInteractionsTables(this.db);
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM interactions');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get interaction statistics.
   */
  getStats(): InteractionStats {
    ensureInteractionsTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as totalCount,
        SUM(CASE WHEN pattern = 'business' THEN 1 ELSE 0 END) as businessCount,
        SUM(CASE WHEN pattern = 'utility' THEN 1 ELSE 0 END) as utilityCount,
        SUM(CASE WHEN direction = 'bi' THEN 1 ELSE 0 END) as biDirectionalCount
      FROM interactions
    `);
    return stmt.get() as InteractionStats;
  }

  /**
   * Get interactions by source type.
   */
  getBySource(source: InteractionSource): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);
    return this.db
      .prepare(`${INTERACTION_WITH_PATHS_SELECT} WHERE i.source = ? ORDER BY i.weight DESC`)
      .all(source) as InteractionWithPaths[];
  }

  /**
   * Get count of interactions by source type.
   */
  getCountBySource(source: InteractionSource): number {
    ensureInteractionsTables(this.db);
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM interactions WHERE source = ?');
    const row = stmt.get(source) as { count: number };
    return row.count;
  }

  /**
   * Remove all llm-inferred interactions targeting a specific module.
   * Used by fan-in anomaly detection to bulk-remove hallucinated connections.
   */
  removeInferredToModule(targetModuleId: number): number {
    ensureInteractionsTables(this.db);
    const stmt = this.db.prepare("DELETE FROM interactions WHERE to_module_id = ? AND source = 'llm-inferred'");
    const result = stmt.run(targetModuleId);
    return result.changes;
  }

  // ============================================================
  // Definition-Level Call Graph (for flow tracing)
  // ============================================================

  /**
   * Get the definition-level call graph (not aggregated to modules).
   * Returns edges from caller definition to called definition.
   */
  getDefinitionCallGraph(): CallGraphEdge[] {
    return this.getCallGraphInternal();
  }

  /**
   * Get the definition-level call graph as a Map for efficient lookups.
   * Maps from_definition_id to array of to_definition_ids.
   */
  getDefinitionCallGraphMap(): Map<number, number[]> {
    const edges = this.getCallGraphInternal();
    const result = new Map<number, number[]>();

    for (const edge of edges) {
      const existing = result.get(edge.fromId) ?? [];
      existing.push(edge.toId);
      result.set(edge.fromId, existing);
    }

    return result;
  }

  // ============================================================
  // Process Group Detection Methods
  // ============================================================

  /**
   * Get all non-type-only, internal file import edges.
   * Used to build the import graph for process group detection.
   */
  getRuntimeImportEdges(): Array<{ fromFileId: number; toFileId: number }> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT from_file_id as fromFileId, to_file_id as toFileId
      FROM imports
      WHERE to_file_id IS NOT NULL AND is_type_only = 0
    `);

    return stmt.all() as Array<{ fromFileId: number; toFileId: number }>;
  }

  /**
   * Get file-to-module mapping via module_members → definitions → files.
   * Returns a Map from fileId to moduleId.
   */
  getFileToModuleMap(): Map<number, number> {
    ensureModulesTables(this.db);

    const rows = this.db
      .prepare(`
        SELECT DISTINCT d.file_id, mm.module_id
        FROM module_members mm
        JOIN definitions d ON mm.definition_id = d.id
      `)
      .all() as Array<{ file_id: number; module_id: number }>;

    const result = new Map<number, number>();
    for (const row of rows) {
      result.set(row.file_id, row.module_id);
    }
    return result;
  }

  // ============================================================
  // Import-Based Module Pair Detection
  // ============================================================

  /**
   * Get module pairs connected by imports but with no existing interaction.
   * Fills the gap between call-graph detection (calls only) and the full import graph.
   */
  getImportOnlyModulePairs(): Array<{
    fromModuleId: number;
    toModuleId: number;
    symbols: string[];
    weight: number;
    isTypeOnly: boolean;
  }> {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        from_mm.module_id as fromModuleId,
        to_mm.module_id as toModuleId,
        GROUP_CONCAT(DISTINCT to_d.name) as symbolNames,
        COUNT(DISTINCT s.id) as weight,
        MIN(i.is_type_only) as isTypeOnly
      FROM module_members from_mm
      JOIN definitions from_d ON from_mm.definition_id = from_d.id
      JOIN imports i ON i.from_file_id = from_d.file_id
      JOIN symbols s ON s.reference_id = i.id AND s.definition_id IS NOT NULL
      JOIN definitions to_d ON s.definition_id = to_d.id
      JOIN module_members to_mm ON to_mm.definition_id = to_d.id
      WHERE from_mm.module_id != to_mm.module_id
        AND NOT EXISTS (
          SELECT 1 FROM interactions
          WHERE from_module_id = from_mm.module_id
            AND to_module_id = to_mm.module_id
        )
      GROUP BY from_mm.module_id, to_mm.module_id
    `);

    return (stmt.all() as any[]).map((row) => ({
      fromModuleId: row.fromModuleId,
      toModuleId: row.toModuleId,
      symbols: row.symbolNames ? row.symbolNames.split(',') : [],
      weight: row.weight,
      isTypeOnly: row.isTypeOnly === 1,
    }));
  }

  // ============================================================
  // Import Path & Validation Methods
  // ============================================================

  /**
   * Check if any file in fromModule imports from any file in toModule.
   * Join: module_members → definitions → files → imports → files → definitions → module_members
   */
  hasModuleImportPath(fromModuleId: number, toModuleId: number): boolean {
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT EXISTS (
        SELECT 1
        FROM module_members from_mm
        JOIN definitions from_d ON from_mm.definition_id = from_d.id
        JOIN files from_f ON from_d.file_id = from_f.id
        JOIN imports i ON i.from_file_id = from_f.id
        JOIN files to_f ON i.to_file_id = to_f.id
        JOIN definitions to_d ON to_d.file_id = to_f.id
        JOIN module_members to_mm ON to_mm.definition_id = to_d.id
        WHERE from_mm.module_id = ? AND to_mm.module_id = ?
      ) as has_path
    `);

    const row = stmt.get(fromModuleId, toModuleId) as { has_path: number };
    return row.has_path === 1;
  }

  /**
   * Get actual symbols that fromModule imports from toModule.
   * Returns symbol names and kinds for enriching prompts and deriving `symbols` field.
   */
  getModuleImportedSymbols(fromModuleId: number, toModuleId: number): Array<{ name: string; kind: string }> {
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT DISTINCT to_d.name, to_d.kind
      FROM module_members from_mm
      JOIN definitions from_d ON from_mm.definition_id = from_d.id
      JOIN files from_f ON from_d.file_id = from_f.id
      JOIN imports imp ON imp.from_file_id = from_f.id
      JOIN symbols s ON s.reference_id = imp.id AND s.definition_id IS NOT NULL
      JOIN definitions to_d ON s.definition_id = to_d.id
      JOIN module_members to_mm ON to_mm.definition_id = to_d.id
      WHERE from_mm.module_id = ? AND to_mm.module_id = ?
      ORDER BY to_d.name
    `);

    return stmt.all(fromModuleId, toModuleId) as Array<{ name: string; kind: string }>;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private getCallGraphInternal(): CallGraphEdge[] {
    return queryCallGraphEdges(this.db, { includeJsx: true });
  }
}
