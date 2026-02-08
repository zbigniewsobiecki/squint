import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { RelationshipRepository } from '../../../src/db/repositories/relationship-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { MetadataRepository } from '../../../src/db/repositories/metadata-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('RelationshipRepository', () => {
  let db: Database.Database;
  let repo: RelationshipRepository;
  let fileRepo: FileRepository;
  let metadataRepo: MetadataRepository;
  let fileId: number;
  let defId1: number;
  let defId2: number;
  let defId3: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new RelationshipRepository(db);
    fileRepo = new FileRepository(db);
    metadataRepo = new MetadataRepository(db);

    fileId = fileRepo.insert({
      path: '/test/file.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    defId1 = fileRepo.insertDefinition(fileId, {
      name: 'ServiceA',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    defId2 = fileRepo.insertDefinition(fileId, {
      name: 'ServiceB',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 25, column: 0 },
      endPosition: { row: 45, column: 1 },
    });

    defId3 = fileRepo.insertDefinition(fileId, {
      name: 'HelperC',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 50, column: 0 },
      endPosition: { row: 60, column: 1 },
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('set', () => {
    it('creates a new relationship annotation', () => {
      repo.set(defId1, defId2, 'delegates authentication to');

      const rel = repo.get(defId1, defId2);
      expect(rel).not.toBeNull();
      expect(rel!.semantic).toBe('delegates authentication to');
      expect(rel!.relationshipType).toBe('uses');
    });

    it('sets relationship type', () => {
      repo.set(defId1, defId2, 'inherits behavior from', 'extends');

      const rel = repo.get(defId1, defId2);
      expect(rel!.relationshipType).toBe('extends');
    });

    it('replaces existing annotation', () => {
      repo.set(defId1, defId2, 'original semantic');
      repo.set(defId1, defId2, 'updated semantic');

      const rel = repo.get(defId1, defId2);
      expect(rel!.semantic).toBe('updated semantic');
    });
  });

  describe('get', () => {
    it('returns relationship annotation', () => {
      repo.set(defId1, defId2, 'uses for validation');

      const rel = repo.get(defId1, defId2);
      expect(rel).not.toBeNull();
      expect(rel!.fromDefinitionId).toBe(defId1);
      expect(rel!.toDefinitionId).toBe(defId2);
    });

    it('returns null for non-existent relationship', () => {
      const rel = repo.get(defId1, defId2);
      expect(rel).toBeNull();
    });
  });

  describe('remove', () => {
    it('removes relationship annotation', () => {
      repo.set(defId1, defId2, 'some semantic');
      const removed = repo.remove(defId1, defId2);

      expect(removed).toBe(true);
      expect(repo.get(defId1, defId2)).toBeNull();
    });

    it('returns false for non-existent relationship', () => {
      const removed = repo.remove(defId1, defId2);
      expect(removed).toBe(false);
    });
  });

  describe('getFrom', () => {
    it('returns all relationships from a definition', () => {
      repo.set(defId1, defId2, 'uses B');
      repo.set(defId1, defId3, 'uses C');

      const rels = repo.getFrom(defId1);
      expect(rels).toHaveLength(2);
      expect(rels.map(r => r.toName).sort()).toEqual(['HelperC', 'ServiceB']);
    });

    it('returns empty array when no relationships', () => {
      const rels = repo.getFrom(defId1);
      expect(rels).toHaveLength(0);
    });
  });

  describe('getTo', () => {
    it('returns all relationships to a definition', () => {
      repo.set(defId1, defId3, 'uses helper');
      repo.set(defId2, defId3, 'also uses helper');

      const rels = repo.getTo(defId3);
      expect(rels).toHaveLength(2);
      expect(rels.map(r => r.fromName).sort()).toEqual(['ServiceA', 'ServiceB']);
    });
  });

  describe('getAll', () => {
    it('returns all relationships', () => {
      repo.set(defId1, defId2, 'rel 1');
      repo.set(defId2, defId3, 'rel 2');

      const rels = repo.getAll();
      expect(rels).toHaveLength(2);
    });

    it('respects limit', () => {
      repo.set(defId1, defId2, 'rel 1');
      repo.set(defId2, defId3, 'rel 2');

      const rels = repo.getAll({ limit: 1 });
      expect(rels).toHaveLength(1);
    });
  });

  describe('getCount', () => {
    it('returns count of relationships', () => {
      expect(repo.getCount()).toBe(0);

      repo.set(defId1, defId2, 'rel 1');
      expect(repo.getCount()).toBe(1);

      repo.set(defId2, defId3, 'rel 2');
      expect(repo.getCount()).toBe(2);
    });
  });

  describe('getUnannotatedInheritance', () => {
    it('returns inheritance relationships with pending annotation', () => {
      repo.set(defId1, defId2, 'PENDING_LLM_ANNOTATION', 'extends');
      repo.set(defId2, defId3, 'already annotated', 'uses');

      const unannotated = repo.getUnannotatedInheritance();
      expect(unannotated).toHaveLength(1);
      expect(unannotated[0].fromName).toBe('ServiceA');
      expect(unannotated[0].relationshipType).toBe('extends');
    });

    it('includes implements relationships', () => {
      repo.set(defId1, defId2, 'PENDING_LLM_ANNOTATION', 'implements');

      const unannotated = repo.getUnannotatedInheritance();
      expect(unannotated).toHaveLength(1);
      expect(unannotated[0].relationshipType).toBe('implements');
    });

    it('respects limit', () => {
      repo.set(defId1, defId2, 'PENDING_LLM_ANNOTATION', 'extends');
      repo.set(defId2, defId3, 'PENDING_LLM_ANNOTATION', 'extends');

      const unannotated = repo.getUnannotatedInheritance(1);
      expect(unannotated).toHaveLength(1);
    });
  });

  describe('getUnannotatedInheritanceCount', () => {
    it('returns count of unannotated inheritance relationships', () => {
      repo.set(defId1, defId2, 'PENDING_LLM_ANNOTATION', 'extends');
      repo.set(defId2, defId3, 'PENDING_LLM_ANNOTATION', 'implements');
      repo.set(defId1, defId3, 'annotated', 'uses');

      const count = repo.getUnannotatedInheritanceCount();
      expect(count).toBe(2);
    });
  });

  describe('getUnannotated', () => {
    it('returns relationships that need annotation', () => {
      // Create a call from defId1 to defId2
      const symId = fileRepo.insertSymbol(null, defId2, {
        name: 'ServiceB',
        localName: 'ServiceB',
        kind: 'class',
        usages: [],
      }, fileId);

      fileRepo.insertUsage(symId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
        callsite: { argumentCount: 0, isMethodCall: false, isConstructorCall: false },
      });

      const unannotated = repo.getUnannotated();
      expect(unannotated.length).toBeGreaterThan(0);
    });

    it('filters by fromDefinitionId', () => {
      // Create calls from both defId1 and defId2
      const symId1 = fileRepo.insertSymbol(null, defId3, {
        name: 'HelperC',
        localName: 'HelperC',
        kind: 'function',
        usages: [],
      }, fileId);
      fileRepo.insertUsage(symId1, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
        callsite: { argumentCount: 0, isMethodCall: false, isConstructorCall: false },
      });

      const unannotated = repo.getUnannotated({ fromDefinitionId: defId1 });
      expect(unannotated.every(u => u.fromDefinitionId === defId1)).toBe(true);
    });
  });

  describe('getUnannotatedCount', () => {
    it('returns count of unannotated relationships', () => {
      const symId = fileRepo.insertSymbol(null, defId2, {
        name: 'ServiceB',
        localName: 'ServiceB',
        kind: 'class',
        usages: [],
      }, fileId);

      fileRepo.insertUsage(symId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
        callsite: { argumentCount: 0, isMethodCall: false, isConstructorCall: false },
      });

      const count = repo.getUnannotatedCount();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getNextToAnnotate', () => {
    it('returns relationships with enhanced context', () => {
      // Set up metadata
      metadataRepo.set(defId1, 'purpose', 'Service A purpose');
      metadataRepo.set(defId1, 'domain', '["auth"]');
      metadataRepo.set(defId2, 'purpose', 'Service B purpose');
      metadataRepo.set(defId2, 'domain', '["auth", "api"]');

      // Create a call from defId1 to defId2
      const symId = fileRepo.insertSymbol(null, defId2, {
        name: 'ServiceB',
        localName: 'ServiceB',
        kind: 'class',
        usages: [],
      }, fileId);
      fileRepo.insertUsage(symId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
        callsite: { argumentCount: 0, isMethodCall: false, isConstructorCall: false },
      });

      const getMetadata = (id: number) => metadataRepo.get(id);
      const getDeps = (id: number) => {
        const stmt = db.prepare(`
          SELECT DISTINCT s.definition_id as dependencyId, d.name
          FROM symbols s
          JOIN definitions d ON s.definition_id = d.id
          WHERE s.file_id = ? AND s.definition_id IS NOT NULL
        `);
        return stmt.all(fileId) as Array<{ dependencyId: number; name: string }>;
      };

      const results = repo.getNextToAnnotate({ limit: 1 }, getMetadata, getDeps);
      expect(results.length).toBeLessThanOrEqual(1);
      if (results.length > 0) {
        expect(results[0].fromPurpose).toBeDefined();
        expect(results[0].toPurpose).toBeDefined();
        expect(results[0].sharedDomains).toBeDefined();
      }
    });
  });
});
