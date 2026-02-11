import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type IndexingResult, indexParsedFiles } from '../../src/commands/parse.js';
import type { IIndexWriter } from '../../src/db/database.js';
import type { ParsedFile } from '../../src/parser/ast-parser.js';

function createMockIndexWriter(): IIndexWriter & {
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  let fileIdCounter = 0;
  let defIdCounter = 0;
  let refIdCounter = 0;
  let symbolIdCounter = 0;
  let usageCounter = 0;
  const definitions = new Map<string, number>(); // "fileId:name" -> defId

  return {
    calls,
    initialize: vi.fn(() => {
      calls.push({ method: 'initialize', args: [] });
    }),
    setMetadata: vi.fn((key: string, value: string) => {
      calls.push({ method: 'setMetadata', args: [key, value] });
    }),
    insertFile: vi.fn((file) => {
      calls.push({ method: 'insertFile', args: [file] });
      return ++fileIdCounter;
    }),
    insertDefinition: vi.fn((fileId, def) => {
      calls.push({ method: 'insertDefinition', args: [fileId, def] });
      const id = ++defIdCounter;
      if (def.isExported) {
        definitions.set(`${fileId}:${def.name}`, id);
      }
      return id;
    }),
    insertReference: vi.fn((fromFileId, toFileId, ref) => {
      calls.push({ method: 'insertReference', args: [fromFileId, toFileId, ref] });
      return ++refIdCounter;
    }),
    insertSymbol: vi.fn((refId, defId, sym, fileId) => {
      calls.push({ method: 'insertSymbol', args: [refId, defId, sym, fileId] });
      return ++symbolIdCounter;
    }),
    insertUsage: vi.fn((symbolId, usage) => {
      calls.push({ method: 'insertUsage', args: [symbolId, usage] });
      usageCounter++;
    }),
    getDefinitionByName: vi.fn((fileId, name) => {
      return definitions.get(`${fileId}:${name}`) ?? null;
    }),
    getDefinitionCount: vi.fn(() => defIdCounter),
    getReferenceCount: vi.fn(() => refIdCounter),
    getUsageCount: vi.fn(() => usageCounter),
    getCallsites: vi.fn(() => []),
    getCallsitesForFile: vi.fn(() => []),
    getCallsiteCount: vi.fn(() => 0),
    close: vi.fn(() => {
      calls.push({ method: 'close', args: [] });
    }),
  };
}

