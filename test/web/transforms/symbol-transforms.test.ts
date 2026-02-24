import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../../src/db/database.js';
import { getSymbolGraph } from '../../../src/web/transforms/symbol-transforms.js';

describe('symbol-transforms', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  function insertFile(filePath: string): number {
    return db.files.insert({
      path: filePath,
      language: 'typescript',
      contentHash: `hash-${filePath}`,
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDefinition(fileId: number, name: string, kind = 'function', lines = 10): number {
    return db.files.insertDefinition(fileId, {
      name,
      kind,
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: lines, column: 1 },
    });
  }

  describe('getSymbolGraph', () => {
    it('returns empty data when database is empty', () => {
      const result = getSymbolGraph(db);

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.stats.totalSymbols).toBe(0);
      expect(result.stats.annotatedSymbols).toBe(0);
      expect(result.stats.totalRelationships).toBe(0);
      expect(result.stats.moduleCount).toBe(0);
    });

    it('returns nodes with basic definition data', () => {
      const fileId = insertFile('/src/utils.ts');
      const defId1 = insertDefinition(fileId, 'helper', 'function', 10);
      const defId2 = insertDefinition(fileId, 'Parser', 'class', 50);

      const result = getSymbolGraph(db);

      expect(result.nodes).toHaveLength(2);

      const helperNode = result.nodes.find((n) => n.id === defId1);
      const parserNode = result.nodes.find((n) => n.id === defId2);

      expect(helperNode?.name).toBe('helper');
      expect(helperNode?.kind).toBe('function');
      expect(helperNode?.filePath).toBe('/src/utils.ts');
      expect(helperNode?.lines).toBe(11); // endLine - line + 1
      expect(helperNode?.hasAnnotations).toBe(false);

      expect(parserNode?.name).toBe('Parser');
      expect(parserNode?.kind).toBe('class');
      expect(parserNode?.lines).toBe(51);
    });

    it('includes relationship annotations as edges', () => {
      const fileId = insertFile('/src/test.ts');
      const defId1 = insertDefinition(fileId, 'func1');
      const defId2 = insertDefinition(fileId, 'func2');
      const defId3 = insertDefinition(fileId, 'func3');

      db.relationships.set(defId1, defId2, 'calls for validation', 'uses');
      db.relationships.set(defId2, defId3, 'delegates to func3', 'uses');

      const result = getSymbolGraph(db);

      expect(result.edges).toHaveLength(2);
      expect(result.edges[0].source).toBe(defId1);
      expect(result.edges[0].target).toBe(defId2);
      expect(result.edges[0].semantic).toBe('calls for validation');
      expect(result.edges[0].type).toBe('uses');

      expect(result.edges[1].source).toBe(defId2);
      expect(result.edges[1].target).toBe(defId3);
      expect(result.edges[1].semantic).toBe('delegates to func3');

      expect(result.stats.totalRelationships).toBe(2);
      expect(result.stats.annotatedSymbols).toBe(3);
    });

    it('marks nodes with relationships as annotated', () => {
      const fileId = insertFile('/src/test.ts');
      const defId1 = insertDefinition(fileId, 'annotated1');
      const defId2 = insertDefinition(fileId, 'annotated2');
      const defId3 = insertDefinition(fileId, 'notAnnotated');

      db.relationships.set(defId1, defId2, 'test', 'uses');

      const result = getSymbolGraph(db);

      const node1 = result.nodes.find((n) => n.id === defId1);
      const node2 = result.nodes.find((n) => n.id === defId2);
      const node3 = result.nodes.find((n) => n.id === defId3);

      expect(node1?.hasAnnotations).toBe(true);
      expect(node2?.hasAnnotations).toBe(true);
      expect(node3?.hasAnnotations).toBe(false);
    });

    it('includes metadata in nodes', () => {
      const fileId = insertFile('/src/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');

      db.metadata.set(defId, 'purpose', 'Validates user input');
      db.metadata.set(defId, 'pure', 'true');

      const result = getSymbolGraph(db);

      expect(result.nodes[0].purpose).toBe('Validates user input');
      expect(result.nodes[0].pure).toBe(true);
    });

    it('parses domain metadata as JSON array', () => {
      const fileId = insertFile('/src/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');

      db.metadata.set(defId, 'domain', '["auth", "validation"]');

      const result = getSymbolGraph(db);

      expect(result.nodes[0].domain).toEqual(['auth', 'validation']);
    });

    it('handles domain metadata as plain string when not JSON', () => {
      const fileId = insertFile('/src/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');

      db.metadata.set(defId, 'domain', 'auth');

      const result = getSymbolGraph(db);

      expect(result.nodes[0].domain).toEqual(['auth']);
    });

    it('includes module membership in nodes', () => {
      const fileId = insertFile('/src/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');

      const rootId = db.modules.ensureRoot();
      const moduleId = db.modules.insert(rootId, 'auth', 'Authentication');
      db.modules.assignSymbol(defId, moduleId);

      const result = getSymbolGraph(db);

      expect(result.nodes[0].moduleId).toBe(moduleId);
      expect(result.nodes[0].moduleName).toBe('Authentication');
      expect(result.stats.moduleCount).toBeGreaterThan(0);
    });

    it('handles nodes without metadata', () => {
      const fileId = insertFile('/src/test.ts');
      insertDefinition(fileId, 'myFunc');

      const result = getSymbolGraph(db);

      expect(result.nodes[0].purpose).toBeUndefined();
      expect(result.nodes[0].domain).toBeUndefined();
      expect(result.nodes[0].pure).toBeUndefined();
    });

    it('handles nodes without modules', () => {
      const fileId = insertFile('/src/test.ts');
      insertDefinition(fileId, 'myFunc');

      const result = getSymbolGraph(db);

      expect(result.nodes[0].moduleId).toBeUndefined();
      expect(result.nodes[0].moduleName).toBeUndefined();
    });

    it('correctly counts stats with mixed data', () => {
      const fileId = insertFile('/src/test.ts');
      const defId1 = insertDefinition(fileId, 'func1');
      const defId2 = insertDefinition(fileId, 'func2');
      const defId3 = insertDefinition(fileId, 'func3');

      db.relationships.set(defId1, defId2, 'test', 'uses');
      db.metadata.set(defId1, 'purpose', 'test');

      const rootId = db.modules.ensureRoot();
      db.modules.insert(rootId, 'auth', 'Auth');

      const result = getSymbolGraph(db);

      expect(result.stats.totalSymbols).toBe(3);
      expect(result.stats.annotatedSymbols).toBe(2); // defId1 and defId2 have relationship
      expect(result.stats.totalRelationships).toBe(1);
      expect(result.stats.moduleCount).toBeGreaterThan(0);
    });

    it('handles multiple files correctly', () => {
      const fileId1 = insertFile('/src/a.ts');
      const fileId2 = insertFile('/src/b.ts');
      insertDefinition(fileId1, 'funcA');
      insertDefinition(fileId2, 'funcB');

      const result = getSymbolGraph(db);

      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0].filePath).toBe('/src/a.ts');
      expect(result.nodes[1].filePath).toBe('/src/b.ts');
    });

    it('handles relationship types correctly', () => {
      const fileId = insertFile('/src/test.ts');
      const defId1 = insertDefinition(fileId, 'Child', 'class');
      const defId2 = insertDefinition(fileId, 'Parent', 'class');

      db.relationships.set(defId1, defId2, 'inherits from Parent', 'extends');

      const result = getSymbolGraph(db);

      expect(result.edges[0].type).toBe('extends');
      expect(result.edges[0].semantic).toBe('inherits from Parent');
    });

    it('handles pure metadata as false', () => {
      const fileId = insertFile('/src/test.ts');
      const defId = insertDefinition(fileId, 'myFunc');

      db.metadata.set(defId, 'pure', 'false');

      const result = getSymbolGraph(db);

      expect(result.nodes[0].pure).toBe(false);
    });

    it('handles large numbers of relationships', () => {
      const fileId = insertFile('/src/test.ts');
      const defIds: number[] = [];
      for (let i = 0; i < 20; i++) {
        defIds.push(insertDefinition(fileId, `func${i}`));
      }

      // Create chain of relationships
      for (let i = 0; i < defIds.length - 1; i++) {
        db.relationships.set(defIds[i], defIds[i + 1], `calls func${i + 1}`, 'uses');
      }

      const result = getSymbolGraph(db);

      expect(result.nodes).toHaveLength(20);
      expect(result.edges).toHaveLength(19);
      expect(result.stats.totalRelationships).toBe(19);
      expect(result.stats.annotatedSymbols).toBe(20);
    });
  });
});
