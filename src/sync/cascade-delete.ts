import type Database from 'better-sqlite3';

/**
 * Cascade-delete a set of definitions and all their dependents.
 * Since FK enforcement is OFF, we manually delete in leaf-first order.
 */
export function cascadeDeleteDefinitions(db: Database.Database, definitionIds: number[]): void {
  if (definitionIds.length === 0) return;

  const placeholders = definitionIds.map(() => '?').join(',');

  // Delete usages for symbols pointing to these definitions
  db.prepare(
    `DELETE FROM usages WHERE symbol_id IN
      (SELECT id FROM symbols WHERE definition_id IN (${placeholders}))`
  ).run(...definitionIds);

  // Delete symbols pointing to these definitions
  db.prepare(`DELETE FROM symbols WHERE definition_id IN (${placeholders})`).run(...definitionIds);

  // Delete definition metadata
  db.prepare(`DELETE FROM definition_metadata WHERE definition_id IN (${placeholders})`).run(...definitionIds);

  // Delete relationship annotations (both directions)
  db.prepare(
    `DELETE FROM relationship_annotations
     WHERE from_definition_id IN (${placeholders}) OR to_definition_id IN (${placeholders})`
  ).run(...definitionIds, ...definitionIds);

  // Delete module members
  db.prepare(`DELETE FROM module_members WHERE definition_id IN (${placeholders})`).run(...definitionIds);

  // Delete flow definition steps (both directions)
  db.prepare(
    `DELETE FROM flow_definition_steps
     WHERE from_definition_id IN (${placeholders}) OR to_definition_id IN (${placeholders})`
  ).run(...definitionIds, ...definitionIds);

  // Delete the definitions themselves
  db.prepare(`DELETE FROM definitions WHERE id IN (${placeholders})`).run(...definitionIds);
}

/**
 * Cascade-delete a file and all its owned data (definitions, imports, symbols, usages).
 */
export function cascadeDeleteFile(db: Database.Database, fileId: number): void {
  // Get definition IDs for this file
  const defRows = db.prepare('SELECT id FROM definitions WHERE file_id = ?').all(fileId) as Array<{ id: number }>;
  const defIds = defRows.map((r) => r.id);

  // Cascade-delete all definitions
  if (defIds.length > 0) {
    cascadeDeleteDefinitions(db, defIds);
  }

  // Delete usages for symbols linked to imports from this file
  db.prepare(
    `DELETE FROM usages WHERE symbol_id IN
      (SELECT s.id FROM symbols s JOIN imports i ON s.reference_id = i.id
       WHERE i.from_file_id = ?)`
  ).run(fileId);

  // Delete symbols linked to imports from this file
  db.prepare(
    `DELETE FROM symbols WHERE reference_id IN
      (SELECT id FROM imports WHERE from_file_id = ?)`
  ).run(fileId);

  // Delete internal symbols (file_id based)
  db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);

  // Delete imports originating from this file
  db.prepare('DELETE FROM imports WHERE from_file_id = ?').run(fileId);

  // Delete the file record
  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
}

/**
 * Null out any symbols.definition_id that point to non-existent definitions.
 * Returns the number of fixed references.
 */
export function cleanDanglingSymbolRefs(db: Database.Database): number {
  const result = db
    .prepare(
      `UPDATE symbols SET definition_id = NULL
     WHERE definition_id IS NOT NULL
       AND definition_id NOT IN (SELECT id FROM definitions)`
    )
    .run();
  return result.changes;
}
