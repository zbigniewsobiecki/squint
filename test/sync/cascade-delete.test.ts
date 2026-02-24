import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA } from '../../src/db/schema.js';
import { cascadeDeleteDefinitions, cascadeDeleteFile, cleanDanglingSymbolRefs } from '../../src/sync/cascade-delete.js';

describe('cascade-delete', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  // Helper functions
  function insertFile(path: string): number {
    const result = db
      .prepare('INSERT INTO files (path, language, content_hash, size_bytes, modified_at) VALUES (?, ?, ?, ?, ?)')
      .run(path, 'typescript', 'hash123', 100, '2024-01-01');
    return result.lastInsertRowid as number;
  }

  function insertDefinition(fileId: number, name: string): number {
    const result = db
      .prepare(
        `INSERT INTO definitions (file_id, name, kind, is_exported, is_default, line, column, end_line, end_column, declaration_end_line, declaration_end_column)
       VALUES (?, ?, 'function', 1, 0, 1, 0, 10, 1, 10, 1)`
      )
      .run(fileId, name);
    return result.lastInsertRowid as number;
  }

  function insertSymbol(fileId: number, name: string, definitionId: number | null = null): number {
    const result = db
      .prepare(
        `INSERT INTO symbols (file_id, name, local_name, kind, definition_id, reference_id)
       VALUES (?, ?, ?, 'identifier', ?, NULL)`
      )
      .run(fileId, name, name, definitionId);
    return result.lastInsertRowid as number;
  }

  function insertUsage(symbolId: number, line: number): number {
    const result = db
      .prepare(
        `INSERT INTO usages (symbol_id, line, column, context, argument_count, is_method_call, is_constructor_call, receiver_name)
       VALUES (?, ?, 0, 'test', 0, 0, 0, NULL)`
      )
      .run(symbolId, line);
    return result.lastInsertRowid as number;
  }

  function insertMetadata(definitionId: number, key: string, value: string): void {
    db.prepare('INSERT INTO definition_metadata (definition_id, key, value) VALUES (?, ?, ?)').run(
      definitionId,
      key,
      value
    );
  }

  function insertRelationshipAnnotation(fromDefId: number, toDefId: number): number {
    const result = db
      .prepare(
        `INSERT INTO relationship_annotations (from_definition_id, to_definition_id, relationship_type, semantic)
       VALUES (?, ?, 'uses', 'test relationship')`
      )
      .run(fromDefId, toDefId);
    return result.lastInsertRowid as number;
  }

  function insertModuleMember(definitionId: number, moduleId: number): void {
    db.prepare('INSERT INTO module_members (module_id, definition_id) VALUES (?, ?)').run(moduleId, definitionId);
  }

  function insertFlowDefinitionStep(flowId: number, stepOrder: number, fromDefId: number, toDefId: number): void {
    db.prepare(
      `INSERT INTO flow_definition_steps (flow_id, step_order, from_definition_id, to_definition_id)
       VALUES (?, ?, ?, ?)`
    ).run(flowId, stepOrder, fromDefId, toDefId);
  }

  function countRows(table: string): number {
    const result = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
    return result.count;
  }

  describe('cascadeDeleteDefinitions', () => {
    it('handles empty array without error', () => {
      cascadeDeleteDefinitions(db, []);
      expect(countRows('definitions')).toBe(0);
    });

    it('deletes symbols pointing to deleted definitions', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      const symbolId = insertSymbol(fileId, 'myFunc', defId);

      expect(countRows('symbols')).toBe(1);
      cascadeDeleteDefinitions(db, [defId]);

      expect(countRows('definitions')).toBe(0);
      expect(countRows('symbols')).toBe(0);
    });

    it('deletes usages for symbols pointing to deleted definitions', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      const symbolId = insertSymbol(fileId, 'myFunc', defId);
      insertUsage(symbolId, 5);

      expect(countRows('usages')).toBe(1);
      cascadeDeleteDefinitions(db, [defId]);

      expect(countRows('usages')).toBe(0);
    });

    it('deletes definition metadata', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      insertMetadata(defId, 'purpose', 'test function');

      expect(countRows('definition_metadata')).toBe(1);
      cascadeDeleteDefinitions(db, [defId]);

      expect(countRows('definition_metadata')).toBe(0);
    });

    it('deletes relationship annotations in both directions', () => {
      const fileId = insertFile('/test.ts');
      const defId1 = insertDefinition(fileId, 'func1');
      const defId2 = insertDefinition(fileId, 'func2');
      const defId3 = insertDefinition(fileId, 'func3');

      // defId1 -> defId2
      insertRelationshipAnnotation(defId1, defId2);
      // defId3 -> defId1
      insertRelationshipAnnotation(defId3, defId1);

      expect(countRows('relationship_annotations')).toBe(2);

      // Delete defId1 should remove both relationships
      cascadeDeleteDefinitions(db, [defId1]);

      expect(countRows('relationship_annotations')).toBe(0);
      expect(countRows('definitions')).toBe(2); // defId2 and defId3 remain
    });

    it('deletes module members', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      const moduleId = db
        .prepare(
          "INSERT INTO modules (parent_id, slug, full_path, name, depth) VALUES (NULL, 'test', 'test', 'Test', 0)"
        )
        .run().lastInsertRowid as number;
      insertModuleMember(defId, moduleId);

      expect(countRows('module_members')).toBe(1);
      cascadeDeleteDefinitions(db, [defId]);

      expect(countRows('module_members')).toBe(0);
    });

    it('deletes flow definition steps in both directions', () => {
      const fileId = insertFile('/test.ts');
      const defId1 = insertDefinition(fileId, 'func1');
      const defId2 = insertDefinition(fileId, 'func2');
      const defId3 = insertDefinition(fileId, 'func3');

      // Create a flow first
      const flowId = db
        .prepare('INSERT INTO flows (name, slug, entry_point_id) VALUES (?, ?, ?)')
        .run('Test Flow', 'test-flow', defId1).lastInsertRowid as number;

      // defId1 -> defId2
      db.prepare(
        `INSERT INTO flow_definition_steps (flow_id, step_order, from_definition_id, to_definition_id)
         VALUES (?, 1, ?, ?)`
      ).run(flowId, defId1, defId2);

      // defId3 -> defId1
      db.prepare(
        `INSERT INTO flow_definition_steps (flow_id, step_order, from_definition_id, to_definition_id)
         VALUES (?, 2, ?, ?)`
      ).run(flowId, defId3, defId1);

      expect(countRows('flow_definition_steps')).toBe(2);

      // Delete defId1 should remove both steps
      cascadeDeleteDefinitions(db, [defId1]);

      expect(countRows('flow_definition_steps')).toBe(0);
    });

    it('handles multiple definition IDs', () => {
      const fileId = insertFile('/test.ts');
      const defId1 = insertDefinition(fileId, 'func1');
      const defId2 = insertDefinition(fileId, 'func2');
      insertMetadata(defId1, 'purpose', 'test 1');
      insertMetadata(defId2, 'purpose', 'test 2');

      expect(countRows('definitions')).toBe(2);
      expect(countRows('definition_metadata')).toBe(2);

      cascadeDeleteDefinitions(db, [defId1, defId2]);

      expect(countRows('definitions')).toBe(0);
      expect(countRows('definition_metadata')).toBe(0);
    });
  });

  describe('cascadeDeleteFile', () => {
    it('deletes file and all owned definitions', () => {
      const fileId = insertFile('/test.ts');
      const defId1 = insertDefinition(fileId, 'func1');
      const defId2 = insertDefinition(fileId, 'func2');

      expect(countRows('files')).toBe(1);
      expect(countRows('definitions')).toBe(2);

      cascadeDeleteFile(db, fileId);

      expect(countRows('files')).toBe(0);
      expect(countRows('definitions')).toBe(0);
    });

    it('deletes symbols and usages for file definitions', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      const symbolId = insertSymbol(fileId, 'myFunc', defId);
      insertUsage(symbolId, 5);

      cascadeDeleteFile(db, fileId);

      expect(countRows('symbols')).toBe(0);
      expect(countRows('usages')).toBe(0);
    });

    it('deletes symbols linked to imports from the file', () => {
      const fileId = insertFile('/test.ts');
      const targetFileId = insertFile('/target.ts');

      // Insert import
      const importId = db
        .prepare(
          `INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column)
         VALUES (?, ?, 'named', '/target.ts', 0, 0, 1, 0)`
        )
        .run(fileId, targetFileId).lastInsertRowid as number;

      // Insert symbol linked to this import
      const symbolId = db
        .prepare(
          `INSERT INTO symbols (file_id, name, local_name, kind, definition_id, reference_id)
         VALUES (?, 'myFunc', 'myFunc', 'identifier', NULL, ?)`
        )
        .run(fileId, importId).lastInsertRowid as number;

      insertUsage(symbolId, 5);

      expect(countRows('imports')).toBe(1);
      expect(countRows('symbols')).toBe(1);
      expect(countRows('usages')).toBe(1);

      cascadeDeleteFile(db, fileId);

      expect(countRows('imports')).toBe(0);
      expect(countRows('symbols')).toBe(0);
      expect(countRows('usages')).toBe(0);
    });

    it('deletes internal symbols (file_id based)', () => {
      const fileId = insertFile('/test.ts');
      // Internal symbol without definition_id or reference_id
      const symbolId = db
        .prepare(
          `INSERT INTO symbols (file_id, name, local_name, kind, definition_id, reference_id)
         VALUES (?, 'localVar', 'localVar', 'identifier', NULL, NULL)`
        )
        .run(fileId).lastInsertRowid as number;

      expect(countRows('symbols')).toBe(1);

      cascadeDeleteFile(db, fileId);

      expect(countRows('symbols')).toBe(0);
    });

    it('handles file with no definitions', () => {
      const fileId = insertFile('/empty.ts');

      expect(countRows('files')).toBe(1);

      cascadeDeleteFile(db, fileId);

      expect(countRows('files')).toBe(0);
    });

    it('cascades through all dependent tables', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      const symbolId = insertSymbol(fileId, 'myFunc', defId);
      insertUsage(symbolId, 5);
      insertMetadata(defId, 'purpose', 'test');

      const moduleId = db
        .prepare(
          "INSERT INTO modules (parent_id, slug, full_path, name, depth) VALUES (NULL, 'test', 'test', 'Test', 0)"
        )
        .run().lastInsertRowid as number;
      insertModuleMember(defId, moduleId);

      cascadeDeleteFile(db, fileId);

      expect(countRows('files')).toBe(0);
      expect(countRows('definitions')).toBe(0);
      expect(countRows('symbols')).toBe(0);
      expect(countRows('usages')).toBe(0);
      expect(countRows('definition_metadata')).toBe(0);
      expect(countRows('module_members')).toBe(0);
    });
  });

  describe('cleanDanglingSymbolRefs', () => {
    it('returns 0 when no dangling references exist', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      insertSymbol(fileId, 'myFunc', defId);

      const fixed = cleanDanglingSymbolRefs(db);

      expect(fixed).toBe(0);
    });

    it('nulls out definition_id pointing to non-existent definitions', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      const symbolId = insertSymbol(fileId, 'myFunc', defId);

      // Manually delete the definition without cascade (disable FK enforcement)
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM definitions WHERE id = ?').run(defId);
      db.pragma('foreign_keys = ON');

      // Verify symbol still references deleted definition
      const beforeSymbol = db.prepare('SELECT definition_id FROM symbols WHERE id = ?').get(symbolId) as {
        definition_id: number | null;
      };
      expect(beforeSymbol.definition_id).toBe(defId);

      const fixed = cleanDanglingSymbolRefs(db);

      expect(fixed).toBe(1);

      // Verify definition_id is now NULL
      const afterSymbol = db.prepare('SELECT definition_id FROM symbols WHERE id = ?').get(symbolId) as {
        definition_id: number | null;
      };
      expect(afterSymbol.definition_id).toBeNull();
    });

    it('handles multiple dangling references', () => {
      const fileId = insertFile('/test.ts');
      const defId1 = insertDefinition(fileId, 'func1');
      const defId2 = insertDefinition(fileId, 'func2');
      const symbolId1 = insertSymbol(fileId, 'func1', defId1);
      const symbolId2 = insertSymbol(fileId, 'func2', defId2);

      // Manually delete definitions (disable FK enforcement)
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM definitions WHERE id IN (?, ?)').run(defId1, defId2);
      db.pragma('foreign_keys = ON');

      const fixed = cleanDanglingSymbolRefs(db);

      expect(fixed).toBe(2);
    });

    it('does not affect symbols with NULL definition_id', () => {
      const fileId = insertFile('/test.ts');
      insertSymbol(fileId, 'someVar', null);

      const fixed = cleanDanglingSymbolRefs(db);

      expect(fixed).toBe(0);
    });

    it('does not affect symbols with valid definition_id', () => {
      const fileId = insertFile('/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');
      const symbolId = insertSymbol(fileId, 'myFunc', defId);

      const fixed = cleanDanglingSymbolRefs(db);

      expect(fixed).toBe(0);

      const symbol = db.prepare('SELECT definition_id FROM symbols WHERE id = ?').get(symbolId) as {
        definition_id: number;
      };
      expect(symbol.definition_id).toBe(defId);
    });
  });
});