describe('indexParsedFiles', () => {
  let mockDb: ReturnType<typeof createMockIndexWriter>;

  beforeEach(() => {
    mockDb = createMockIndexWriter();
  });

  it('sets metadata correctly', () => {
    const parsedFiles = new Map<string, ParsedFile>();

    indexParsedFiles(parsedFiles, mockDb, '/project');

    const metadataCalls = mockDb.calls.filter((c) => c.method === 'setMetadata');
    expect(metadataCalls).toHaveLength(3);

    const keys = metadataCalls.map((c) => c.args[0]);
    expect(keys).toContain('indexed_at');
    expect(keys).toContain('source_directory');
    expect(keys).toContain('version');
  });

  it('inserts files with correct data', () => {
    const parsedFiles = new Map<string, ParsedFile>([
      [
        '/project/utils.ts',
        {
          language: 'typescript',
          content: 'export function add() {}',
          sizeBytes: 25,
          modifiedAt: '2024-01-01T00:00:00.000Z',
          definitions: [],
          references: [],
          internalUsages: [],
        },
      ],
    ]);

    indexParsedFiles(parsedFiles, mockDb, '/project');

    expect(mockDb.insertFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'utils.ts',
        language: 'typescript',
        sizeBytes: 25,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      })
    );
  });

  it('inserts definitions for each file', () => {
    const parsedFiles = new Map<string, ParsedFile>([
      [
        '/project/utils.ts',
        {
          language: 'typescript',
          content: 'export function add() {}',
          sizeBytes: 25,
          modifiedAt: '2024-01-01T00:00:00.000Z',
          definitions: [
            {
              name: 'add',
              kind: 'function',
              isExported: true,
              isDefault: false,
              position: { row: 0, column: 0 },
              endPosition: { row: 0, column: 24 },
            },
          ],
          references: [],
          internalUsages: [],
        },
      ],
    ]);

    indexParsedFiles(parsedFiles, mockDb, '/project');

    expect(mockDb.insertDefinition).toHaveBeenCalledWith(
      1, // fileId
      expect.objectContaining({
        name: 'add',
        kind: 'function',
        isExported: true,
      })
    );
  });

  it('inserts references and symbols', () => {
    const parsedFiles = new Map<string, ParsedFile>([
      [
        '/project/index.ts',
        {
          language: 'typescript',
          content: 'import { add } from "./utils"',
          sizeBytes: 30,
          modifiedAt: '2024-01-01T00:00:00.000Z',
          definitions: [],
          references: [
            {
              type: 'import',
              source: './utils',
              resolvedPath: '/project/utils.ts',
              isExternal: false,
              isTypeOnly: false,
              imports: [
                {
                  name: 'add',
                  localName: 'add',
                  kind: 'named',
                  usages: [{ position: { row: 2, column: 0 }, context: 'call_expression' }],
                },
              ],
              position: { row: 0, column: 0 },
            },
          ],
          internalUsages: [],
        },
      ],
      [
        '/project/utils.ts',
        {
          language: 'typescript',
          content: 'export function add() {}',
          sizeBytes: 25,
          modifiedAt: '2024-01-01T00:00:00.000Z',
          definitions: [
            {
              name: 'add',
              kind: 'function',
              isExported: true,
              isDefault: false,
              position: { row: 0, column: 0 },
              endPosition: { row: 0, column: 24 },
            },
          ],
          references: [],
          internalUsages: [],
        },
      ],
    ]);

    indexParsedFiles(parsedFiles, mockDb, '/project');

    expect(mockDb.insertReference).toHaveBeenCalled();
    expect(mockDb.insertSymbol).toHaveBeenCalled();
    expect(mockDb.insertUsage).toHaveBeenCalled();
  });

  it('returns correct counts', () => {
    const parsedFiles = new Map<string, ParsedFile>([
      [
        '/project/utils.ts',
        {
          language: 'typescript',
          content: 'export function add() {}',
          sizeBytes: 25,
          modifiedAt: '2024-01-01T00:00:00.000Z',
          definitions: [
            {
              name: 'add',
              kind: 'function',
              isExported: true,
              isDefault: false,
              position: { row: 0, column: 0 },
              endPosition: { row: 0, column: 24 },
            },
            {
              name: 'subtract',
              kind: 'function',
              isExported: true,
              isDefault: false,
              position: { row: 1, column: 0 },
              endPosition: { row: 1, column: 30 },
            },
          ],
          references: [],
          internalUsages: [],
        },
      ],
    ]);

    const result = indexParsedFiles(parsedFiles, mockDb, '/project');

    expect(result.definitionCount).toBe(2);
    expect(result.referenceCount).toBe(0);
    expect(result.usageCount).toBe(0);
  });

  it('links symbols to definitions when resolved', () => {
    const parsedFiles = new Map<string, ParsedFile>([
      [
        '/project/utils.ts',
        {
          language: 'typescript',
          content: 'export function add() {}',
          sizeBytes: 25,
          modifiedAt: '2024-01-01T00:00:00.000Z',
          definitions: [
            {
              name: 'add',
              kind: 'function',
              isExported: true,
              isDefault: false,
              position: { row: 0, column: 0 },
              endPosition: { row: 0, column: 24 },
            },
          ],
          references: [],
          internalUsages: [],
        },
      ],
      [
        '/project/index.ts',
        {
          language: 'typescript',
          content: 'import { add } from "./utils"',
          sizeBytes: 30,
          modifiedAt: '2024-01-01T00:00:00.000Z',
          definitions: [],
          references: [
            {
              type: 'import',
              source: './utils',
              resolvedPath: '/project/utils.ts',
              isExternal: false,
              isTypeOnly: false,
              imports: [
                {
                  name: 'add',
                  localName: 'add',
                  kind: 'named',
                  usages: [],
                },
              ],
              position: { row: 0, column: 0 },
            },
          ],
          internalUsages: [],
        },
      ],
    ]);

    indexParsedFiles(parsedFiles, mockDb, '/project');

    // The symbol should be linked to the definition
    // Check that insertSymbol was called with a non-null defId
    const symbolCalls = mockDb.calls.filter((c) => c.method === 'insertSymbol');
    expect(symbolCalls.length).toBeGreaterThan(0);

    // Find the call for the 'add' symbol
    const addSymbolCall = symbolCalls.find((c) => (c.args[2] as { name: string }).name === 'add');
    expect(addSymbolCall).toBeDefined();
    // The defId should be 1 (the first definition inserted)
    expect(addSymbolCall?.args[1]).toBe(1);
  });

  it('handles external imports without linking', () => {
    const parsedFiles = new Map<string, ParsedFile>([
      [
        '/project/index.ts',
        {
          language: 'typescript',
          content: 'import chalk from "chalk"',
          sizeBytes: 25,
          modifiedAt: '2024-01-01T00:00:00.000Z',
          definitions: [],
          references: [
            {
              type: 'import',
              source: 'chalk',
              isExternal: true,
              isTypeOnly: false,
              imports: [
                {
                  name: 'default',
                  localName: 'chalk',
                  kind: 'default',
                  usages: [],
                },
              ],
              position: { row: 0, column: 0 },
            },
          ],
          internalUsages: [],
        },
      ],
    ]);

    indexParsedFiles(parsedFiles, mockDb, '/project');

    const symbolCalls = mockDb.calls.filter((c) => c.method === 'insertSymbol');
    expect(symbolCalls.length).toBe(1);
    // defId should be null for external imports
    expect(symbolCalls[0].args[1]).toBeNull();
  });
});
