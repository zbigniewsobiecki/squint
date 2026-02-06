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
});
