import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IIndexWriter } from '../../src/db/schema.js';
import type { ParsedFile } from '../../src/parser/ast-parser.js';
import {
  deleteFileImportsAndSymbols,
  followReExportChain,
  resolveSymbolToDefinition,
} from '../../src/sync/reference-resolver.js';

describe('reference-resolver', () => {
  describe('followReExportChain', () => {
    it('should return null for empty parsedFiles', () => {
      const result = followReExportChain('SomeSymbol', '/path/to/file.ts', new Map(), new Map(), new Set());
      expect(result).toBeNull();
    });

    it('should return definition ID for export-all re-export', () => {
      const parsedFiles = new Map<string, ParsedFile>();
      parsedFiles.set('/path/to/file.ts', {
        language: 'typescript',
        references: [
          {
            type: 'export-all',
            source: './source.ts',
            resolvedPath: '/path/to/source.ts',
            isExternal: false,
            isTypeOnly: false,
            imports: [],
            line: 1,
            column: 0,
          },
        ],
        definitions: [],
        internalUsages: [],
        content: '',
        sizeBytes: 0,
        modifiedAt: '2024-01-01',
      });

      const definitionMap = new Map<string, Map<string, number>>();
      definitionMap.set('/path/to/source.ts', new Map([['SomeSymbol', 42]]));

      const result = followReExportChain('SomeSymbol', '/path/to/file.ts', parsedFiles, definitionMap, new Set());
      expect(result).toBe(42);
    });

    it('should return definition ID for named re-export', () => {
      const parsedFiles = new Map<string, ParsedFile>();
      parsedFiles.set('/path/to/file.ts', {
        language: 'typescript',
        references: [
          {
            type: 're-export',
            source: './source.ts',
            resolvedPath: '/path/to/source.ts',
            isExternal: false,
            isTypeOnly: false,
            imports: [
              {
                name: 'SomeSymbol',
                localName: 'SomeSymbol',
                kind: 'named',
                usages: [],
              },
            ],
            line: 1,
            column: 0,
          },
        ],
        definitions: [],
        internalUsages: [],
        content: '',
        sizeBytes: 0,
        modifiedAt: '2024-01-01',
      });

      const definitionMap = new Map<string, Map<string, number>>();
      definitionMap.set('/path/to/source.ts', new Map([['SomeSymbol', 42]]));

      const result = followReExportChain('SomeSymbol', '/path/to/file.ts', parsedFiles, definitionMap, new Set());
      expect(result).toBe(42);
    });

    it('should prevent infinite loops with visited set', () => {
      const parsedFiles = new Map<string, ParsedFile>();
      parsedFiles.set('/path/to/file.ts', {
        language: 'typescript',
        references: [
          {
            type: 'export-all',
            source: './file.ts',
            resolvedPath: '/path/to/file.ts',
            isExternal: false,
            isTypeOnly: false,
            imports: [],
            line: 1,
            column: 0,
          },
        ],
        definitions: [],
        internalUsages: [],
        content: '',
        sizeBytes: 0,
        modifiedAt: '2024-01-01',
      });

      const result = followReExportChain('SomeSymbol', '/path/to/file.ts', parsedFiles, new Map(), new Set());
      expect(result).toBeNull();
    });

    it('should limit recursion depth to 5', () => {
      const parsedFiles = new Map<string, ParsedFile>();
      for (let i = 0; i < 10; i++) {
        parsedFiles.set(`/path/to/file${i}.ts`, {
          language: 'typescript',
          references: [
            {
              type: 'export-all',
              source: `./file${i + 1}.ts`,
              resolvedPath: `/path/to/file${i + 1}.ts`,
              isExternal: false,
              isTypeOnly: false,
              imports: [],
              line: 1,
              column: 0,
            },
          ],
          definitions: [],
          internalUsages: [],
          content: '',
          sizeBytes: 0,
          modifiedAt: '2024-01-01',
        });
      }

      const result = followReExportChain('SomeSymbol', '/path/to/file0.ts', parsedFiles, new Map(), new Set());
      expect(result).toBeNull();
    });
  });

  describe('resolveSymbolToDefinition', () => {
    it('should return null for external reference', () => {
      const result = resolveSymbolToDefinition(
        { name: 'SomeSymbol', kind: 'named', localName: 'SomeSymbol' },
        { resolvedPath: '/path/to/file.ts', isExternal: true },
        new Map(),
        new Map(),
        { getDefinitionByName: () => null }
      );
      expect(result).toBeNull();
    });

    it('should return null when resolvedPath is null', () => {
      const result = resolveSymbolToDefinition(
        { name: 'SomeSymbol', kind: 'named', localName: 'SomeSymbol' },
        { resolvedPath: null, isExternal: false },
        new Map(),
        new Map(),
        { getDefinitionByName: () => null }
      );
      expect(result).toBeNull();
    });

    it('should resolve named import to definition ID', () => {
      const definitionMap = new Map<string, Map<string, number>>();
      definitionMap.set('/path/to/file.ts', new Map([['SomeSymbol', 42]]));

      const result = resolveSymbolToDefinition(
        { name: 'SomeSymbol', kind: 'named', localName: 'SomeSymbol' },
        { resolvedPath: '/path/to/file.ts', isExternal: false },
        definitionMap,
        new Map(),
        { getDefinitionByName: () => null }
      );
      expect(result).toBe(42);
    });

    it('should resolve default import to default export', () => {
      const definitionMap = new Map<string, Map<string, number>>();
      definitionMap.set('/path/to/file.ts', new Map([['default', 42]]));

      const result = resolveSymbolToDefinition(
        { name: 'SomeSymbol', kind: 'default', localName: 'SomeSymbol' },
        { resolvedPath: '/path/to/file.ts', isExternal: false },
        definitionMap,
        new Map(),
        { getDefinitionByName: () => null }
      );
      expect(result).toBe(42);
    });

    it('should fallback to checking for named default exports', () => {
      const definitionMap = new Map<string, Map<string, number>>();
      definitionMap.set('/path/to/file.ts', new Map([['SomeSymbol', 42]]));

      const fileIdMap = new Map<string, number>();
      fileIdMap.set('/path/to/file.ts', 1);

      const result = resolveSymbolToDefinition(
        { name: 'SomeSymbol', kind: 'default', localName: 'SomeSymbol' },
        { resolvedPath: '/path/to/file.ts', isExternal: false },
        definitionMap,
        fileIdMap,
        { getDefinitionByName: (fileId, name) => (fileId === 1 && name === 'SomeSymbol' ? 42 : null) }
      );
      expect(result).toBe(42);
    });
  });

  describe('deleteFileImportsAndSymbols', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT);
        CREATE TABLE imports (id INTEGER PRIMARY KEY, from_file_id INTEGER);
        CREATE TABLE symbols (id INTEGER PRIMARY KEY, reference_id INTEGER, file_id INTEGER);
        CREATE TABLE usages (id INTEGER PRIMARY KEY, symbol_id INTEGER);
      `);
    });

    it('should delete all imports, symbols, and usages for a file', () => {
      // Setup: Insert test data
      db.exec(`
        INSERT INTO files (id, path) VALUES (1, '/path/to/file.ts');
        INSERT INTO imports (id, from_file_id) VALUES (100, 1);
        INSERT INTO symbols (id, reference_id, file_id) VALUES (200, 100, NULL);
        INSERT INTO symbols (id, reference_id, file_id) VALUES (201, NULL, 1);
        INSERT INTO usages (id, symbol_id) VALUES (300, 200);
        INSERT INTO usages (id, symbol_id) VALUES (301, 201);
      `);

      // Execute
      deleteFileImportsAndSymbols(db, 1);

      // Verify: All related data is deleted
      const imports = db.prepare('SELECT COUNT(*) as count FROM imports WHERE from_file_id = 1').get() as {
        count: number;
      };
      expect(imports.count).toBe(0);

      const symbols = db
        .prepare('SELECT COUNT(*) as count FROM symbols WHERE reference_id = 100 OR file_id = 1')
        .get() as {
        count: number;
      };
      expect(symbols.count).toBe(0);

      const usages = db.prepare('SELECT COUNT(*) as count FROM usages').get() as { count: number };
      expect(usages.count).toBe(0);
    });

    it('should not affect other files', () => {
      // Setup: Insert data for two files
      db.exec(`
        INSERT INTO files (id, path) VALUES (1, '/path/to/file1.ts'), (2, '/path/to/file2.ts');
        INSERT INTO imports (id, from_file_id) VALUES (100, 1), (101, 2);
        INSERT INTO symbols (id, reference_id, file_id) VALUES (200, 100, NULL), (201, 101, NULL);
        INSERT INTO usages (id, symbol_id) VALUES (300, 200), (301, 201);
      `);

      // Execute: Delete only file 1
      deleteFileImportsAndSymbols(db, 1);

      // Verify: File 2 data remains intact
      const imports = db.prepare('SELECT COUNT(*) as count FROM imports WHERE from_file_id = 2').get() as {
        count: number;
      };
      expect(imports.count).toBe(1);

      const symbols = db.prepare('SELECT COUNT(*) as count FROM symbols WHERE reference_id = 101').get() as {
        count: number;
      };
      expect(symbols.count).toBe(1);

      // Usage 301 should remain because symbol 201 (from file 2) still exists
      const remainingUsages = db.prepare('SELECT COUNT(*) as count FROM usages').get() as { count: number };
      expect(remainingUsages.count).toBe(1);

      const usage301 = db.prepare('SELECT * FROM usages WHERE id = 301').get();
      expect(usage301).toBeTruthy();
    });
  });
});
