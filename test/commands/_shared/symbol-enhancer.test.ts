import { describe, expect, it, vi } from 'vitest';
import { enhanceSymbols } from '../../../src/commands/_shared/symbol-enhancer.js';
import type { IndexDatabase, ReadySymbolInfo } from '../../../src/db/database.js';

describe('symbol-enhancer', () => {
  describe('enhanceSymbols', () => {
    it('enhances symbols with source code and metadata', async () => {
      const mockDb = {
        resolveFilePath: vi.fn((path: string) => `/workspace/${path}`),
        dependencies: {
          getWithMetadata: vi.fn(() => [
            {
              id: 2,
              name: 'helperFn',
              kind: 'function',
              filePath: 'src/helpers.ts',
              line: 5,
            },
          ]),
          getIncoming: vi.fn(() => [{ id: 3, name: 'caller', kind: 'function', filePath: 'src/caller.ts' }]),
          getIncomingCount: vi.fn(() => 1),
        },
        metadata: {
          get: vi.fn((id: number) => {
            if (id === 2) {
              return {
                purpose: 'Helper utility',
                domain: '["utils"]',
                role: 'utility',
                pure: 'true',
              };
            }
            return {};
          }),
        },
        relationships: {
          getUnannotated: vi.fn(() => [
            {
              toDefinitionId: 4,
              toName: 'targetFn',
              toKind: 'function',
              fromLine: 10,
            },
          ]),
        },
        definitions: {
          getById: vi.fn(() => ({ isExported: true })),
        },
      } as unknown as IndexDatabase;

      const symbols: ReadySymbolInfo[] = [
        {
          id: 1,
          name: 'myFunction',
          kind: 'function',
          filePath: 'src/index.ts',
          line: 1,
          endLine: 20,
          dependencyCount: 1,
        },
      ];

      // Mock readSourceAsString by providing a mock that returns source code
      vi.mock('../../../src/commands/_shared/source-reader.js', () => ({
        readSourceAsString: vi.fn(async () => 'function myFunction() { return 42; }'),
      }));

      const result = await enhanceSymbols(mockDb, symbols, ['purpose'], 10);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
      expect(result[0].name).toBe('myFunction');
      expect(result[0].sourceCode).toBe('function myFunction() { return 42; }');
      expect(result[0].isExported).toBe(true);
      expect(result[0].dependencies).toHaveLength(1);
      expect(result[0].dependencies[0].name).toBe('helperFn');
      expect(result[0].dependencies[0].purpose).toBe('Helper utility');
      expect(result[0].dependencies[0].domains).toEqual(['utils']);
      expect(result[0].dependencies[0].pure).toBe(true);
      expect(result[0].relationshipsToAnnotate).toHaveLength(1);
      expect(result[0].relationshipsToAnnotate[0].toName).toBe('targetFn');
      expect(result[0].relationshipsToAnnotate[0].relationshipType).toBe('uses');
      expect(result[0].incomingDependencies).toHaveLength(1);
      expect(result[0].incomingDependencyCount).toBe(1);
    });

    it('handles missing relationships table gracefully', async () => {
      const mockDb = {
        resolveFilePath: vi.fn((path: string) => `/workspace/${path}`),
        dependencies: {
          getWithMetadata: vi.fn(() => []),
          getIncoming: vi.fn(() => []),
          getIncomingCount: vi.fn(() => 0),
        },
        metadata: {
          get: vi.fn(() => ({})),
        },
        relationships: {
          getUnannotated: vi.fn(() => {
            throw new Error('Table does not exist');
          }),
        },
        definitions: {
          getById: vi.fn(() => ({ isExported: false })),
        },
      } as unknown as IndexDatabase;

      const symbols: ReadySymbolInfo[] = [
        {
          id: 1,
          name: 'myFunction',
          kind: 'function',
          filePath: 'src/index.ts',
          line: 1,
          endLine: 20,
          dependencyCount: 0,
        },
      ];

      const result = await enhanceSymbols(mockDb, symbols, ['purpose'], 0);

      expect(result).toHaveLength(1);
      expect(result[0].relationshipsToAnnotate).toEqual([]);
    });

    it('respects relationship limit', async () => {
      const mockDb = {
        resolveFilePath: vi.fn((path: string) => `/workspace/${path}`),
        dependencies: {
          getWithMetadata: vi.fn(() => []),
          getIncoming: vi.fn(() => []),
          getIncomingCount: vi.fn(() => 0),
        },
        metadata: {
          get: vi.fn(() => ({})),
        },
        relationships: {
          getUnannotated: vi.fn((opts) => {
            expect(opts.limit).toBe(5);
            return [];
          }),
        },
        definitions: {
          getById: vi.fn(() => ({ isExported: false })),
        },
      } as unknown as IndexDatabase;

      const symbols: ReadySymbolInfo[] = [
        {
          id: 1,
          name: 'myFunction',
          kind: 'function',
          filePath: 'src/index.ts',
          line: 1,
          endLine: 20,
          dependencyCount: 0,
        },
      ];

      await enhanceSymbols(mockDb, symbols, ['purpose'], 5);

      expect(mockDb.relationships.getUnannotated).toHaveBeenCalledWith({
        fromDefinitionId: 1,
        limit: 5,
      });
    });

    it('handles invalid domain JSON gracefully', async () => {
      const mockDb = {
        resolveFilePath: vi.fn((path: string) => `/workspace/${path}`),
        dependencies: {
          getWithMetadata: vi.fn(() => [
            {
              id: 2,
              name: 'depFn',
              kind: 'function',
              filePath: 'src/dep.ts',
              line: 1,
            },
          ]),
          getIncoming: vi.fn(() => []),
          getIncomingCount: vi.fn(() => 0),
        },
        metadata: {
          get: vi.fn(() => ({
            domain: '{invalid json',
            purpose: 'test',
          })),
        },
        relationships: {
          getUnannotated: vi.fn(() => []),
        },
        definitions: {
          getById: vi.fn(() => ({ isExported: false })),
        },
      } as unknown as IndexDatabase;

      const symbols: ReadySymbolInfo[] = [
        {
          id: 1,
          name: 'myFunction',
          kind: 'function',
          filePath: 'src/index.ts',
          line: 1,
          endLine: 20,
          dependencyCount: 1,
        },
      ];

      const result = await enhanceSymbols(mockDb, symbols, ['purpose'], 0);

      expect(result[0].dependencies[0].domains).toBeNull();
    });
  });
});
