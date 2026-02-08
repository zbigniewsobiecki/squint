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
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.insertDefinition(fileId, {
        name: 'controller',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.insertDefinition(fileId, {
        name: 'service',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.setRelationshipAnnotation(def1, def2, 'delegates authentication');

      const annotation = db.getRelationshipAnnotation(def1, def2);
      expect(annotation).toBeDefined();
      expect(annotation!.semantic).toBe('delegates authentication');
    });

    it('updates existing annotation', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.insertDefinition(fileId, {
        name: 'controller',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.insertDefinition(fileId, {
        name: 'service',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.setRelationshipAnnotation(def1, def2, 'old description');
      db.setRelationshipAnnotation(def1, def2, 'new description');

      const annotation = db.getRelationshipAnnotation(def1, def2);
      expect(annotation!.semantic).toBe('new description');

      // Should only have one annotation
      expect(db.getRelationshipAnnotationCount()).toBe(1);
    });
  });

  describe('getRelationshipAnnotation', () => {
    it('returns null for non-existent annotation', () => {
      const annotation = db.getRelationshipAnnotation(1, 2);
      expect(annotation).toBeNull();
    });
  });

  describe('removeRelationshipAnnotation', () => {
    it('removes an annotation', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.insertDefinition(fileId, {
        name: 'controller',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.insertDefinition(fileId, {
        name: 'service',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.setRelationshipAnnotation(def1, def2, 'delegates');
      const removed = db.removeRelationshipAnnotation(def1, def2);

      expect(removed).toBe(true);
      expect(db.getRelationshipAnnotation(def1, def2)).toBeNull();
    });

    it('returns false for non-existent annotation', () => {
      const removed = db.removeRelationshipAnnotation(1, 2);
      expect(removed).toBe(false);
    });
  });

  describe('getRelationshipsFrom', () => {
    it('returns all relationships from a definition', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const controller = db.insertDefinition(fileId, {
        name: 'controller',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const authService = db.insertDefinition(fileId, {
        name: 'authService',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const dbService = db.insertDefinition(fileId, {
        name: 'dbService',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      db.setRelationshipAnnotation(controller, authService, 'validates credentials');
      db.setRelationshipAnnotation(controller, dbService, 'persists session');

      const relationships = db.getRelationshipsFrom(controller);
      expect(relationships).toHaveLength(2);
      expect(relationships.map((r) => r.toName).sort()).toEqual(['authService', 'dbService']);
    });
  });

  describe('getRelationshipsTo', () => {
    it('returns all relationships to a definition', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const userController = db.insertDefinition(fileId, {
        name: 'userController',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const authController = db.insertDefinition(fileId, {
        name: 'authController',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const userService = db.insertDefinition(fileId, {
        name: 'userService',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      db.setRelationshipAnnotation(userController, userService, 'fetches user data');
      db.setRelationshipAnnotation(authController, userService, 'validates user');

      const relationships = db.getRelationshipsTo(userService);
      expect(relationships).toHaveLength(2);
      expect(relationships.map((r) => r.fromName).sort()).toEqual(['authController', 'userController']);
    });
  });

  describe('getRelationshipAnnotationCount', () => {
    it('returns count of annotations', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.insertDefinition(fileId, {
        name: 'a',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.insertDefinition(fileId, {
        name: 'b',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const def3 = db.insertDefinition(fileId, {
        name: 'c',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 6, column: 0 },
        endPosition: { row: 8, column: 1 },
      });

      db.setRelationshipAnnotation(def1, def2, 'calls');
      db.setRelationshipAnnotation(def1, def3, 'calls');
      db.setRelationshipAnnotation(def2, def3, 'calls');

      expect(db.getRelationshipAnnotationCount()).toBe(3);
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
    const file1 = db.insertFile({
      path: '/project/controller.ts',
      language: 'typescript',
      contentHash: computeHash('controller'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const file2 = db.insertFile({
      path: '/project/service.ts',
      language: 'typescript',
      contentHash: computeHash('service'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const controllerDefId = db.insertDefinition(file1, {
      name: 'loginController',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 4, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    const serviceDefId = db.insertDefinition(file2, {
      name: 'authService',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 15, column: 1 },
    });

    const helperDefId = db.insertDefinition(file2, {
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

      const relationships = db.getNextRelationshipToAnnotate({ limit: 1 });
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
      db.setDefinitionMetadata(controllerDefId, 'purpose', 'Handles login requests');
      db.setDefinitionMetadata(controllerDefId, 'domain', '["auth", "user"]');
      db.setDefinitionMetadata(controllerDefId, 'role', 'controller');
      db.setDefinitionMetadata(serviceDefId, 'purpose', 'Validates credentials');
      db.setDefinitionMetadata(serviceDefId, 'domain', '["auth"]');
      db.setDefinitionMetadata(serviceDefId, 'pure', 'false');

      const relationships = db.getNextRelationshipToAnnotate({ limit: 1 });
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

      db.setDefinitionMetadata(controllerDefId, 'domain', '["auth", "user"]');
      db.setDefinitionMetadata(serviceDefId, 'domain', '["auth", "security"]');

      const relationships = db.getNextRelationshipToAnnotate({ limit: 1 });
      expect(relationships[0].sharedDomains).toEqual(['auth']);
    });

    it('filters by fromDefinitionId', () => {
      const { controllerDefId } = setupTestData();

      const relationships = db.getNextRelationshipToAnnotate({
        limit: 10,
        fromDefinitionId: controllerDefId,
      });

      expect(relationships.length).toBeGreaterThan(0);
      expect(relationships.every((r) => r.fromDefinitionId === controllerDefId)).toBe(true);
    });

    it('excludes annotated relationships', () => {
      const { controllerDefId, serviceDefId } = setupTestData();

      // Initially should have unannotated
      let relationships = db.getNextRelationshipToAnnotate({ limit: 10 });
      expect(relationships.length).toBeGreaterThan(0);

      // Annotate the relationship
      db.setRelationshipAnnotation(controllerDefId, serviceDefId, 'delegates auth');

      // Now should be excluded
      relationships = db.getNextRelationshipToAnnotate({
        limit: 10,
        fromDefinitionId: controllerDefId,
      });
      const stillHasThisRel = relationships.some(
        (r) => r.fromDefinitionId === controllerDefId && r.toDefinitionId === serviceDefId
      );
      expect(stillHasThisRel).toBe(false);
    });
  });

  describe('getUnannotatedRelationshipCount', () => {
    it('returns count of unannotated relationships', () => {
      setupTestData();

      const count = db.getUnannotatedRelationshipCount();
      expect(count).toBeGreaterThan(0);
    });

    it('decreases after annotation', () => {
      const { controllerDefId, serviceDefId } = setupTestData();

      const before = db.getUnannotatedRelationshipCount();
      db.setRelationshipAnnotation(controllerDefId, serviceDefId, 'delegates');
      const after = db.getUnannotatedRelationshipCount();

      expect(after).toBe(before - 1);
    });

    it('filters by fromDefinitionId', () => {
      const { controllerDefId } = setupTestData();

      const globalCount = db.getUnannotatedRelationshipCount();
      const filteredCount = db.getUnannotatedRelationshipCount(controllerDefId);

      expect(filteredCount).toBeLessThanOrEqual(globalCount);
    });
  });
});
