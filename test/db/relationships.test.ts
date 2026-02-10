import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('Relationship Annotations', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  describe('setRelationshipAnnotation', () => {
    it('creates a relationship annotation', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'controller',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'service',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.relationships.set(def1, def2, 'delegates authentication');

      const annotation = db.relationships.get(def1, def2);
      expect(annotation).toBeDefined();
      expect(annotation!.semantic).toBe('delegates authentication');
    });

    it('updates existing annotation', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'controller',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'service',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.relationships.set(def1, def2, 'old description');
      db.relationships.set(def1, def2, 'new description');

      const annotation = db.relationships.get(def1, def2);
      expect(annotation!.semantic).toBe('new description');

      // Should only have one annotation
      expect(db.relationships.getCount()).toBe(1);
    });
  });

  describe('getRelationshipAnnotation', () => {
    it('returns null for non-existent annotation', () => {
      const annotation = db.relationships.get(1, 2);
      expect(annotation).toBeNull();
    });
  });

  describe('removeRelationshipAnnotation', () => {
    it('removes an annotation', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'controller',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'service',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.relationships.set(def1, def2, 'delegates');
      const removed = db.relationships.remove(def1, def2);

      expect(removed).toBe(true);
      expect(db.relationships.get(def1, def2)).toBeNull();
    });

    it('returns false for non-existent annotation', () => {
      const removed = db.relationships.remove(1, 2);
      expect(removed).toBe(false);
    });
  });

  describe('getRelationshipsFrom', () => {
    it('returns all relationships from a definition', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const controller = db.files.insertDefinition(fileId, {
        name: 'controller',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const authService = db.files.insertDefinition(fileId, {
        name: 'authService',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const dbService = db.files.insertDefinition(fileId, {
        name: 'dbService',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      db.relationships.set(controller, authService, 'validates credentials');
      db.relationships.set(controller, dbService, 'persists session');

      const relationships = db.relationships.getFrom(controller);
      expect(relationships).toHaveLength(2);
      expect(relationships.map((r) => r.toName).sort()).toEqual(['authService', 'dbService']);
    });
  });

  describe('getRelationshipsTo', () => {
    it('returns all relationships to a definition', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const userController = db.files.insertDefinition(fileId, {
        name: 'userController',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const authController = db.files.insertDefinition(fileId, {
        name: 'authController',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const userService = db.files.insertDefinition(fileId, {
        name: 'userService',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      db.relationships.set(userController, userService, 'fetches user data');
      db.relationships.set(authController, userService, 'validates user');

      const relationships = db.relationships.getTo(userService);
      expect(relationships).toHaveLength(2);
      expect(relationships.map((r) => r.fromName).sort()).toEqual(['authController', 'userController']);
    });
  });

  describe('getRelationshipAnnotationCount', () => {
    it('returns count of annotations', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'a',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'b',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const def3 = db.files.insertDefinition(fileId, {
        name: 'c',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      db.relationships.set(def1, def2, 'calls');
      db.relationships.set(def1, def3, 'calls');
      db.relationships.set(def2, def3, 'calls');

      expect(db.relationships.getCount()).toBe(3);
    });
  });
});

describe('Enhanced Relationship Context', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  function setupTestData(): { controllerDefId: number; serviceDefId: number; helperDefId: number } {
    const file1 = db.files.insert({
      path: '/project/controller.ts',
      language: 'typescript',
      contentHash: computeHash('controller'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const file2 = db.files.insert({
      path: '/project/service.ts',
      language: 'typescript',
      contentHash: computeHash('service'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const controllerDefId = db.files.insertDefinition(file1, {
      name: 'loginController',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 4, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    const serviceDefId = db.files.insertDefinition(file2, {
      name: 'authService',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 15, column: 1 },
    });

    const helperDefId = db.files.insertDefinition(file2, {
      name: 'hashPassword',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 17, column: 0 },
      endPosition: { row: 22, column: 1 },
    });

    // Create import and symbol linking
    const importId = db.insertReference(file1, file2, {
      type: 'import',
      source: './service',
      isExternal: false,
      isTypeOnly: false,
      imports: [],
      position: { row: 0, column: 0 },
    });

    const symbolId = db.insertSymbol(importId, serviceDefId, {
      name: 'authService',
      localName: 'authService',
      kind: 'named',
      usages: [],
    });

    // Usage within controller's line range
    db.insertUsage(symbolId, {
      position: { row: 9, column: 10 },
      context: 'call_expression',
    });

    return { controllerDefId, serviceDefId, helperDefId };
  }

  describe('getNextRelationshipToAnnotate', () => {
    it('returns unannotated relationships with context', () => {
      const { controllerDefId, serviceDefId } = setupTestData();

      const relationships = db.relationships.getNextToAnnotate(
        { limit: 1 },
        (id) => db.metadata.get(id),
        (id) => db.dependencies.getForDefinition(id)
      );
      expect(relationships).toHaveLength(1);

      const rel = relationships[0];
      expect(rel.fromDefinitionId).toBe(controllerDefId);
      expect(rel.toDefinitionId).toBe(serviceDefId);
      expect(rel.fromName).toBe('loginController');
      expect(rel.toName).toBe('authService');
      expect(rel.relationshipType).toBe('call');
    });

    it('includes metadata when set', () => {
      const { controllerDefId, serviceDefId } = setupTestData();

      // Set metadata
      db.metadata.set(controllerDefId, 'purpose', 'Handles login requests');
      db.metadata.set(controllerDefId, 'domain', '["auth", "user"]');
      db.metadata.set(controllerDefId, 'role', 'controller');
      db.metadata.set(serviceDefId, 'purpose', 'Validates credentials');
      db.metadata.set(serviceDefId, 'domain', '["auth"]');
      db.metadata.set(serviceDefId, 'pure', 'false');

      const relationships = db.relationships.getNextToAnnotate(
        { limit: 1 },
        (id) => db.metadata.get(id),
        (id) => db.dependencies.getForDefinition(id)
      );
      const rel = relationships[0];

      expect(rel.fromPurpose).toBe('Handles login requests');
      expect(rel.fromDomains).toEqual(['auth', 'user']);
      expect(rel.fromRole).toBe('controller');
      expect(rel.toPurpose).toBe('Validates credentials');
      expect(rel.toDomains).toEqual(['auth']);
      expect(rel.toPure).toBe(false);
    });

    it('calculates shared domains', () => {
      const { controllerDefId, serviceDefId } = setupTestData();

      db.metadata.set(controllerDefId, 'domain', '["auth", "user"]');
      db.metadata.set(serviceDefId, 'domain', '["auth", "security"]');

      const relationships = db.relationships.getNextToAnnotate(
        { limit: 1 },
        (id) => db.metadata.get(id),
        (id) => db.dependencies.getForDefinition(id)
      );
      expect(relationships[0].sharedDomains).toEqual(['auth']);
    });

    it('filters by fromDefinitionId', () => {
      const { controllerDefId } = setupTestData();

      const relationships = db.relationships.getNextToAnnotate(
        {
          limit: 10,
          fromDefinitionId: controllerDefId,
        },
        (id) => db.metadata.get(id),
        (id) => db.dependencies.getForDefinition(id)
      );

      expect(relationships.length).toBeGreaterThan(0);
      expect(relationships.every((r) => r.fromDefinitionId === controllerDefId)).toBe(true);
    });

    it('excludes annotated relationships', () => {
      const { controllerDefId, serviceDefId } = setupTestData();

      // Initially should have unannotated
      let relationships = db.relationships.getNextToAnnotate(
        { limit: 10 },
        (id) => db.metadata.get(id),
        (id) => db.dependencies.getForDefinition(id)
      );
      expect(relationships.length).toBeGreaterThan(0);

      // Annotate the relationship
      db.relationships.set(controllerDefId, serviceDefId, 'delegates auth');

      // Now should be excluded
      relationships = db.relationships.getNextToAnnotate(
        {
          limit: 10,
          fromDefinitionId: controllerDefId,
        },
        (id) => db.metadata.get(id),
        (id) => db.dependencies.getForDefinition(id)
      );
      const stillHasThisRel = relationships.some(
        (r) => r.fromDefinitionId === controllerDefId && r.toDefinitionId === serviceDefId
      );
      expect(stillHasThisRel).toBe(false);
    });
  });

  describe('getUnannotatedRelationshipCount', () => {
    it('returns count of unannotated relationships', () => {
      setupTestData();

      const count = db.relationships.getUnannotatedCount();
      expect(count).toBeGreaterThan(0);
    });

    it('decreases after annotation', () => {
      const { controllerDefId, serviceDefId } = setupTestData();

      const before = db.relationships.getUnannotatedCount();
      db.relationships.set(controllerDefId, serviceDefId, 'delegates');
      const after = db.relationships.getUnannotatedCount();

      expect(after).toBe(before - 1);
    });

    it('filters by fromDefinitionId', () => {
      const { controllerDefId } = setupTestData();

      const globalCount = db.relationships.getUnannotatedCount();
      const filteredCount = db.relationships.getUnannotatedCount(controllerDefId);

      expect(filteredCount).toBeLessThanOrEqual(globalCount);
    });
  });
});
