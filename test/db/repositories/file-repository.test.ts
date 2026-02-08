import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';
import type { Definition } from '../../../src/parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../../../src/parser/reference-extractor.js';

describe('FileRepository', () => {
  let db: Database.Database;
  let repo: FileRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new FileRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('insert', () => {
    it('inserts a file and returns its ID', () => {
      const id = repo.insert({
        path: '/test/file.ts',
        language: 'typescript',
        contentHash: 'abc123',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(id).toBe(1);
    });

    it('inserts multiple files with incrementing IDs', () => {
      const id1 = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const id2 = repo.insert({
        path: '/test/b.ts',
        language: 'typescript',
        contentHash: 'def',
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });
  });

  describe('getById', () => {
    it('returns file details by ID', () => {
      const id = repo.insert({
        path: '/test/file.ts',
        language: 'typescript',
        contentHash: 'abc123',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const file = repo.getById(id);
      expect(file).not.toBeNull();
      expect(file!.path).toBe('/test/file.ts');
      expect(file!.language).toBe('typescript');
      expect(file!.contentHash).toBe('abc123');
      expect(file!.sizeBytes).toBe(100);
    });

    it('returns null for non-existent ID', () => {
      const file = repo.getById(999);
      expect(file).toBeNull();
    });
  });

  describe('getIdByPath', () => {
    it('returns file ID by path', () => {
      const insertedId = repo.insert({
        path: '/test/file.ts',
        language: 'typescript',
        contentHash: 'abc123',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const id = repo.getIdByPath('/test/file.ts');
      expect(id).toBe(insertedId);
    });

    it('returns null for non-existent path', () => {
      const id = repo.getIdByPath('/non/existent.ts');
      expect(id).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns all files', () => {
      repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      repo.insert({
        path: '/test/b.ts',
        language: 'typescript',
        contentHash: 'def',
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const files = repo.getAll();
      expect(files).toHaveLength(2);
      expect(files[0].path).toBe('/test/a.ts');
      expect(files[1].path).toBe('/test/b.ts');
    });

    it('returns empty array when no files', () => {
      const files = repo.getAll();
      expect(files).toHaveLength(0);
    });
  });

  describe('getAllWithStats', () => {
    it('returns files with import stats', () => {
      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const fileB = repo.insert({
        path: '/test/b.ts',
        language: 'typescript',
        contentHash: 'def',
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Create an import from A to B
      repo.insertReference(fileA, fileB, {
        type: 'import',
        source: './b.js',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      const stats = repo.getAllWithStats();
      expect(stats).toHaveLength(2);

      const aStats = stats.find((s) => s.path === '/test/a.ts');
      const bStats = stats.find((s) => s.path === '/test/b.ts');

      expect(aStats!.importsCount).toBe(1);
      expect(aStats!.importedByCount).toBe(0);
      expect(bStats!.importsCount).toBe(0);
      expect(bStats!.importedByCount).toBe(1);
    });
  });

  describe('getOrphans', () => {
    it('returns files not imported by any other file', () => {
      const fileA = repo.insert({
        path: '/src/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const fileB = repo.insert({
        path: '/src/b.ts',
        language: 'typescript',
        contentHash: 'def',
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // A imports B, so B is not an orphan
      repo.insertReference(fileA, fileB, {
        type: 'import',
        source: './b.js',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      const orphans = repo.getOrphans();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].path).toBe('/src/a.ts');
    });

    it('excludes index files by default', () => {
      repo.insert({
        path: '/src/index.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const orphans = repo.getOrphans();
      expect(orphans).toHaveLength(0);

      const orphansWithIndex = repo.getOrphans({ includeIndex: true });
      expect(orphansWithIndex).toHaveLength(1);
    });

    it('excludes test files by default', () => {
      repo.insert({
        path: '/src/file.test.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const orphans = repo.getOrphans();
      expect(orphans).toHaveLength(0);

      const orphansWithTests = repo.getOrphans({ includeTests: true });
      expect(orphansWithTests).toHaveLength(1);
    });
  });

  describe('insertDefinition', () => {
    it('inserts a definition and returns its ID', () => {
      const fileId = repo.insert({
        path: '/test/file.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def: Definition = {
        name: 'myFunction',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 5, column: 0 },
        endPosition: { row: 10, column: 1 },
      };

      const defId = repo.insertDefinition(fileId, def);
      expect(defId).toBe(1);
    });

    it('stores extends and implements info', () => {
      const fileId = repo.insert({
        path: '/test/file.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def: Definition = {
        name: 'MyClass',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 20, column: 1 },
        extends: 'BaseClass',
        implements: ['Interface1', 'Interface2'],
      };

      const defId = repo.insertDefinition(fileId, def);
      expect(defId).toBe(1);
    });
  });

  describe('insertReference', () => {
    it('inserts a reference and returns its ID', () => {
      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const fileB = repo.insert({
        path: '/test/b.ts',
        language: 'typescript',
        contentHash: 'def',
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const ref: FileReference = {
        type: 'import',
        source: './b.js',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      };

      const refId = repo.insertReference(fileA, fileB, ref);
      expect(refId).toBe(1);
    });

    it('handles external references with null toFileId', () => {
      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const ref: FileReference = {
        type: 'import',
        source: 'lodash',
        isExternal: true,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      };

      const refId = repo.insertReference(fileA, null, ref);
      expect(refId).toBe(1);
    });
  });

  describe('insertSymbol', () => {
    it('inserts a symbol and returns its ID', () => {
      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = repo.insertReference(fileA, null, {
        type: 'import',
        source: 'lodash',
        isExternal: true,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      const sym: ImportedSymbol = {
        name: 'map',
        localName: 'map',
        kind: 'function',
        usages: [],
      };

      const symId = repo.insertSymbol(refId, null, sym);
      expect(symId).toBe(1);
    });
  });

  describe('insertUsage', () => {
    it('inserts a usage', () => {
      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = repo.insertReference(fileA, null, {
        type: 'import',
        source: 'lodash',
        isExternal: true,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      const symId = repo.insertSymbol(refId, null, {
        name: 'map',
        localName: 'map',
        kind: 'function',
        usages: [],
      });

      const usage: SymbolUsage = {
        position: { row: 10, column: 5 },
        context: 'call_expression',
        callsite: {
          argumentCount: 2,
          isMethodCall: false,
          isConstructorCall: false,
        },
      };

      // Should not throw
      repo.insertUsage(symId, usage);

      const usageCount = repo.getUsageCount();
      expect(usageCount).toBe(1);
    });
  });

  describe('getImports', () => {
    it('returns imports for a file', () => {
      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const fileB = repo.insert({
        path: '/test/b.ts',
        language: 'typescript',
        contentHash: 'def',
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      repo.insertReference(fileA, fileB, {
        type: 'import',
        source: './b.js',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      const imports = repo.getImports(fileA);
      expect(imports).toHaveLength(1);
      expect(imports[0].source).toBe('./b.js');
      expect(imports[0].toFileId).toBe(fileB);
      expect(imports[0].toFilePath).toBe('/test/b.ts');
      expect(imports[0].isExternal).toBe(false);
    });
  });

  describe('getImportedBy', () => {
    it('returns files that import a given file', () => {
      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const fileB = repo.insert({
        path: '/test/b.ts',
        language: 'typescript',
        contentHash: 'def',
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      repo.insertReference(fileA, fileB, {
        type: 'import',
        source: './b.js',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      const importedBy = repo.getImportedBy(fileB);
      expect(importedBy).toHaveLength(1);
      expect(importedBy[0].path).toBe('/test/a.ts');
    });
  });

  describe('getCount', () => {
    it('returns count of files', () => {
      expect(repo.getCount()).toBe(0);

      repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      expect(repo.getCount()).toBe(1);

      repo.insert({
        path: '/test/b.ts',
        language: 'typescript',
        contentHash: 'def',
        sizeBytes: 20,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      expect(repo.getCount()).toBe(2);
    });
  });

  describe('getReferenceCount', () => {
    it('returns count of references', () => {
      expect(repo.getReferenceCount()).toBe(0);

      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      repo.insertReference(fileA, null, {
        type: 'import',
        source: 'lodash',
        isExternal: true,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      expect(repo.getReferenceCount()).toBe(1);
    });
  });

  describe('getUsageCount', () => {
    it('returns count of usages', () => {
      expect(repo.getUsageCount()).toBe(0);

      const fileA = repo.insert({
        path: '/test/a.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 10,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const refId = repo.insertReference(fileA, null, {
        type: 'import',
        source: 'lodash',
        isExternal: true,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      const symId = repo.insertSymbol(refId, null, {
        name: 'map',
        localName: 'map',
        kind: 'function',
        usages: [],
      });

      repo.insertUsage(symId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
      });

      expect(repo.getUsageCount()).toBe(1);
    });
  });
});
