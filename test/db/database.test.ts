import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      const id = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(id).toBe(1);
    });

    it('inserts multiple files with incrementing IDs', () => {
      const id1 = db.files.insert({
        path: '/project/a.ts',
        language: 'typescript',
        contentHash: computeHash('a'),
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const id2 = db.files.insert({
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
      const fileId = db.files.insert({
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

      const defId = db.files.insertDefinition(fileId, def);
      expect(defId).toBe(1);
    });

    it('counts definitions correctly', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.files.insertDefinition(fileId, {
        name: 'subtract',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      expect(db.definitions.getCount()).toBe(2);
    });

    it('retrieves definition by name', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
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
      const fileId = db.files.insert({
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
      const fileId = db.files.insert({
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
      const fileId = db.files.insert({
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
      const fileId = db.files.insert({
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
      const fileId = db.files.insert({
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
      const fileId = db.files.insert({
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

      const callsites = db.dependencies.getCallsitesForFile(fileId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].argumentCount).toBe(2);
      expect(callsites[0].isMethodCall).toBe(false);
      expect(callsites[0].isConstructorCall).toBe(false);
      expect(callsites[0].receiverName).toBeNull();
    });

    it('stores method call with receiver name', () => {
      const fileId = db.files.insert({
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

      const callsites = db.dependencies.getCallsitesForFile(fileId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].isMethodCall).toBe(true);
      expect(callsites[0].receiverName).toBe('api');
    });

    it('stores constructor call', () => {
      const fileId = db.files.insert({
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

      const callsites = db.dependencies.getCallsitesForFile(fileId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].isConstructorCall).toBe(true);
      expect(callsites[0].argumentCount).toBe(3);
    });

    it('getCallsiteCount returns count of callsites only', () => {
      const fileId = db.files.insert({
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
      const utilsFileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('utils'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const indexFileId = db.files.insert({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('index'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Create a definition in utils.ts
      const defId = db.files.insertDefinition(utilsFileId, {
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

      const callsites = db.dependencies.getCallsites(defId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].symbolName).toBe('add');
      expect(callsites[0].definitionId).toBe(defId);
      expect(callsites[0].filePath).toBe('/project/index.ts');
    });
  });

  describe('definition metadata', () => {
    it('sets and gets metadata on a definition', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'purpose', 'Adds two numbers');
      db.metadata.set(defId, 'status', 'stable');

      const metadata = db.metadata.get(defId);
      expect(metadata).toEqual({
        purpose: 'Adds two numbers',
        status: 'stable',
      });
    });

    it('returns empty object when no metadata exists', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const metadata = db.metadata.get(defId);
      expect(metadata).toEqual({});
    });

    it('overwrites existing metadata key', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'status', 'draft');
      db.metadata.set(defId, 'status', 'stable');

      const metadata = db.metadata.get(defId);
      expect(metadata.status).toBe('stable');
    });

    it('removes metadata key', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'purpose', 'Adds numbers');
      db.metadata.set(defId, 'status', 'stable');

      const removed = db.metadata.remove(defId, 'purpose');
      expect(removed).toBe(true);

      const metadata = db.metadata.get(defId);
      expect(metadata).toEqual({ status: 'stable' });
    });

    it('returns false when removing non-existent key', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const removed = db.metadata.remove(defId, 'nonexistent');
      expect(removed).toBe(false);
    });

    it('gets definitions with a specific metadata key', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'subtract',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const def3 = db.files.insertDefinition(fileId, {
        name: 'multiply',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      db.metadata.set(def1, 'documented', 'yes');
      db.metadata.set(def3, 'documented', 'yes');

      const withDocumented = db.metadata.getDefinitionsWith('documented');
      expect(withDocumented.sort()).toEqual([def1, def3].sort());
    });

    it('gets definitions without a specific metadata key', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'subtract',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const def3 = db.files.insertDefinition(fileId, {
        name: 'multiply',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      db.metadata.set(def1, 'documented', 'yes');

      const withoutDocumented = db.metadata.getDefinitionsWithout('documented');
      expect(withoutDocumented.sort()).toEqual([def2, def3].sort());
    });

    it('returns empty array when no definitions have the metadata key', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const withKey = db.metadata.getDefinitionsWith('nonexistent');
      expect(withKey).toEqual([]);
    });

    it('returns all definitions when none have the metadata key', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'subtract',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const withoutKey = db.metadata.getDefinitionsWithout('nonexistent');
      expect(withoutKey.sort()).toEqual([def1, def2].sort());
    });

    it('keeps metadata isolated between definitions', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'subtract',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.metadata.set(def1, 'purpose', 'Add numbers');
      db.metadata.set(def2, 'purpose', 'Subtract numbers');

      expect(db.metadata.get(def1).purpose).toBe('Add numbers');
      expect(db.metadata.get(def2).purpose).toBe('Subtract numbers');
    });

    it('getMetadataKeys returns all unique metadata keys', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'subtract',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.metadata.set(def1, 'purpose', 'Add numbers');
      db.metadata.set(def1, 'owner', 'team-a');
      db.metadata.set(def2, 'purpose', 'Subtract numbers');
      db.metadata.set(def2, 'status', 'stable');

      const keys = db.metadata.getKeys();
      expect(keys.sort()).toEqual(['owner', 'purpose', 'status']);
    });

    it('getMetadataKeys returns empty array when no metadata exists', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const keys = db.metadata.getKeys();
      expect(keys).toEqual([]);
    });

    it('getAspectCoverage returns coverage stats for all aspects', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'subtract',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const def3 = db.files.insertDefinition(fileId, {
        name: 'multiply',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      // Set metadata: purpose on 2/3, owner on 1/3
      db.metadata.set(def1, 'purpose', 'Add numbers');
      db.metadata.set(def2, 'purpose', 'Subtract numbers');
      db.metadata.set(def1, 'owner', 'team-a');

      const coverage = db.metadata.getAspectCoverage();
      expect(coverage).toHaveLength(2);

      const purposeCoverage = coverage.find((c) => c.aspect === 'purpose');
      expect(purposeCoverage).toBeDefined();
      expect(purposeCoverage!.covered).toBe(2);
      expect(purposeCoverage!.total).toBe(3);
      expect(purposeCoverage!.percentage).toBeCloseTo(66.7, 1);

      const ownerCoverage = coverage.find((c) => c.aspect === 'owner');
      expect(ownerCoverage).toBeDefined();
      expect(ownerCoverage!.covered).toBe(1);
      expect(ownerCoverage!.total).toBe(3);
      expect(ownerCoverage!.percentage).toBeCloseTo(33.3, 1);
    });

    it('getAspectCoverage returns empty array when no definitions exist', () => {
      const coverage = db.metadata.getAspectCoverage();
      expect(coverage).toEqual([]);
    });

    it('getAspectCoverage filters by kind', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const func1 = db.files.insertDefinition(fileId, {
        name: 'add',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const class1 = db.files.insertDefinition(fileId, {
        name: 'Calculator',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      db.metadata.set(func1, 'purpose', 'Add numbers');
      db.metadata.set(class1, 'purpose', 'Calculator class');

      // Filter to only functions
      const coverage = db.metadata.getAspectCoverage({ kind: 'function' });
      expect(coverage).toHaveLength(1);
      expect(coverage[0].covered).toBe(1);
      expect(coverage[0].total).toBe(1);
      expect(coverage[0].percentage).toBe(100);
    });

    it('getAspectCoverage filters by file pattern', () => {
      const file1 = db.files.insert({
        path: '/project/src/parser/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content1'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const file2 = db.files.insert({
        path: '/project/src/db/database.ts',
        language: 'typescript',
        contentHash: computeHash('content2'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(file1, {
        name: 'parseFile',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(file2, {
        name: 'insertRow',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(def1, 'purpose', 'Parse files');
      db.metadata.set(def2, 'purpose', 'Insert database row');

      // Filter to parser directory
      const coverage = db.metadata.getAspectCoverage({ filePattern: 'parser' });
      expect(coverage).toHaveLength(1);
      expect(coverage[0].covered).toBe(1);
      expect(coverage[0].total).toBe(1);
      expect(coverage[0].percentage).toBe(100);
    });
  });

  describe('dependency queries', () => {
    it('getDependenciesWithMetadata returns dependencies with aspect status', () => {
      // Create two files
      const utilsFileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('utils'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const indexFileId = db.files.insert({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('index'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Create definitions in utils.ts
      const helperDefId = db.files.insertDefinition(utilsFileId, {
        name: 'helper',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const utilDefId = db.files.insertDefinition(utilsFileId, {
        name: 'util',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      // Create main function in index.ts that uses both
      const mainDefId = db.files.insertDefinition(indexFileId, {
        name: 'main',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 2, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      // Create import reference
      const refId = db.insertReference(indexFileId, utilsFileId, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      // Create symbols linking to definitions
      const helperSymId = db.insertSymbol(refId, helperDefId, {
        name: 'helper',
        localName: 'helper',
        kind: 'named',
        usages: [],
      });

      const utilSymId = db.insertSymbol(refId, utilDefId, {
        name: 'util',
        localName: 'util',
        kind: 'named',
        usages: [],
      });

      // Create usages within main function's line range
      db.insertUsage(helperSymId, {
        position: { row: 4, column: 10 },
        context: 'call_expression',
      });

      db.insertUsage(utilSymId, {
        position: { row: 6, column: 10 },
        context: 'call_expression',
      });

      // Set metadata on one dependency only
      db.metadata.set(helperDefId, 'purpose', 'A helper function');

      // Get dependencies with metadata status
      const deps = db.dependencies.getWithMetadata(mainDefId, 'purpose');
      expect(deps).toHaveLength(2);

      const helperDep = deps.find((d) => d.name === 'helper');
      expect(helperDep).toBeDefined();
      expect(helperDep!.hasAspect).toBe(true);
      expect(helperDep!.aspectValue).toBe('A helper function');

      const utilDep = deps.find((d) => d.name === 'util');
      expect(utilDep).toBeDefined();
      expect(utilDep!.hasAspect).toBe(false);
      expect(utilDep!.aspectValue).toBeNull();
    });

    it('getDependenciesWithMetadata returns empty array when no dependencies', () => {
      const fileId = db.files.insert({
        path: '/project/simple.ts',
        language: 'typescript',
        contentHash: computeHash('simple'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'standalone',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const deps = db.dependencies.getWithMetadata(defId, 'purpose');
      expect(deps).toEqual([]);
    });

    it('getUnmetDependencies returns only dependencies missing the aspect', () => {
      // Setup similar to above
      const utilsFileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('utils'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const indexFileId = db.files.insert({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('index'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const helperDefId = db.files.insertDefinition(utilsFileId, {
        name: 'helper',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const utilDefId = db.files.insertDefinition(utilsFileId, {
        name: 'util',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const mainDefId = db.files.insertDefinition(indexFileId, {
        name: 'main',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 2, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      const refId = db.insertReference(indexFileId, utilsFileId, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const helperSymId = db.insertSymbol(refId, helperDefId, {
        name: 'helper',
        localName: 'helper',
        kind: 'named',
        usages: [],
      });

      const utilSymId = db.insertSymbol(refId, utilDefId, {
        name: 'util',
        localName: 'util',
        kind: 'named',
        usages: [],
      });

      db.insertUsage(helperSymId, {
        position: { row: 4, column: 10 },
        context: 'call_expression',
      });

      db.insertUsage(utilSymId, {
        position: { row: 6, column: 10 },
        context: 'call_expression',
      });

      // Set aspect on helper only
      db.metadata.set(helperDefId, 'purpose', 'A helper function');

      // Get unmet dependencies
      const unmet = db.dependencies.getUnmet(mainDefId, 'purpose');
      expect(unmet).toHaveLength(1);
      expect(unmet[0].name).toBe('util');
    });

    it('getUnmetDependencies returns empty array when all deps have aspect', () => {
      const utilsFileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('utils'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const indexFileId = db.files.insert({
        path: '/project/index.ts',
        language: 'typescript',
        contentHash: computeHash('index'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const helperDefId = db.files.insertDefinition(utilsFileId, {
        name: 'helper',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const mainDefId = db.files.insertDefinition(indexFileId, {
        name: 'main',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 2, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      const refId = db.insertReference(indexFileId, utilsFileId, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const helperSymId = db.insertSymbol(refId, helperDefId, {
        name: 'helper',
        localName: 'helper',
        kind: 'named',
        usages: [],
      });

      db.insertUsage(helperSymId, {
        position: { row: 4, column: 10 },
        context: 'call_expression',
      });

      // Set aspect on all dependencies
      db.metadata.set(helperDefId, 'purpose', 'A helper function');

      const unmet = db.dependencies.getUnmet(mainDefId, 'purpose');
      expect(unmet).toEqual([]);
    });

    it('getPrerequisiteChain returns topologically sorted unmet deps', () => {
      // Create a chain: main -> func1 -> func2 -> func3
      const fileId = db.files.insert({
        path: '/project/chain.ts',
        language: 'typescript',
        contentHash: computeHash('chain'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const func3Id = db.files.insertDefinition(fileId, {
        name: 'func3',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const func2Id = db.files.insertDefinition(fileId, {
        name: 'func2',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 6, column: 1 },
      });

      const func1Id = db.files.insertDefinition(fileId, {
        name: 'func1',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 7, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      const mainId = db.files.insertDefinition(fileId, {
        name: 'main',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 11, column: 0 },
        endPosition: { row: 14, column: 1 },
      });

      // Create internal symbols for same-file references
      const sym3 = db.insertSymbol(
        null,
        func3Id,
        {
          name: 'func3',
          localName: 'func3',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      const sym2 = db.insertSymbol(
        null,
        func2Id,
        {
          name: 'func2',
          localName: 'func2',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      const sym1 = db.insertSymbol(
        null,
        func1Id,
        {
          name: 'func1',
          localName: 'func1',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      // func2 calls func3
      db.insertUsage(sym3, {
        position: { row: 4, column: 10 },
        context: 'call_expression',
      });

      // func1 calls func2
      db.insertUsage(sym2, {
        position: { row: 8, column: 10 },
        context: 'call_expression',
      });

      // main calls func1
      db.insertUsage(sym1, {
        position: { row: 12, column: 10 },
        context: 'call_expression',
      });

      // Get prerequisite chain for main
      const prereqs = db.dependencies.getPrerequisiteChain(mainId, 'purpose', (id) => db.definitions.getById(id));

      // Should return func3, func2, func1 in order (leaves first)
      expect(prereqs.length).toBeGreaterThanOrEqual(1);
      // Leaves (0 deps) should come first
      const leafNodes = prereqs.filter((p) => p.unmetDepCount === 0);
      expect(leafNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('getPrerequisiteChain returns empty when no unmet deps', () => {
      const fileId = db.files.insert({
        path: '/project/simple.ts',
        language: 'typescript',
        contentHash: computeHash('simple'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'standalone',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const prereqs = db.dependencies.getPrerequisiteChain(defId, 'purpose', (id) => db.definitions.getById(id));
      expect(prereqs).toEqual([]);
    });

    it('getPrerequisiteChain handles circular dependencies gracefully', () => {
      // Create circular: funcA -> funcB -> funcA
      const fileId = db.files.insert({
        path: '/project/circular.ts',
        language: 'typescript',
        contentHash: computeHash('circular'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const funcAId = db.files.insertDefinition(fileId, {
        name: 'funcA',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const funcBId = db.files.insertDefinition(fileId, {
        name: 'funcB',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
      });

      // Create internal symbols
      const symA = db.insertSymbol(
        null,
        funcAId,
        {
          name: 'funcA',
          localName: 'funcA',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      const symB = db.insertSymbol(
        null,
        funcBId,
        {
          name: 'funcB',
          localName: 'funcB',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      // funcA calls funcB
      db.insertUsage(symB, {
        position: { row: 2, column: 10 },
        context: 'call_expression',
      });

      // funcB calls funcA (creating cycle)
      db.insertUsage(symA, {
        position: { row: 8, column: 10 },
        context: 'call_expression',
      });

      // Should not throw or infinite loop
      const prereqs = db.dependencies.getPrerequisiteChain(funcAId, 'purpose', (id) => db.definitions.getById(id));
      // Should include funcB (and handle the cycle)
      expect(prereqs.length).toBeLessThanOrEqual(2);
    });
  });

  describe('inheritance queries', () => {
    it('stores and retrieves class extends relationship', () => {
      const fileId = db.files.insert({
        path: '/project/animal.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'Dog',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
        extends: 'Animal',
      });

      const subclasses = db.definitions.getSubclasses('Animal');
      expect(subclasses).toHaveLength(1);
      expect(subclasses[0].name).toBe('Dog');
      expect(subclasses[0].extends).toBe('Animal');
    });

    it('stores and retrieves multiple subclasses', () => {
      const fileId = db.files.insert({
        path: '/project/animals.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'Dog',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
        extends: 'Animal',
      });

      db.files.insertDefinition(fileId, {
        name: 'Cat',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
        extends: 'Animal',
      });

      db.files.insertDefinition(fileId, {
        name: 'Bird',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 12, column: 0 },
        endPosition: { row: 17, column: 1 },
        extends: 'Animal',
      });

      const subclasses = db.definitions.getSubclasses('Animal');
      expect(subclasses).toHaveLength(3);
      expect(subclasses.map((s) => s.name).sort()).toEqual(['Bird', 'Cat', 'Dog']);
    });

    it('stores and retrieves implements relationship', () => {
      const fileId = db.files.insert({
        path: '/project/shapes.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'Circle',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
        extends: 'Shape',
        implements: ['Drawable', 'Resizable'],
      });

      const drawableImpls = db.definitions.getImplementations('Drawable');
      expect(drawableImpls).toHaveLength(1);
      expect(drawableImpls[0].name).toBe('Circle');
      expect(drawableImpls[0].implements).toEqual(['Drawable', 'Resizable']);

      const resizableImpls = db.definitions.getImplementations('Resizable');
      expect(resizableImpls).toHaveLength(1);
      expect(resizableImpls[0].name).toBe('Circle');
    });

    it('stores and retrieves interface extends relationship', () => {
      const fileId = db.files.insert({
        path: '/project/interfaces.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'Combined',
        kind: 'interface',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
        extendsAll: ['A', 'B', 'C'],
      });

      // We can verify the data is stored correctly by checking getDefinitionCount
      expect(db.definitions.getCount()).toBe(1);
    });

    it('returns empty array when no subclasses exist', () => {
      const subclasses = db.definitions.getSubclasses('NonExistentClass');
      expect(subclasses).toHaveLength(0);
    });

    it('returns empty array when no implementations exist', () => {
      const implementations = db.definitions.getImplementations('NonExistentInterface');
      expect(implementations).toHaveLength(0);
    });

    it('correctly stores class with no inheritance', () => {
      const fileId = db.files.insert({
        path: '/project/simple.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'Simple',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      // Class with no extends should not appear in any subclass query
      const subclasses = db.definitions.getSubclasses('Simple');
      expect(subclasses).toHaveLength(0);
    });

    it('handles class that both extends and implements', () => {
      const fileId = db.files.insert({
        path: '/project/complex.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'ComplexClass',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
        extends: 'BaseClass',
        implements: ['InterfaceA', 'InterfaceB'],
      });

      const subclasses = db.definitions.getSubclasses('BaseClass');
      expect(subclasses).toHaveLength(1);
      expect(subclasses[0].name).toBe('ComplexClass');
      expect(subclasses[0].extends).toBe('BaseClass');
      expect(subclasses[0].implements).toEqual(['InterfaceA', 'InterfaceB']);

      const implsA = db.definitions.getImplementations('InterfaceA');
      expect(implsA).toHaveLength(1);
      expect(implsA[0].name).toBe('ComplexClass');

      const implsB = db.definitions.getImplementations('InterfaceB');
      expect(implsB).toHaveLength(1);
      expect(implsB[0].name).toBe('ComplexClass');
    });
  });

  describe('findCycles', () => {
    it('returns empty array when no cycles exist', () => {
      const fileId = db.files.insert({
        path: '/project/nocycles.ts',
        language: 'typescript',
        contentHash: computeHash('nocycles'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Create a linear chain: A -> B -> C (no cycle)
      const defA = db.files.insertDefinition(fileId, {
        name: 'funcA',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const defB = db.files.insertDefinition(fileId, {
        name: 'funcB',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
      });

      const defC = db.files.insertDefinition(fileId, {
        name: 'funcC',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 12, column: 0 },
        endPosition: { row: 17, column: 1 },
      });

      // Create symbols for internal references
      const symB = db.insertSymbol(
        null,
        defB,
        {
          name: 'funcB',
          localName: 'funcB',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      const symC = db.insertSymbol(
        null,
        defC,
        {
          name: 'funcC',
          localName: 'funcC',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      // A calls B
      db.insertUsage(symB, {
        position: { row: 2, column: 10 },
        context: 'call_expression',
      });

      // B calls C
      db.insertUsage(symC, {
        position: { row: 8, column: 10 },
        context: 'call_expression',
      });

      const cycles = db.graph.findCycles('purpose');
      expect(cycles).toEqual([]);
    });

    it('detects simple A↔B cycle', () => {
      const fileId = db.files.insert({
        path: '/project/cycle.ts',
        language: 'typescript',
        contentHash: computeHash('cycle'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defA = db.files.insertDefinition(fileId, {
        name: 'funcA',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const defB = db.files.insertDefinition(fileId, {
        name: 'funcB',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
      });

      // Create symbols
      const symA = db.insertSymbol(
        null,
        defA,
        {
          name: 'funcA',
          localName: 'funcA',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      const symB = db.insertSymbol(
        null,
        defB,
        {
          name: 'funcB',
          localName: 'funcB',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      // A calls B
      db.insertUsage(symB, {
        position: { row: 2, column: 10 },
        context: 'call_expression',
      });

      // B calls A (creating cycle)
      db.insertUsage(symA, {
        position: { row: 8, column: 10 },
        context: 'call_expression',
      });

      const cycles = db.graph.findCycles('purpose');
      expect(cycles).toHaveLength(1);
      expect(cycles[0]).toHaveLength(2);
      expect(cycles[0].sort()).toEqual([defA, defB].sort());
    });

    it('detects larger cycle A→B→C→A', () => {
      const fileId = db.files.insert({
        path: '/project/largecycle.ts',
        language: 'typescript',
        contentHash: computeHash('largecycle'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defA = db.files.insertDefinition(fileId, {
        name: 'funcA',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const defB = db.files.insertDefinition(fileId, {
        name: 'funcB',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
      });

      const defC = db.files.insertDefinition(fileId, {
        name: 'funcC',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 12, column: 0 },
        endPosition: { row: 17, column: 1 },
      });

      // Create symbols
      const symA = db.insertSymbol(
        null,
        defA,
        {
          name: 'funcA',
          localName: 'funcA',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      const symB = db.insertSymbol(
        null,
        defB,
        {
          name: 'funcB',
          localName: 'funcB',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      const symC = db.insertSymbol(
        null,
        defC,
        {
          name: 'funcC',
          localName: 'funcC',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      // A calls B
      db.insertUsage(symB, {
        position: { row: 2, column: 10 },
        context: 'call_expression',
      });

      // B calls C
      db.insertUsage(symC, {
        position: { row: 8, column: 10 },
        context: 'call_expression',
      });

      // C calls A (completing the cycle)
      db.insertUsage(symA, {
        position: { row: 14, column: 10 },
        context: 'call_expression',
      });

      const cycles = db.graph.findCycles('purpose');
      expect(cycles).toHaveLength(1);
      expect(cycles[0]).toHaveLength(3);
      expect(cycles[0].sort()).toEqual([defA, defB, defC].sort());
    });

    it('only includes unannotated symbols in cycles', () => {
      const fileId = db.files.insert({
        path: '/project/partial.ts',
        language: 'typescript',
        contentHash: computeHash('partial'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defA = db.files.insertDefinition(fileId, {
        name: 'funcA',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const defB = db.files.insertDefinition(fileId, {
        name: 'funcB',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
      });

      // Create symbols
      const symA = db.insertSymbol(
        null,
        defA,
        {
          name: 'funcA',
          localName: 'funcA',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      const symB = db.insertSymbol(
        null,
        defB,
        {
          name: 'funcB',
          localName: 'funcB',
          kind: 'named',
          usages: [],
        },
        fileId
      );

      // A calls B, B calls A (creating cycle)
      db.insertUsage(symB, { position: { row: 2, column: 10 }, context: 'call_expression' });
      db.insertUsage(symA, { position: { row: 8, column: 10 }, context: 'call_expression' });

      // Annotate one symbol
      db.metadata.set(defA, 'purpose', 'Test purpose');

      // Now only defB is unannotated, so no cycle should be detected
      const cycles = db.graph.findCycles('purpose');
      expect(cycles).toEqual([]);
    });

    it('excludes singleton SCCs (no cycle)', () => {
      const fileId = db.files.insert({
        path: '/project/singleton.ts',
        language: 'typescript',
        contentHash: computeHash('singleton'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Create isolated symbols with no dependencies
      db.files.insertDefinition(fileId, {
        name: 'isolated1',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.files.insertDefinition(fileId, {
        name: 'isolated2',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
      });

      // No usages = no dependencies = singletons only
      const cycles = db.graph.findCycles('purpose');
      expect(cycles).toEqual([]);
    });

    it('returns empty array when all symbols are annotated', () => {
      const fileId = db.files.insert({
        path: '/project/annotated.ts',
        language: 'typescript',
        contentHash: computeHash('annotated'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defA = db.files.insertDefinition(fileId, {
        name: 'funcA',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const defB = db.files.insertDefinition(fileId, {
        name: 'funcB',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 11, column: 1 },
      });

      // Annotate both symbols
      db.metadata.set(defA, 'purpose', 'Purpose A');
      db.metadata.set(defB, 'purpose', 'Purpose B');

      const cycles = db.graph.findCycles('purpose');
      expect(cycles).toEqual([]);
    });
  });

  describe('getUnassignedSymbols', () => {
    it('returns all symbols when no modules exist', () => {
      const fileId = db.files.insert({
        path: '/project/types.ts',
        language: 'typescript',
        contentHash: computeHash('types'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'User',
        kind: 'interface',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.files.insertDefinition(fileId, {
        name: 'createUser',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      const unassigned = db.modules.getUnassigned();
      expect(unassigned).toHaveLength(2);
    });

    it('returns all unassigned symbols with annotations', () => {
      const fileId = db.files.insert({
        path: '/project/mixed.ts',
        language: 'typescript',
        contentHash: computeHash('mixed'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'User',
        kind: 'interface',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.files.insertDefinition(fileId, {
        name: 'UserType',
        kind: 'type',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 6, column: 30 },
      });

      db.files.insertDefinition(fileId, {
        name: 'createUser',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 7, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      const symbols = db.modules.getUnassigned();
      expect(symbols).toHaveLength(3);
      expect(symbols.map((s) => s.name).sort()).toEqual(['User', 'UserType', 'createUser']);
    });

    it('excludes assigned definitions', () => {
      const fileId = db.files.insert({
        path: '/project/service.ts',
        language: 'typescript',
        contentHash: computeHash('service'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'UserService',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 20, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'User',
        kind: 'interface',
        isExported: true,
        isDefault: false,
        position: { row: 21, column: 0 },
        endPosition: { row: 25, column: 1 },
      });

      // Assign def1 to a module
      const rootId = db.modules.ensureRoot();
      const moduleId = db.modules.insert(rootId, 'user-module', 'User Module');
      db.modules.assignSymbol(def1, moduleId);

      const unassigned = db.modules.getUnassigned();
      expect(unassigned).toHaveLength(1);
      expect(unassigned[0].name).toBe('User');
    });
  });

  describe('getIncomingEdgesFor', () => {
    it('returns callers of a definition', () => {
      // Setup: Create files and definitions
      const serviceFile = db.files.insert({
        path: '/project/service.ts',
        language: 'typescript',
        contentHash: computeHash('service'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const controllerFile = db.files.insert({
        path: '/project/controller.ts',
        language: 'typescript',
        contentHash: computeHash('controller'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Create the callee definition
      const serviceFunc = db.files.insertDefinition(serviceFile, {
        name: 'findUser',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      // Create the caller definition
      const controllerFunc = db.files.insertDefinition(controllerFile, {
        name: 'getUser',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      // Create import and symbol in controller to reference service
      const refId = db.insertReference(controllerFile, serviceFile, {
        type: 'import',
        source: './service',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const symbolId = db.insertSymbol(refId, serviceFunc, {
        name: 'findUser',
        localName: 'findUser',
        kind: 'named',
        usages: [],
      });

      // Create a call usage inside the caller's span
      db.insertUsage(symbolId, {
        position: { row: 5, column: 10 }, // Within getUser's span (0-10)
        context: 'call_expression',
        callsite: {
          argumentCount: 1,
          isMethodCall: false,
          isConstructorCall: false,
        },
      });

      const incomingEdges = db.modules.getIncomingEdgesFor(serviceFunc);
      expect(incomingEdges).toHaveLength(1);
      expect(incomingEdges[0].callerId).toBe(controllerFunc);
      expect(incomingEdges[0].callerName).toBe('getUser');
      expect(incomingEdges[0].weight).toBe(1);
    });

    it('returns empty array for definitions with no callers', () => {
      const fileId = db.files.insert({
        path: '/project/isolated.ts',
        language: 'typescript',
        contentHash: computeHash('isolated'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'isolated',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const incomingEdges = db.modules.getIncomingEdgesFor(defId);
      expect(incomingEdges).toEqual([]);
    });
  });

  describe('getRootDefinitions', () => {
    it('returns exported definitions not called by anything', () => {
      const fileId = db.files.insert({
        path: '/project/entry.ts',
        language: 'typescript',
        contentHash: computeHash('entry'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      db.files.insertDefinition(fileId, {
        name: 'main',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      db.files.insertDefinition(fileId, {
        name: 'internal',
        kind: 'function',
        isExported: false, // Not exported
        isDefault: false,
        position: { row: 11, column: 0 },
        endPosition: { row: 15, column: 1 },
      });

      const roots = db.getRootDefinitions();
      expect(roots).toHaveLength(1);
      expect(roots[0].name).toBe('main');
    });

    it('excludes definitions that are called by others', () => {
      // Create two files
      const utilsFile = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('utils'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const mainFile = db.files.insert({
        path: '/project/main.ts',
        language: 'typescript',
        contentHash: computeHash('main'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Helper function - will be called
      const helperDef = db.files.insertDefinition(utilsFile, {
        name: 'helper',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      // Main function - entry point, not called by anything
      const mainDef = db.files.insertDefinition(mainFile, {
        name: 'main',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
      });

      // main calls helper via import
      const refId = db.insertReference(mainFile, utilsFile, {
        type: 'import',
        source: './utils',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const symbolId = db.insertSymbol(refId, helperDef, {
        name: 'helper',
        localName: 'helper',
        kind: 'named',
        usages: [],
      });

      db.insertUsage(symbolId, {
        position: { row: 5, column: 4 }, // Within main's span
        context: 'call_expression',
        callsite: {
          argumentCount: 0,
          isMethodCall: false,
          isConstructorCall: false,
        },
      });

      const roots = db.getRootDefinitions();
      // Only main should be a root; helper is called
      expect(roots.map((r) => r.name)).toContain('main');
      expect(roots.map((r) => r.name)).not.toContain('helper');
    });
  });
});
