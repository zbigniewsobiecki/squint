import type Database from 'better-sqlite3';
import type {
  Interaction,
  InteractionWithPaths,
  ModuleCallEdge,
  EnrichedModuleCallEdge,
  CalledSymbolInfo,
  CallGraphEdge,
} from '../schema.js';
import { ensureInteractionsTables, ensureModulesTables } from '../schema-manager.js';

export interface InteractionInsertOptions {
  direction?: 'uni' | 'bi';
  weight?: number;
  pattern?: 'utility' | 'business';
  symbols?: string[];
  semantic?: string;
}

export interface InteractionUpdateOptions {
  direction?: 'uni' | 'bi';
  pattern?: 'utility' | 'business';
  symbols?: string[];
  semantic?: string;
}

export interface InteractionStats {
  totalCount: number;
  businessCount: number;
  utilityCount: number;
  biDirectionalCount: number;
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
  insert(
    fromModuleId: number,
    toModuleId: number,
    options?: InteractionInsertOptions
  ): number {
    ensureInteractionsTables(this.db);

    const stmt = this.db.prepare(`
      INSERT INTO interactions (from_module_id, to_module_id, direction, weight, pattern, symbols, semantic)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      fromModuleId,
      toModuleId,
      options?.direction ?? 'uni',
      options?.weight ?? 1,
      options?.pattern ?? null,
      options?.symbols ? JSON.stringify(options.symbols) : null,
      options?.semantic ?? null
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Upsert an interaction (insert or update on conflict).
   */
  upsert(
    fromModuleId: number,
    toModuleId: number,
    options?: InteractionInsertOptions
  ): number {
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
        this.db.prepare('UPDATE interactions SET weight = ? WHERE id = ?')
          .run(options.weight, existing.id);
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
    const stmt = this.db.prepare(`
      SELECT
        id,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        direction,
        weight,
        pattern,
        symbols,
        semantic,
        created_at as createdAt
      FROM interactions
      WHERE id = ?
    `);
    const row = stmt.get(id) as Interaction | undefined;
    if (!row) return null;
    // Parse symbols JSON
    if (row.symbols) {
      row.symbols = JSON.parse(row.symbols as unknown as string);
    }
    return row;
  }

  /**
   * Get interaction by module pair.
   */
  getByModules(fromModuleId: number, toModuleId: number): Interaction | null {
    ensureInteractionsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        direction,
        weight,
        pattern,
        symbols,
        semantic,
        created_at as createdAt
      FROM interactions
      WHERE from_module_id = ? AND to_module_id = ?
    `);
    const row = stmt.get(fromModuleId, toModuleId) as Interaction | undefined;
    if (!row) return null;
    if (row.symbols) {
      row.symbols = JSON.parse(row.symbols as unknown as string);
    }
    return row;
  }

