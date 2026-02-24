import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database-facade.js';
import { computeHash } from '../../src/db/schema.js';
import { cascadeDeleteDefinitions, cascadeDeleteFile, cleanDanglingSymbolRefs } from '../../src/sync/cascade-delete.js';

describe('cascade-delete', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  describe('cascadeDeleteDefinitions', () => {
    it('cascades to usages, symbols, metadata, relationships, module_members, flow_definition_steps', () => {
      // Setup: Create a file with two definitions
      const fileId = db.insertFile({
        path: 'test.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: new Date().toISOString(),
      });

      const def1Id = db.insertDefinition(fileId, {
        name: 'funcA',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2Id = db.insertDefinition(fileId, {
        name: 'funcB',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 4, column: 0 },
        endPosition: { row: 6, column: 1 },
      });

      // Create a symbol referencing def1
      const refId = db.insertReference(fileId, fileId, {
        type: 'import',
        source: './test',
        isTypeOnly: false,
        isExternal: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const symbolId = db.insertSymbol(refId, def1Id, {
        name: 'funcA',
        localName: 'funcA',
        kind: 'named',
        usages: [],
      });

      // Create a usage for that symbol
      db.insertUsage(symbolId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
      });

      // Add metadata to def1
      db.metadata.set(def1Id, 'purpose', 'Test function');

      // Add relationship from def1 to def2
      db.relationships.set(def1Id, def2Id, 'calls', 'funcA calls funcB');

      // Add module membership
      const moduleId = db.modules.insert(null, 'test-module', 'TestModule', 'Test module');
      db.modules.assignSymbol(def1Id, moduleId);

      // Add flow definition step
      const flowId = db.flows.insert('TestFlow', 'test-flow', {
        description: 'Test flow',
      });
      const conn = db.getConnection();
      conn
        .prepare(
          'INSERT INTO flow_definition_steps (flow_id, step_order, from_definition_id, to_definition_id) VALUES (?, ?, ?, ?)'
        )
        .run(flowId, 1, def1Id, def2Id);

      // Verify initial state
      expect(conn.prepare('SELECT COUNT(*) as count FROM symbols WHERE definition_id = ?').get(def1Id)).toMatchObject({
        count: 1,
      });
      expect(conn.prepare('SELECT COUNT(*) as count FROM usages WHERE symbol_id = ?').get(symbolId)).toMatchObject({
        count: 1,
      });
      expect(
        conn.prepare('SELECT COUNT(*) as count FROM definition_metadata WHERE definition_id = ?').get(def1Id)
      ).toMatchObject({ count: 1 });
      expect(
        conn.prepare('SELECT COUNT(*) as count FROM relationship_annotations WHERE from_definition_id = ?').get(def1Id)
      ).toMatchObject({ count: 1 });
      expect(
        conn.prepare('SELECT COUNT(*) as count FROM module_members WHERE definition_id = ?').get(def1Id)
      ).toMatchObject({ count: 1 });
      expect(
        conn.prepare('SELECT COUNT(*) as count FROM flow_definition_steps WHERE from_definition_id = ?').get(def1Id)
      ).toMatchObject({ count: 1 });

      // Execute cascade delete for def1
      cascadeDeleteDefinitions(conn, [def1Id]);

      // Verify cascaded deletions
      expect(conn.prepare('SELECT COUNT(*) as count FROM definitions WHERE id = ?').get(def1Id)).toMatchObject({
        count: 0,
      });
      expect(conn.prepare('SELECT COUNT(*) as count FROM symbols WHERE definition_id = ?').get(def1Id)).toMatchObject({
        count: 0,
      });
      expect(conn.prepare('SELECT COUNT(*) as count FROM usages WHERE symbol_id = ?').get(symbolId)).toMatchObject({
        count: 0,
      });
      expect(
        conn.prepare('SELECT COUNT(*) as count FROM definition_metadata WHERE definition_id = ?').get(def1Id)
      ).toMatchObject({ count: 0 });
      expect(
        conn.prepare('SELECT COUNT(*) as count FROM relationship_annotations WHERE from_definition_id = ?').get(def1Id)
      ).toMatchObject({ count: 0 });
      expect(
        conn.prepare('SELECT COUNT(*) as count FROM module_members WHERE definition_id = ?').get(def1Id)
      ).toMatchObject({ count: 0 });
      expect(
        conn.prepare('SELECT COUNT(*) as count FROM flow_definition_steps WHERE from_definition_id = ?').get(def1Id)
      ).toMatchObject({ count: 0 });

      // Verify def2 still exists
      expect(conn.prepare('SELECT COUNT(*) as count FROM definitions WHERE id = ?').get(def2Id)).toMatchObject({
        count: 1,
      });
    });

    it('handles empty array as no-op', () => {
      const conn = db.getConnection();
      const beforeCount = conn.prepare('SELECT COUNT(*) as count FROM definitions').get() as { count: number };

      cascadeDeleteDefinitions(conn, []);

      const afterCount = conn.prepare('SELECT COUNT(*) as count FROM definitions').get() as { count: number };
      expect(afterCount.count).toBe(beforeCount.count);
    });

    it('handles multiple definitions in a single call', () => {
      const fileId = db.insertFile({
        path: 'multi.ts',
        language: 'typescript',
        contentHash: computeHash('multi'),
        sizeBytes: 50,
        modifiedAt: new Date().toISOString(),
      });

      const def1Id = db.insertDefinition(fileId, {
        name: 'func1',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 1, column: 1 },
      });

      const def2Id = db.insertDefinition(fileId, {
        name: 'func2',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 4, column: 1 },
      });

      const conn = db.getConnection();
      cascadeDeleteDefinitions(conn, [def1Id, def2Id]);

      expect(
        conn.prepare('SELECT COUNT(*) as count FROM definitions WHERE id IN (?, ?)').get(def1Id, def2Id)
      ).toMatchObject({
        count: 0,
      });
    });
  });

  describe('cascadeDeleteFile', () => {
    it('cascades deletion of file and all its owned data', () => {
      // Setup: Create a file with definitions, imports, symbols, and usages
      const file1Id = db.insertFile({
        path: 'source.ts',
        language: 'typescript',
        contentHash: computeHash('source'),
        sizeBytes: 100,
        modifiedAt: new Date().toISOString(),
      });

      const file2Id = db.insertFile({
        path: 'target.ts',
        language: 'typescript',
        contentHash: computeHash('target'),
        sizeBytes: 100,
        modifiedAt: new Date().toISOString(),
      });

      // Create definition in file1
      const def1Id = db.insertDefinition(file1Id, {
        name: 'exportedFunc',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      // Create import from file1 to file2
      const refId = db.insertReference(file1Id, file2Id, {
        type: 'import',
        source: './target',
        isTypeOnly: false,
        isExternal: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      // Create symbol linked to the import
      const symbolId = db.insertSymbol(refId, null, {
        name: 'importedFunc',
        localName: 'importedFunc',
        kind: 'named',
        usages: [],
      });

      // Create usage for the symbol
      db.insertUsage(symbolId, {
        position: { row: 5, column: 10 },
        context: 'call_expression',
      });

      const conn = db.getConnection();

      // Verify initial state
      expect(conn.prepare('SELECT COUNT(*) as count FROM definitions WHERE file_id = ?').get(file1Id)).toMatchObject({
        count: 1,
      });
      expect(conn.prepare('SELECT COUNT(*) as count FROM imports WHERE from_file_id = ?').get(file1Id)).toMatchObject({
        count: 1,
      });
      expect(
        conn
          .prepare(
            'SELECT COUNT(*) as count FROM symbols WHERE reference_id IN (SELECT id FROM imports WHERE from_file_id = ?)'
          )
          .get(file1Id)
      ).toMatchObject({ count: 1 });

      // Execute cascade delete for file1
      cascadeDeleteFile(conn, file1Id);

      // Verify file and all owned data are deleted
      expect(conn.prepare('SELECT COUNT(*) as count FROM files WHERE id = ?').get(file1Id)).toMatchObject({ count: 0 });
      expect(conn.prepare('SELECT COUNT(*) as count FROM definitions WHERE file_id = ?').get(file1Id)).toMatchObject({
        count: 0,
      });
      expect(conn.prepare('SELECT COUNT(*) as count FROM imports WHERE from_file_id = ?').get(file1Id)).toMatchObject({
        count: 0,
      });
      expect(
        conn
          .prepare(
            'SELECT COUNT(*) as count FROM symbols WHERE reference_id IN (SELECT id FROM imports WHERE from_file_id = ?)'
          )
          .get(file1Id)
      ).toMatchObject({ count: 0 });
      expect(conn.prepare('SELECT COUNT(*) as count FROM usages WHERE symbol_id = ?').get(symbolId)).toMatchObject({
        count: 0,
      });

      // Verify file2 still exists
      expect(conn.prepare('SELECT COUNT(*) as count FROM files WHERE id = ?').get(file2Id)).toMatchObject({ count: 1 });
    });

    it('handles file with no definitions', () => {
      const fileId = db.insertFile({
        path: 'empty.ts',
        language: 'typescript',
        contentHash: computeHash(''),
        sizeBytes: 0,
        modifiedAt: new Date().toISOString(),
      });

      const conn = db.getConnection();
      cascadeDeleteFile(conn, fileId);

      expect(conn.prepare('SELECT COUNT(*) as count FROM files WHERE id = ?').get(fileId)).toMatchObject({ count: 0 });
    });
  });

  describe('cleanDanglingSymbolRefs', () => {
    it('nulls orphaned definition_id references and returns count', () => {
      // Setup: Create a file with a definition and symbol
      const fileId = db.insertFile({
        path: 'test.ts',
        language: 'typescript',
        contentHash: computeHash('test'),
        sizeBytes: 50,
        modifiedAt: new Date().toISOString(),
      });

      const defId = db.insertDefinition(fileId, {
        name: 'myFunc',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 1, column: 1 },
      });

      const refId = db.insertReference(fileId, fileId, {
        type: 'import',
        source: './test',
        isTypeOnly: false,
        isExternal: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      db.insertSymbol(refId, defId, {
        name: 'myFunc',
        localName: 'myFunc',
        kind: 'named',
        usages: [],
      });

      const conn = db.getConnection();

      // Manually delete the definition (simulating orphaned reference)
      // Temporarily disable FK constraints to simulate the scenario where FKs are off
      conn.pragma('foreign_keys = OFF');
      conn.prepare('DELETE FROM definitions WHERE id = ?').run(defId);
      conn.pragma('foreign_keys = ON');

      // Verify symbol still references the deleted definition
      const beforeClean = conn.prepare('SELECT definition_id FROM symbols WHERE reference_id = ?').get(refId) as {
        definition_id: number | null;
      };
      expect(beforeClean.definition_id).toBe(defId);

      // Execute cleanup
      const fixedCount = cleanDanglingSymbolRefs(conn);

      // Verify the reference was nulled and count is correct
      expect(fixedCount).toBe(1);
      const afterClean = conn.prepare('SELECT definition_id FROM symbols WHERE reference_id = ?').get(refId) as {
        definition_id: number | null;
      };
      expect(afterClean.definition_id).toBeNull();
    });

    it('returns 0 when there are no dangling references', () => {
      const fileId = db.insertFile({
        path: 'clean.ts',
        language: 'typescript',
        contentHash: computeHash('clean'),
        sizeBytes: 50,
        modifiedAt: new Date().toISOString(),
      });

      const defId = db.insertDefinition(fileId, {
        name: 'validFunc',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 1, column: 1 },
      });

      const refId = db.insertReference(fileId, fileId, {
        type: 'import',
        source: './clean',
        isTypeOnly: false,
        isExternal: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      db.insertSymbol(refId, defId, {
        name: 'validFunc',
        localName: 'validFunc',
        kind: 'named',
        usages: [],
      });

      const conn = db.getConnection();
      const fixedCount = cleanDanglingSymbolRefs(conn);

      expect(fixedCount).toBe(0);
    });

    it('handles multiple dangling references', () => {
      const fileId = db.insertFile({
        path: 'multi-dangling.ts',
        language: 'typescript',
        contentHash: computeHash('multi'),
        sizeBytes: 100,
        modifiedAt: new Date().toISOString(),
      });

      const def1Id = db.insertDefinition(fileId, {
        name: 'func1',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 1, column: 1 },
      });

      const def2Id = db.insertDefinition(fileId, {
        name: 'func2',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 4, column: 1 },
      });

      const ref1Id = db.insertReference(fileId, fileId, {
        type: 'import',
        source: './multi1',
        isTypeOnly: false,
        isExternal: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const ref2Id = db.insertReference(fileId, fileId, {
        type: 'import',
        source: './multi2',
        isTypeOnly: false,
        isExternal: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      db.insertSymbol(ref1Id, def1Id, {
        name: 'func1',
        localName: 'func1',
        kind: 'named',
        usages: [],
      });

      db.insertSymbol(ref2Id, def2Id, {
        name: 'func2',
        localName: 'func2',
        kind: 'named',
        usages: [],
      });

      const conn = db.getConnection();

      // Delete both definitions
      // Temporarily disable FK constraints to simulate the scenario where FKs are off
      conn.pragma('foreign_keys = OFF');
      conn.prepare('DELETE FROM definitions WHERE id IN (?, ?)').run(def1Id, def2Id);
      conn.pragma('foreign_keys = ON');

      // Execute cleanup
      const fixedCount = cleanDanglingSymbolRefs(conn);

      expect(fixedCount).toBe(2);
    });
  });
});
