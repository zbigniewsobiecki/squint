import type Database from 'better-sqlite3';
import type { CallGraphEdge } from '../../schema.js';

/**
 * Shared call graph query used by interaction, module, and graph repositories.
 * The only difference is whether JSX contexts are included.
 */
export function queryCallGraphEdges(db: Database.Database, opts?: { includeJsx?: boolean }): CallGraphEdge[] {
  const contexts = opts?.includeJsx
    ? "'call_expression', 'new_expression', 'jsx_self_closing_element', 'jsx_opening_element'"
    : "'call_expression', 'new_expression'";

  const stmt = db.prepare(`
    SELECT
      caller.id as from_id,
      s.definition_id as to_id,
      COUNT(*) as weight,
      MIN(u.line) as min_usage_line
    FROM definitions caller
    JOIN files f ON caller.file_id = f.id
    JOIN symbols s ON s.file_id = f.id AND s.definition_id IS NOT NULL
    JOIN usages u ON u.symbol_id = s.id
    WHERE u.context IN (${contexts})
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
    WHERE u.context IN (${contexts})
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
