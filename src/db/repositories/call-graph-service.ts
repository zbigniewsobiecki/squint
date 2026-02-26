import type Database from 'better-sqlite3';
import { ensureModulesTables } from '../schema-manager.js';
import type { CalledSymbolInfo, EnrichedModuleCallEdge, ModuleCallEdge } from '../schema.js';
import { queryCallGraphEdges } from './_shared/call-graph-query.js';
import type { InteractionRepository } from './interaction-repository.js';

/**
 * Service for module-level call graph analysis.
 * Extracted from InteractionRepository to separate call graph analysis from CRUD.
 */
export class CallGraphService {
  constructor(private db: Database.Database) {}

  /**
   * Get the module-level call graph (for detecting interactions).
   */
  getModuleCallGraph(): ModuleCallEdge[] {
    ensureModulesTables(this.db);

    // Get symbol-level call graph
    const symbolEdges = queryCallGraphEdges(this.db, { includeJsx: true });

    // Build module lookup for definitions
    const defModuleMap = new Map<number, { moduleId: number; modulePath: string }>();
    const moduleMembers = this.db
      .prepare(`
      SELECT mm.definition_id, mm.module_id, m.full_path
      FROM module_members mm
      JOIN modules m ON mm.module_id = m.id
    `)
      .all() as Array<{ definition_id: number; module_id: number; full_path: string }>;

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
   * When moduleIds is provided, only returns edges touching those modules.
   */
  getEnrichedModuleCallGraph(moduleIds?: Set<number>): EnrichedModuleCallEdge[] {
    ensureModulesTables(this.db);

    // Build optional WHERE clause for module filtering
    let moduleFilter = '';
    const filterParams: number[] = [];
    if (moduleIds && moduleIds.size > 0) {
      const ids = Array.from(moduleIds);
      const placeholders = ids.map(() => '?').join(', ');
      moduleFilter = ` AND (from_mm.module_id IN (${placeholders}) OR to_mm.module_id IN (${placeholders}))`;
      filterParams.push(...ids, ...ids);
    }

    // Query for symbol-level details with module context
    const symbolEdges = this.db
      .prepare(`
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
      WHERE u.context IN ('call_expression', 'new_expression', 'jsx_self_closing_element', 'jsx_opening_element')
        AND from_d.line <= u.line AND u.line <= from_d.end_line
        AND s.definition_id != from_d.id
        AND from_mm.module_id != to_mm.module_id
        ${moduleFilter}
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
      WHERE u.context IN ('call_expression', 'new_expression', 'jsx_self_closing_element', 'jsx_opening_element')
        AND from_d.line <= u.line AND u.line <= from_d.end_line
        AND s.definition_id != from_d.id
        AND from_mm.module_id != to_mm.module_id
        ${moduleFilter}
      GROUP BY from_mm.module_id, to_mm.module_id, to_d.id, from_d.id
    `)
      .all(...filterParams, ...filterParams) as Array<{
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
    const edgeMap = new Map<
      string,
      {
        fromModuleId: number;
        toModuleId: number;
        fromModulePath: string;
        toModulePath: string;
        weight: number;
        symbols: Map<string, CalledSymbolInfo>;
        callers: Set<number>;
        minUsageLine: number;
      }
    >();

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

    // Get test module IDs for test-internal classification
    const testModuleRows = this.db.prepare('SELECT id FROM modules WHERE is_test = 1').all() as Array<{ id: number }>;
    const testModuleIds = new Set(testModuleRows.map((r) => r.id));

    for (const edge of edgeMap.values()) {
      const calledSymbols = Array.from(edge.symbols.values()).sort((a, b) => b.callCount - a.callCount);

      const symbolCount = calledSymbols.length;
      const avgCallsPerSymbol = symbolCount > 0 ? edge.weight / symbolCount : 0;
      const distinctCallers = edge.callers.size;
      const isHighFrequency = edge.weight > 10;

      // Classify edge: test-internal if both modules are test, otherwise utility/business
      let edgePattern: 'utility' | 'business' | 'test-internal';
      if (testModuleIds.has(edge.fromModuleId) && testModuleIds.has(edge.toModuleId)) {
        edgePattern = 'test-internal';
      } else {
        const hasClassCall = calledSymbols.some((s) => s.kind === 'class');
        const isLikelyUtility = isHighFrequency && distinctCallers >= 3 && avgCallsPerSymbol > 3 && !hasClassCall;
        edgePattern = isLikelyUtility ? 'utility' : 'business';
      }

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
        edgePattern,
        minUsageLine: edge.minUsageLine,
      });
    }

    return result.sort((a, b) => b.weight - a.weight);
  }

  /**
   * Sync interactions from the module call graph.
   * Creates or updates interactions based on detected module edges.
   */
  syncFromCallGraph(interactionRepo: InteractionRepository): { created: number; updated: number } {
    const enrichedEdges = this.getEnrichedModuleCallGraph();
    let created = 0;
    let updated = 0;

    for (const edge of enrichedEdges) {
      const existing = interactionRepo.getByModules(edge.fromModuleId, edge.toModuleId);
      const symbols = edge.calledSymbols.map((s) => s.name);

      if (existing) {
        interactionRepo.update(existing.id, {
          pattern: edge.edgePattern,
          symbols,
        });
        // Update weight
        this.db.prepare('UPDATE interactions SET weight = ? WHERE id = ?').run(edge.weight, existing.id);
        updated++;
      } else {
        interactionRepo.insert(edge.fromModuleId, edge.toModuleId, {
          weight: edge.weight,
          pattern: edge.edgePattern,
          symbols,
        });
        created++;
      }
    }

    return { created, updated };
  }
}
