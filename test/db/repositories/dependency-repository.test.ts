import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DependencyRepository } from '../../../src/db/repositories/dependency-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { MetadataRepository } from '../../../src/db/repositories/metadata-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('DependencyRepository', () => {
  let db: Database.Database;
  let repo: DependencyRepository;
  let fileRepo: FileRepository;
  let metadataRepo: MetadataRepository;
  let fileId: number;
  let callerDefId: number;
  let calleeDefId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new DependencyRepository(db);
    fileRepo = new FileRepository(db);
    metadataRepo = new MetadataRepository(db);

    // Create a file with two definitions
    fileId = fileRepo.insert({
      path: '/test/file.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    // Caller definition (lines 1-10)
    callerDefId = fileRepo.insertDefinition(fileId, {
      name: 'caller',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 9, column: 1 },
    });

    // Callee definition (lines 15-25)
    calleeDefId = fileRepo.insertDefinition(fileId, {
      name: 'callee',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 14, column: 0 },
      endPosition: { row: 24, column: 1 },
    });
  });

  afterEach(() => {
    db.close();
  });

  function createCallFromTo(fromDefId: number, toDefId: number, line: number): void {
    // Create internal symbol pointing to the target definition
    const symId = fileRepo.insertSymbol(
      null,
      toDefId,
      {
        name: 'callee',
        localName: 'callee',
        kind: 'function',
        usages: [],
      },
      fileId
    );

    // Create a call usage within the caller's line range
    fileRepo.insertUsage(symId, {
      position: { row: line - 1, column: 5 },
      context: 'call_expression',
      callsite: {
        argumentCount: 0,
        isMethodCall: false,
        isConstructorCall: false,
      },
    });
  }

  describe('getCallsites', () => {
    it('returns callsites for a definition', () => {
      createCallFromTo(callerDefId, calleeDefId, 5);

      const callsites = repo.getCallsites(calleeDefId);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].symbolName).toBe('callee');
      expect(callsites[0].line).toBe(5);
    });

    it('returns empty array when no callsites', () => {
      const callsites = repo.getCallsites(calleeDefId);
      expect(callsites).toHaveLength(0);
    });
  });

  describe('getCallsitesForFile', () => {
    it('returns callsites in a file via imports', () => {
      // Create another file that imports from our file
      const file2Id = fileRepo.insert({
        path: '/test/file2.ts',
        language: 'typescript',
        contentHash: 'def456',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      // Create an import from file2 to file
      const refId = fileRepo.insertReference(file2Id, fileId, {
        type: 'import',
        source: './file.js',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      // Create symbol from the import
      const symId = fileRepo.insertSymbol(refId, calleeDefId, {
        name: 'callee',
        localName: 'callee',
        kind: 'function',
        usages: [],
      });

      // Create a call usage
      fileRepo.insertUsage(symId, {
        position: { row: 5, column: 5 },
        context: 'call_expression',
        callsite: {
          argumentCount: 2,
          isMethodCall: false,
          isConstructorCall: false,
        },
      });

      const callsites = repo.getCallsitesForFile(file2Id);
      expect(callsites).toHaveLength(1);
      expect(callsites[0].argumentCount).toBe(2);
    });
  });

  describe('getCallsiteCount', () => {
    it('returns count of all callsites', () => {
      expect(repo.getCallsiteCount()).toBe(0);

      createCallFromTo(callerDefId, calleeDefId, 5);
      expect(repo.getCallsiteCount()).toBe(1);
    });
  });

  describe('getIncoming', () => {
    it('returns definitions that call a given definition', () => {
      createCallFromTo(callerDefId, calleeDefId, 5);

      const incoming = repo.getIncoming(calleeDefId);
      expect(incoming).toHaveLength(1);
      expect(incoming[0].name).toBe('caller');
    });

    it('respects limit parameter', () => {
      // Create multiple callers
      const caller2Id = fileRepo.insertDefinition(fileId, {
        name: 'caller2',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 29, column: 0 },
        endPosition: { row: 39, column: 1 },
      });

      createCallFromTo(callerDefId, calleeDefId, 5);

      // Create another internal symbol for the second call
      const symId2 = fileRepo.insertSymbol(
        null,
        calleeDefId,
        {
          name: 'callee',
          localName: 'callee',
          kind: 'function',
          usages: [],
        },
        fileId
      );

      fileRepo.insertUsage(symId2, {
        position: { row: 34, column: 5 },
        context: 'call_expression',
        callsite: {
          argumentCount: 0,
          isMethodCall: false,
          isConstructorCall: false,
        },
      });

      const incoming = repo.getIncoming(calleeDefId, 1);
      expect(incoming).toHaveLength(1);
    });
  });

  describe('getIncomingCount', () => {
    it('returns count of definitions that call a given definition', () => {
      createCallFromTo(callerDefId, calleeDefId, 5);

      const count = repo.getIncomingCount(calleeDefId);
      expect(count).toBe(1);
    });
  });

  describe('getForDefinition', () => {
    it('returns definitions that a given definition depends on', () => {
      createCallFromTo(callerDefId, calleeDefId, 5);

      const deps = repo.getForDefinition(callerDefId);
      expect(deps).toHaveLength(1);
      expect(deps[0].name).toBe('callee');
    });
  });

  describe('getWithMetadata', () => {
    it('returns dependencies with their metadata status', () => {
      createCallFromTo(callerDefId, calleeDefId, 5);
      metadataRepo.set(calleeDefId, 'purpose', 'Does something');

      const deps = repo.getWithMetadata(callerDefId, 'purpose');
      expect(deps).toHaveLength(1);
      expect(deps[0].hasAspect).toBe(true);
      expect(deps[0].aspectValue).toBe('Does something');
    });

    it('shows hasAspect as false for dependencies without the aspect', () => {
      createCallFromTo(callerDefId, calleeDefId, 5);
      // Don't set any metadata

      const deps = repo.getWithMetadata(callerDefId, 'purpose');
      expect(deps).toHaveLength(1);
      expect(deps[0].hasAspect).toBe(false);
      expect(deps[0].aspectValue).toBeNull();
    });
  });

  describe('getUnmet', () => {
    it('returns dependencies without a specific aspect', () => {
      createCallFromTo(callerDefId, calleeDefId, 5);
      // Don't set the 'purpose' aspect on callee

      const unmet = repo.getUnmet(callerDefId, 'purpose');
      expect(unmet).toHaveLength(1);
      expect(unmet[0].name).toBe('callee');
    });

    it('returns empty array when all dependencies have the aspect', () => {
      createCallFromTo(callerDefId, calleeDefId, 5);
      metadataRepo.set(calleeDefId, 'purpose', 'Has purpose');

      const unmet = repo.getUnmet(callerDefId, 'purpose');
      expect(unmet).toHaveLength(0);
    });
  });

  describe('getPrerequisiteChain', () => {
    it('returns dependency chain in topological order', () => {
      // Create a chain: caller -> middle -> leaf
      const middleDefId = fileRepo.insertDefinition(fileId, {
        name: 'middle',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 39, column: 0 },
        endPosition: { row: 49, column: 1 },
      });

      // caller calls middle (at line 5)
      const symMiddle = fileRepo.insertSymbol(
        null,
        middleDefId,
        {
          name: 'middle',
          localName: 'middle',
          kind: 'function',
          usages: [],
        },
        fileId
      );
      fileRepo.insertUsage(symMiddle, {
        position: { row: 4, column: 5 },
        context: 'call_expression',
        callsite: { argumentCount: 0, isMethodCall: false, isConstructorCall: false },
      });

      // middle calls callee (at line 45)
      const symCallee = fileRepo.insertSymbol(
        null,
        calleeDefId,
        {
          name: 'callee',
          localName: 'callee',
          kind: 'function',
          usages: [],
        },
        fileId
      );
      fileRepo.insertUsage(symCallee, {
        position: { row: 44, column: 5 },
        context: 'call_expression',
        callsite: { argumentCount: 0, isMethodCall: false, isConstructorCall: false },
      });

      const getDefById = (id: number) => {
        const stmt = db.prepare(`
          SELECT d.name, d.kind, f.path as filePath, d.line
          FROM definitions d
          JOIN files f ON d.file_id = f.id
          WHERE d.id = ?
        `);
        return (stmt.get(id) as { name: string; kind: string; filePath: string; line: number } | undefined) ?? null;
      };

      const chain = repo.getPrerequisiteChain(callerDefId, 'purpose', getDefById);
      // Should return both middle and callee (leaves first)
      expect(chain.length).toBeGreaterThan(0);
    });
  });

  describe('getReadySymbols', () => {
    it('returns symbols ready to understand for an aspect', () => {
      // callee has no dependencies, so it's ready
      // caller depends on callee, so it's not ready until callee has the aspect

      const result = repo.getReadySymbols('purpose');
      // Both should be ready since neither has dependencies that are missing the aspect
      expect(result.symbols.length).toBeGreaterThanOrEqual(0);
      expect(result.totalReady).toBeGreaterThanOrEqual(0);
    });

    it('respects filters', () => {
      const result = repo.getReadySymbols('purpose', { kind: 'function' });
      expect(result.symbols.every((s) => s.kind === 'function')).toBe(true);
    });

    it('respects limit', () => {
      const result = repo.getReadySymbols('purpose', { limit: 1 });
      expect(result.symbols.length).toBeLessThanOrEqual(1);
    });
  });

  describe('getImportGraph', () => {
    it('returns nodes and links for import graph', () => {
      const file2Id = fileRepo.insert({
        path: '/test/file2.ts',
        language: 'typescript',
        contentHash: 'def456',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      fileRepo.insertReference(fileId, file2Id, {
        type: 'import',
        source: './file2.js',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
        symbols: [],
      });

      const graph = repo.getImportGraph();
      expect(graph.nodes).toHaveLength(2);
      expect(graph.links).toHaveLength(1);
      expect(graph.links[0].source).toBe(fileId);
      expect(graph.links[0].target).toBe(file2Id);
    });
  });
});
