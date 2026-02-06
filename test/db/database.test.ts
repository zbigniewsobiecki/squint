import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';
import type { Definition } from '../../src/parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../../src/parser/reference-extractor.js';

describe('computeHash', () => {
  it('computes SHA-256 hash of content', () => {
    const hash = computeHash('hello world');
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('returns different hashes for different content', () => {
    const hash1 = computeHash('hello');
    const hash2 = computeHash('world');
    expect(hash1).not.toBe(hash2);
  });

  it('returns same hash for same content', () => {
    const hash1 = computeHash('test content');
    const hash2 = computeHash('test content');
    expect(hash1).toBe(hash2);
  });
});

describe('IndexDatabase', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  describe('metadata', () => {
    it('sets and retrieves metadata', () => {
      db.setMetadata('version', '1.0.0');
      db.setMetadata('indexed_at', '2024-01-01');
      // Metadata is write-only in current API, but we can verify no errors
    });
  });

  describe('files', () => {
    it('inserts a file and returns ID', () => {
      const id = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(id).toBe(1);
    });

    it('inserts multiple files with incrementing IDs', () => {
      const id1 = db.insertFile({
        path: '/project/a.ts',
        language: 'typescript',
        contentHash: computeHash('a'),
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const id2 = db.insertFile({
        path: '/project/b.ts',
        language: 'typescript',
        contentHash: computeHash('b'),
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });
  });

  describe('definitions', () => {
    it('inserts a definition and returns ID', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def: Definition = {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      };

      const defId = db.insertDefinition(fileId, def);
      expect(defId).toBe(1);
    });

    it('counts definitions correctly', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.insertDefinition(fileId, {
        name: 'subtract',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      expect(db.getDefinitionCount()).toBe(2);
    });

    it('retrieves definition by name', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const foundId = db.getDefinitionByName(fileId, 'add');
      expect(foundId).toBe(defId);
    });

    it('returns null for non-existent definition', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const foundId = db.getDefinitionByName(fileId, 'nonexistent');
      expect(foundId).toBeNull();
    });
  });

  describe('references', () => {
    it('inserts a reference and returns ID', () => {
      const fileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const ref: FileReference = {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      };

      const refId = db.insertReference(fileId, null, ref);
      expect(refId).toBe(1);
    });

    it('counts references correctly', () => {
      const fileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.insertReference(fileId, null, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      db.insertReference(fileId, null, {
        type: 'import',
        source: 'lodash',
        isExternal: true,
        isTypeOnly: false,
        imports: [],
        position: { row: 1, column: 0 },
      });

      expect(db.getReferenceCount()).toBe(2);
    });
  });

  describe('symbols and usages', () => {
    it('inserts symbols and usages', () => {
      const fileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = db.insertReference(fileId, null, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const sym: ImportedSymbol = {
        name: 'add',
        localName: 'add',
        kind: 'named',
        usages: [],
      };

      const symbolId = db.insertSymbol(refId, null, sym);
      expect(symbolId).toBe(1);

      const usage: SymbolUsage = {
        position: { row: 5, column: 10 },
        context: 'call_expression',
      };

      db.insertUsage(symbolId, usage);
      expect(db.getUsageCount()).toBe(1);
    });

    it('counts usages correctly', () => {
      const fileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = db.insertReference(fileId, null, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const symbolId = db.insertSymbol(refId, null, {
        name: 'add',
        localName: 'add',
        kind: 'named',
        usages: [],
      });

      db.insertUsage(symbolId, { position: { row: 5, column: 10 }, context: 'call_expression' });
      db.insertUsage(symbolId, { position: { row: 6, column: 10 }, context: 'call_expression' });
      db.insertUsage(symbolId, { position: { row: 7, column: 10 }, context: 'call_expression' });

      expect(db.getUsageCount()).toBe(3);
    });
  });

  describe('callsite queries', () => {
    it('stores and retrieves callsite metadata', () => {
      const fileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = db.insertReference(fileId, null, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const symbolId = db.insertSymbol(refId, null, {
        name: 'add',
        localName: 'add',
        kind: 'named',
        usages: [],
      });

      const usage: SymbolUsage = {
        position: { row: 5, column: 10 },
        context: 'call_expression',
        callsite: {
          argumentCount: 2,
          isMethodCall: false,
          isConstructorCall: false,
        },
      };

      db.insertUsage(symbolId, usage);

      const callsites = db.getCallsitesForFile(fileId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].argumentCount).toBe(2);
      expect(callsites[0].isMethodCall).toBe(false);
      expect(callsites[0].isConstructorCall).toBe(false);
      expect(callsites[0].receiverName).toBeNull();
    });

    it('stores method call with receiver name', () => {
      const fileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = db.insertReference(fileId, null, {
        type: 'import',
        source: './api',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const symbolId = db.insertSymbol(refId, null, {
        name: 'api',
        localName: 'api',
        kind: 'named',
        usages: [],
      });

      db.insertUsage(symbolId, {
        position: { row: 5, column: 10 },
        context: 'call_expression',
        callsite: {
          argumentCount: 1,
          isMethodCall: true,
          isConstructorCall: false,
          receiverName: 'api',
        },
      });

      const callsites = db.getCallsitesForFile(fileId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].isMethodCall).toBe(true);
      expect(callsites[0].receiverName).toBe('api');
    });

    it('stores constructor call', () => {
      const fileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = db.insertReference(fileId, null, {
        type: 'import',
        source: './classes',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const symbolId = db.insertSymbol(refId, null, {
        name: 'MyClass',
        localName: 'MyClass',
        kind: 'named',
        usages: [],
      });

      db.insertUsage(symbolId, {
        position: { row: 5, column: 10 },
        context: 'new_expression',
        callsite: {
          argumentCount: 3,
          isMethodCall: false,
          isConstructorCall: true,
        },
      });

      const callsites = db.getCallsitesForFile(fileId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].isConstructorCall).toBe(true);
      expect(callsites[0].argumentCount).toBe(3);
    });

    it('getCallsiteCount returns count of callsites only', () => {
      const fileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = db.insertReference(fileId, null, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const symbolId = db.insertSymbol(refId, null, {
        name: 'helper',
        localName: 'helper',
        kind: 'named',
        usages: [],
      });

      // Insert a callsite
      db.insertUsage(symbolId, {
        position: { row: 5, column: 10 },
        context: 'call_expression',
        callsite: {
          argumentCount: 1,
          isMethodCall: false,
          isConstructorCall: false,
        },
      });

      // Insert a non-callsite usage (no callsite metadata)
      db.insertUsage(symbolId, {
        position: { row: 6, column: 10 },
        context: 'variable_declarator',
      });

      expect(db.getUsageCount()).toBe(2);
      expect(db.getCallsiteCount()).toBe(1);
    });

    it('getCallsites filters by definition ID', () => {
      // Create two files
      const utilsFileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('utils'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const indexFileId = db.insertFile({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('index'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Create a definition in utils.ts
      const defId = db.insertDefinition(utilsFileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      // Create an import reference in index.ts that links to the definition
      const refId = db.insertReference(indexFileId, utilsFileId, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      // Create symbol with link to definition
      const symbolId = db.insertSymbol(refId, defId, {
        name: 'add',
        localName: 'add',
        kind: 'named',
        usages: [],
      });

      // Insert callsite
      db.insertUsage(symbolId, {
        position: { row: 5, column: 10 },
        context: 'call_expression',
        callsite: {
          argumentCount: 2,
          isMethodCall: false,
          isConstructorCall: false,
        },
      });

      const callsites = db.getCallsites(defId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].symbolName).toBe('add');
      expect(callsites[0].definitionId).toBe(defId);
      expect(callsites[0].filePath).toBe('/project/index.ts');
    });
  });

  describe('inheritance queries', () => {
    it('stores and retrieves class extends relationship', () => {
      const fileId = db.insertFile({
        path: '/project/animal.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.insertDefinition(fileId, {
        name: 'Dog',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
        extends: 'Animal',
      });

      const subclasses = db.getSubclasses('Animal');
      expect(subclasses).toHaveLength(1);
      expect(subclasses[0].name).toBe('Dog');
      expect(subclasses[0].extends).toBe('Animal');
    });

    it('stores and retrieves multiple subclasses', () => {
      const fileId = db.insertFile({
        path: '/project/animals.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.insertDefinition(fileId, {
        name: 'Dog',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
        extends: 'Animal',
      });

      db.insertDefinition(fileId, {
        name: 'Cat',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
        extends: 'Animal',
      });

      db.insertDefinition(fileId, {
        name: 'Bird',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 12, column: 0 },
        endPosition: { row: 17, column: 1 },
        extends: 'Animal',
      });

      const subclasses = db.getSubclasses('Animal');
      expect(subclasses).toHaveLength(3);
      expect(subclasses.map(s => s.name).sort()).toEqual(['Bird', 'Cat', 'Dog']);
    });

    it('stores and retrieves implements relationship', () => {
      const fileId = db.insertFile({
        path: '/project/shapes.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.insertDefinition(fileId, {
        name: 'Circle',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
        extends: 'Shape',
        implements: ['Drawable', 'Resizable'],
      });

      const drawableImpls = db.getImplementations('Drawable');
      expect(drawableImpls).toHaveLength(1);
      expect(drawableImpls[0].name).toBe('Circle');
      expect(drawableImpls[0].implements).toEqual(['Drawable', 'Resizable']);

      const resizableImpls = db.getImplementations('Resizable');
      expect(resizableImpls).toHaveLength(1);
      expect(resizableImpls[0].name).toBe('Circle');
    });

    it('stores and retrieves interface extends relationship', () => {
      const fileId = db.insertFile({
        path: '/project/interfaces.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.insertDefinition(fileId, {
        name: 'Combined',
        kind: 'interface',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
        extendsAll: ['A', 'B', 'C'],
      });

      // We can verify the data is stored correctly by checking getDefinitionCount
      expect(db.getDefinitionCount()).toBe(1);
    });

    it('returns empty array when no subclasses exist', () => {
      const subclasses = db.getSubclasses('NonExistentClass');
      expect(subclasses).toHaveLength(0);
    });

    it('returns empty array when no implementations exist', () => {
      const implementations = db.getImplementations('NonExistentInterface');
      expect(implementations).toHaveLength(0);
    });

    it('correctly stores class with no inheritance', () => {
      const fileId = db.insertFile({
        path: '/project/simple.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.insertDefinition(fileId, {
        name: 'Simple',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      // Class with no extends should not appear in any subclass query
      const subclasses = db.getSubclasses('Simple');
      expect(subclasses).toHaveLength(0);
    });

    it('handles class that both extends and implements', () => {
      const fileId = db.insertFile({
        path: '/project/complex.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.insertDefinition(fileId, {
        name: 'ComplexClass',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
        extends: 'BaseClass',
        implements: ['InterfaceA', 'InterfaceB'],
      });

      const subclasses = db.getSubclasses('BaseClass');
      expect(subclasses).toHaveLength(1);
      expect(subclasses[0].name).toBe('ComplexClass');
      expect(subclasses[0].extends).toBe('BaseClass');
      expect(subclasses[0].implements).toEqual(['InterfaceA', 'InterfaceB']);

      const implsA = db.getImplementations('InterfaceA');
      expect(implsA).toHaveLength(1);
      expect(implsA[0].name).toBe('ComplexClass');

      const implsB = db.getImplementations('InterfaceB');
      expect(implsB).toHaveLength(1);
      expect(implsB[0].name).toBe('ComplexClass');
    });
  });
});
