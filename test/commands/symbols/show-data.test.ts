import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SymbolShowDataGatherer } from '../../../src/commands/symbols/_show-data.js';
import type { IndexDatabase } from '../../../src/db/database.js';

// ─── Minimal mock factories ───────────────────────────────────────────────────

function makeDefinition(overrides: Partial<ReturnType<IndexDatabase['definitions']['getById']>> = {}) {
  return {
    id: 1,
    name: 'myFunction',
    kind: 'function',
    filePath: 'src/utils.ts',
    line: 10,
    endLine: 20,
    isExported: true,
    ...overrides,
  };
}

function makeMockDb(overrides: Partial<Record<string, unknown>> = {}): IndexDatabase {
  return {
    definitions: {
      getById: vi.fn(() => makeDefinition()),
      getForFile: vi.fn(() => [makeDefinition()]),
    },
    files: {
      getIdByPath: vi.fn((p: string) => (p === 'src/utils.ts' ? 10 : null)),
    },
    metadata: {
      get: vi.fn(() => ({ purpose: 'test utility' })),
    },
    modules: {
      getDefinitionModule: vi.fn(() => null),
    },
    relationships: {
      getFrom: vi.fn(() => []),
      getTo: vi.fn(() => []),
    },
    dependencies: {
      getForDefinition: vi.fn(() => []),
      getIncoming: vi.fn(() => []),
      getIncomingCount: vi.fn(() => 0),
      getCallsites: vi.fn(() => []),
    },
    flows: {
      getFlowsWithDefinition: vi.fn(() => []),
    },
    interactions: {
      getIncomingForSymbols: vi.fn(() => []),
      getOutgoingForSymbols: vi.fn(() => []),
    },
    toRelativePath: vi.fn((p: string) => p),
    resolveFilePath: vi.fn((p: string) => `/workspace/${p}`),
    ...overrides,
  } as unknown as IndexDatabase;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SymbolShowDataGatherer', () => {
  let gatherer: SymbolShowDataGatherer;
  let db: IndexDatabase;

  beforeEach(() => {
    gatherer = new SymbolShowDataGatherer();
    db = makeMockDb();
  });

  describe('gatherSymbolData', () => {
    it('throws when definition not found', async () => {
      vi.mocked(db.definitions.getById).mockReturnValue(null as never);
      await expect(gatherer.gatherSymbolData(db, 999, 3)).rejects.toThrow('Definition with ID 999 not found');
    });

    it('returns basic definition fields', async () => {
      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.id).toBe(1);
      expect(data.name).toBe('myFunction');
      expect(data.kind).toBe('function');
      expect(data.filePath).toBe('src/utils.ts');
      expect(data.line).toBe(10);
      expect(data.endLine).toBe(20);
      expect(data.isExported).toBe(true);
    });

    it('includes metadata', async () => {
      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.metadata).toEqual({ purpose: 'test utility' });
    });

    it('module is null when no module found', async () => {
      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.module).toBeNull();
    });

    it('includes module when found', async () => {
      vi.mocked(db.modules.getDefinitionModule).mockReturnValue({
        module: { id: 5, name: 'MyModule', fullPath: 'project.mymodule' },
      } as never);
      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.module).toEqual({ id: 5, name: 'MyModule', fullPath: 'project.mymodule' });
    });

    it('includes empty relationships arrays by default', async () => {
      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.relationships).toEqual([]);
      expect(data.incomingRelationships).toEqual([]);
    });

    it('includes empty dependencies and dependents by default', async () => {
      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.dependencies).toEqual([]);
      expect(data.dependents.count).toBe(0);
      expect(data.dependents.sample).toEqual([]);
    });

    it('includes empty flows and interactions by default', async () => {
      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.flows).toEqual([]);
      expect(data.interactions.incoming).toEqual([]);
      expect(data.interactions.outgoing).toEqual([]);
    });

    it('maps relationships correctly', async () => {
      vi.mocked(db.relationships.getFrom).mockReturnValue([
        {
          toDefinitionId: 2,
          toName: 'helperFn',
          toKind: 'function',
          relationshipType: 'calls',
          semantic: 'delegates-to',
          toFilePath: 'src/helper.ts',
          toLine: 5,
        },
      ] as never);

      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.relationships).toHaveLength(1);
      expect(data.relationships[0]).toMatchObject({
        toName: 'helperFn',
        toKind: 'function',
        relationshipType: 'calls',
        semantic: 'delegates-to',
      });
    });

    it('maps dependents correctly including count', async () => {
      vi.mocked(db.dependencies.getIncomingCount).mockReturnValue(5);
      vi.mocked(db.dependencies.getIncoming).mockReturnValue([
        { id: 3, name: 'caller', kind: 'function', filePath: 'src/main.ts', line: 1 },
      ] as never);

      const data = await gatherer.gatherSymbolData(db, 1, 3);
      expect(data.dependents.count).toBe(5);
      expect(data.dependents.sample).toHaveLength(1);
      expect(data.dependents.sample[0].name).toBe('caller');
    });
  });

  describe('gatherFileData', () => {
    it('returns null when file not found', async () => {
      vi.mocked(db.files.getIdByPath).mockReturnValue(null);
      const result = await gatherer.gatherFileData(db, '/nonexistent/file.ts');
      expect(result).toBeNull();
    });

    it('returns null when file has no definitions', async () => {
      vi.mocked(db.files.getIdByPath).mockReturnValue(10);
      vi.mocked(db.definitions.getForFile).mockReturnValue([]);
      const result = await gatherer.gatherFileData(db, 'src/utils.ts');
      expect(result).toBeNull();
    });

    it('returns file data when file has definitions', async () => {
      vi.mocked(db.files.getIdByPath).mockReturnValue(10);
      const result = await gatherer.gatherFileData(db, 'src/utils.ts');
      expect(result).not.toBeNull();
      expect(result!.symbols).toHaveLength(1);
      expect(result!.symbols[0].name).toBe('myFunction');
    });

    it('aggregates modules from all definitions', async () => {
      vi.mocked(db.files.getIdByPath).mockReturnValue(10);
      vi.mocked(db.modules.getDefinitionModule).mockReturnValue({
        module: { id: 7, name: 'UtilsModule', fullPath: 'project.utils' },
      } as never);

      const result = await gatherer.gatherFileData(db, 'src/utils.ts');
      expect(result!.modules).toHaveLength(1);
      expect(result!.modules[0].name).toBe('UtilsModule');
    });

    it('returns empty relationships when none exist', async () => {
      vi.mocked(db.files.getIdByPath).mockReturnValue(10);
      const result = await gatherer.gatherFileData(db, 'src/utils.ts');
      expect(result!.relationships.outgoing).toEqual([]);
      expect(result!.relationships.incoming).toEqual([]);
    });

    it('deduplicates relationships across multiple definitions', async () => {
      const def1 = makeDefinition({ id: 1 });
      const def2 = makeDefinition({ id: 2, name: 'otherFn' });
      vi.mocked(db.files.getIdByPath).mockReturnValue(10);
      vi.mocked(db.definitions.getForFile).mockReturnValue([def1, def2] as never);

      const rel = {
        toDefinitionId: 99,
        toName: 'external',
        toKind: 'function',
        relationshipType: 'calls',
        semantic: '',
        toFilePath: 'src/external.ts',
        toLine: 1,
        fromDefinitionId: 1,
        fromName: 'myFunction',
        fromKind: 'function',
        fromFilePath: 'src/utils.ts',
        fromLine: 10,
      };

      // Both definitions return the same relationship (same toDefinitionId + type)
      vi.mocked(db.relationships.getFrom).mockReturnValue([rel] as never);

      const result = await gatherer.gatherFileData(db, 'src/utils.ts');
      // Should not be deduplicated by different fromDefinitionId keys: def1 vs def2 keys differ
      // def1: "1-99-calls", def2: "2-99-calls" -> 2 outgoing
      expect(result!.relationships.outgoing).toHaveLength(2);
    });
  });
});