  /**
   * Get all interactions with module paths.
   */
  getAll(): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        i.id,
        i.from_module_id as fromModuleId,
        i.to_module_id as toModuleId,
        i.direction,
        i.weight,
        i.pattern,
        i.symbols,
        i.semantic,
        i.created_at as createdAt,
        from_m.full_path as fromModulePath,
        to_m.full_path as toModulePath
      FROM interactions i
      JOIN modules from_m ON i.from_module_id = from_m.id
      JOIN modules to_m ON i.to_module_id = to_m.id
      ORDER BY i.weight DESC
    `);

    return stmt.all() as InteractionWithPaths[];
  }

  /**
   * Get interactions by pattern.
   */
  getByPattern(pattern: 'utility' | 'business'): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        i.id,
        i.from_module_id as fromModuleId,
        i.to_module_id as toModuleId,
        i.direction,
        i.weight,
        i.pattern,
        i.symbols,
        i.semantic,
        i.created_at as createdAt,
        from_m.full_path as fromModulePath,
        to_m.full_path as toModulePath
      FROM interactions i
      JOIN modules from_m ON i.from_module_id = from_m.id
      JOIN modules to_m ON i.to_module_id = to_m.id
      WHERE i.pattern = ?
      ORDER BY i.weight DESC
    `);

    return stmt.all(pattern) as InteractionWithPaths[];
  }

  /**
   * Get interactions from a specific module.
   */
  getFromModule(moduleId: number): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        i.id,
        i.from_module_id as fromModuleId,
        i.to_module_id as toModuleId,
        i.direction,
        i.weight,
        i.pattern,
        i.symbols,
        i.semantic,
        i.created_at as createdAt,
        from_m.full_path as fromModulePath,
        to_m.full_path as toModulePath
      FROM interactions i
      JOIN modules from_m ON i.from_module_id = from_m.id
      JOIN modules to_m ON i.to_module_id = to_m.id
      WHERE i.from_module_id = ?
      ORDER BY i.weight DESC
    `);

    return stmt.all(moduleId) as InteractionWithPaths[];
  }

  /**
   * Get interactions to a specific module.
   */
  getToModule(moduleId: number): InteractionWithPaths[] {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        i.id,
        i.from_module_id as fromModuleId,
        i.to_module_id as toModuleId,
        i.direction,
        i.weight,
        i.pattern,
        i.symbols,
        i.semantic,
        i.created_at as createdAt,
        from_m.full_path as fromModulePath,
        to_m.full_path as toModulePath
      FROM interactions i
      JOIN modules from_m ON i.from_module_id = from_m.id
      JOIN modules to_m ON i.to_module_id = to_m.id
      WHERE i.to_module_id = ?
      ORDER BY i.weight DESC
    `);

    return stmt.all(moduleId) as InteractionWithPaths[];
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

    const totalCount = this.getCount();

    const businessStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM interactions WHERE pattern = 'business'"
    );
    const businessCount = (businessStmt.get() as { count: number }).count;

    const utilityStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM interactions WHERE pattern = 'utility'"
    );
    const utilityCount = (utilityStmt.get() as { count: number }).count;

    const biStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM interactions WHERE direction = 'bi'"
    );
    const biDirectionalCount = (biStmt.get() as { count: number }).count;

    return {
      totalCount,
      businessCount,
      utilityCount,
      biDirectionalCount,
    };
  }

  /**
   * Get the module-level call graph (for detecting interactions).
   */
  getModuleCallGraph(): ModuleCallEdge[] {
    ensureModulesTables(this.db);

    // Get symbol-level call graph
    const symbolEdges = this.getCallGraph();

    // Build module lookup for definitions
    const defModuleMap = new Map<number, { moduleId: number; modulePath: string }>();
    const moduleMembers = this.db.prepare(`
      SELECT mm.definition_id, mm.module_id, m.full_path
      FROM module_members mm
      JOIN modules m ON mm.module_id = m.id
    `).all() as Array<{ definition_id: number; module_id: number; full_path: string }>;

    for (const mm of moduleMembers) {
      defModuleMap.set(mm.definition_id, {
        moduleId: mm.module_id,
        modulePath: mm.full_path,
      });
    }

    // Aggregate to module-level edges
    const edgeMap = new Map<string, ModuleCallEdge>();

    for (const edge of symbolEdges) {
      const fromModule = defModuleMap.get(edge.fromId);
      const toModule = defModuleMap.get(edge.toId);

      if (!fromModule || !toModule) continue;
      if (fromModule.moduleId === toModule.moduleId) continue;

      const key = `${fromModule.moduleId}->${toModule.moduleId}`;
      const existing = edgeMap.get(key);

      if (existing) {
        existing.weight += edge.weight;
      } else {
        edgeMap.set(key, {
          fromModuleId: fromModule.moduleId,
          toModuleId: toModule.moduleId,
          weight: edge.weight,
          fromModulePath: fromModule.modulePath,
          toModulePath: toModule.modulePath,
        });
      }
    }

    return Array.from(edgeMap.values()).sort((a, b) => b.weight - a.weight);
  }

  /**
   * Get enriched module-level call graph with symbol details.
   */
  getEnrichedModuleCallGraph(): EnrichedModuleCallEdge[] {
    ensureModulesTables(this.db);

    // Query for symbol-level details with module context
    const symbolEdges = this.db.prepare(`
      SELECT
        from_mm.module_id as from_module_id,
        to_mm.module_id as to_module_id,
        from_m.full_path as from_module_path,
        to_m.full_path as to_module_path,
        to_d.name as symbol_name,
        to_d.kind as symbol_kind,
        from_d.id as caller_id,
        COUNT(*) as call_count,
        MIN(u.line) as min_usage_line
      FROM definitions from_d
      JOIN files f ON from_d.file_id = f.id
      JOIN module_members from_mm ON from_mm.definition_id = from_d.id
      JOIN modules from_m ON from_mm.module_id = from_m.id
      JOIN symbols s ON s.file_id = f.id AND s.definition_id IS NOT NULL
      JOIN definitions to_d ON s.definition_id = to_d.id
      JOIN module_members to_mm ON to_mm.definition_id = to_d.id
      JOIN modules to_m ON to_mm.module_id = to_m.id
      JOIN usages u ON u.symbol_id = s.id
      WHERE u.context IN ('call_expression', 'new_expression')
        AND from_d.line <= u.line AND u.line <= from_d.end_line
        AND s.definition_id != from_d.id
        AND from_mm.module_id != to_mm.module_id
      GROUP BY from_mm.module_id, to_mm.module_id, to_d.id, from_d.id
      UNION ALL
      SELECT
        from_mm.module_id as from_module_id,
        to_mm.module_id as to_module_id,
        from_m.full_path as from_module_path,
        to_m.full_path as to_module_path,
        to_d.name as symbol_name,
        to_d.kind as symbol_kind,
        from_d.id as caller_id,
        COUNT(*) as call_count,
        MIN(u.line) as min_usage_line
      FROM definitions from_d
      JOIN files f ON from_d.file_id = f.id
      JOIN module_members from_mm ON from_mm.definition_id = from_d.id
      JOIN modules from_m ON from_mm.module_id = from_m.id
      JOIN imports i ON i.from_file_id = f.id
      JOIN symbols s ON s.reference_id = i.id AND s.definition_id IS NOT NULL
      JOIN definitions to_d ON s.definition_id = to_d.id
      JOIN module_members to_mm ON to_mm.definition_id = to_d.id
      JOIN modules to_m ON to_mm.module_id = to_m.id
      JOIN usages u ON u.symbol_id = s.id
      WHERE u.context IN ('call_expression', 'new_expression')
        AND from_d.line <= u.line AND u.line <= from_d.end_line
        AND s.definition_id != from_d.id
        AND from_mm.module_id != to_mm.module_id
      GROUP BY from_mm.module_id, to_mm.module_id, to_d.id, from_d.id
    `).all() as Array<{
      from_module_id: number;
      to_module_id: number;
      from_module_path: string;
      to_module_path: string;
      symbol_name: string;
      symbol_kind: string;
      caller_id: number;
      call_count: number;
      min_usage_line: number;
    }>;

    // Aggregate into enriched edges
    const edgeMap = new Map<string, {
      fromModuleId: number;
      toModuleId: number;
      fromModulePath: string;
      toModulePath: string;
      weight: number;
      symbols: Map<string, CalledSymbolInfo>;
      callers: Set<number>;
      minUsageLine: number;
    }>();

    for (const row of symbolEdges) {
      const key = `${row.from_module_id}->${row.to_module_id}`;
      let edge = edgeMap.get(key);

      if (!edge) {
        edge = {
          fromModuleId: row.from_module_id,
          toModuleId: row.to_module_id,
          fromModulePath: row.from_module_path,
          toModulePath: row.to_module_path,
          weight: 0,
          symbols: new Map(),
          callers: new Set(),
          minUsageLine: row.min_usage_line,
        };
        edgeMap.set(key, edge);
      }

      edge.weight += row.call_count;
      edge.callers.add(row.caller_id);
      edge.minUsageLine = Math.min(edge.minUsageLine, row.min_usage_line);

      const symbolKey = row.symbol_name;
      const existing = edge.symbols.get(symbolKey);
      if (existing) {
        existing.callCount += row.call_count;
      } else {
        edge.symbols.set(symbolKey, {
          name: row.symbol_name,
          kind: row.symbol_kind,
          callCount: row.call_count,
        });
      }
    }

    // Convert to EnrichedModuleCallEdge with classification
    const result: EnrichedModuleCallEdge[] = [];

    for (const edge of edgeMap.values()) {
      const calledSymbols = Array.from(edge.symbols.values())
        .sort((a, b) => b.callCount - a.callCount);

      const symbolCount = calledSymbols.length;
      const avgCallsPerSymbol = symbolCount > 0 ? edge.weight / symbolCount : 0;
      const distinctCallers = edge.callers.size;
      const isHighFrequency = edge.weight > 10;

      // Classify edge as utility or business logic
      const hasClassCall = calledSymbols.some(s => s.kind === 'class');
      const isLikelyUtility = (
        isHighFrequency &&
        distinctCallers >= 3 &&
        avgCallsPerSymbol > 3 &&
        !hasClassCall
      );

      result.push({
        fromModuleId: edge.fromModuleId,
        toModuleId: edge.toModuleId,
        fromModulePath: edge.fromModulePath,
        toModulePath: edge.toModulePath,
        weight: edge.weight,
        calledSymbols,
        avgCallsPerSymbol,
        distinctCallers,
        isHighFrequency,
        edgePattern: isLikelyUtility ? 'utility' : 'business',
        minUsageLine: edge.minUsageLine,
      });
    }

    return result.sort((a, b) => b.weight - a.weight);
  }

  /**
   * Sync interactions from the module call graph.
   * Creates or updates interactions based on detected module edges.
   */
  syncFromCallGraph(): { created: number; updated: number } {
    const enrichedEdges = this.getEnrichedModuleCallGraph();
    let created = 0;
    let updated = 0;

    for (const edge of enrichedEdges) {
      const existing = this.getByModules(edge.fromModuleId, edge.toModuleId);
      const symbols = edge.calledSymbols.map(s => s.name);

      if (existing) {
        this.update(existing.id, {
          pattern: edge.edgePattern,
          symbols,
        });
        // Update weight
        this.db.prepare('UPDATE interactions SET weight = ? WHERE id = ?')
          .run(edge.weight, existing.id);
        updated++;
      } else {
        this.insert(edge.fromModuleId, edge.toModuleId, {
          weight: edge.weight,
          pattern: edge.edgePattern,
          symbols,
        });
        created++;
      }
    }

    return { created, updated };
  }

  // Private helpers

  private getCallGraph(): CallGraphEdge[] {
    const stmt = this.db.prepare(`
      SELECT
        caller.id as from_id,
        s.definition_id as to_id,
        COUNT(*) as weight,
        MIN(u.line) as min_usage_line
      FROM definitions caller
      JOIN files f ON caller.file_id = f.id
      JOIN symbols s ON s.file_id = f.id AND s.definition_id IS NOT NULL
      JOIN usages u ON u.symbol_id = s.id
      WHERE u.context IN ('call_expression', 'new_expression')
        AND caller.line <= u.line AND u.line <= caller.end_line
        AND s.definition_id != caller.id
      GROUP BY caller.id, s.definition_id
      UNION ALL
      SELECT
        caller.id as from_id,
        s.definition_id as to_id,
        COUNT(*) as weight,
        MIN(u.line) as min_usage_line
      FROM definitions caller
      JOIN files f ON caller.file_id = f.id
      JOIN imports i ON i.from_file_id = f.id
      JOIN symbols s ON s.reference_id = i.id AND s.definition_id IS NOT NULL
      JOIN usages u ON u.symbol_id = s.id
      WHERE u.context IN ('call_expression', 'new_expression')
        AND caller.line <= u.line AND u.line <= caller.end_line
        AND s.definition_id != caller.id
      GROUP BY caller.id, s.definition_id
    `);

    const rows = stmt.all() as Array<{
      from_id: number;
      to_id: number;
      weight: number;
      min_usage_line: number;
    }>;

    const edgeMap = new Map<string, CallGraphEdge>();
    for (const row of rows) {
      const key = `${row.from_id}-${row.to_id}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += row.weight;
        existing.minUsageLine = Math.min(existing.minUsageLine, row.min_usage_line);
      } else {
        edgeMap.set(key, {
          fromId: row.from_id,
          toId: row.to_id,
          weight: row.weight,
          minUsageLine: row.min_usage_line,
        });
      }
    }

    return Array.from(edgeMap.values());
  }
}
