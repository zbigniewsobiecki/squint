import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CallGraphService } from '../../../src/db/repositories/call-graph-service.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { InteractionAnalysis } from '../../../src/db/repositories/interaction-analysis.js';
import { InteractionRepository } from '../../../src/db/repositories/interaction-repository.js';
import { ModuleRepository } from '../../../src/db/repositories/module-repository.js';
import { RelationshipRepository } from '../../../src/db/repositories/relationship-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('InteractionRepository', () => {
  let db: Database.Database;
  let repo: InteractionRepository;
  let moduleRepo: ModuleRepository;
  let fileRepo: FileRepository;
  let relationshipRepo: RelationshipRepository;
  let callGraphService: CallGraphService;
  let interactionAnalysis: InteractionAnalysis;
  let moduleId1: number;
  let moduleId2: number;
  let moduleId3: number;
  let defId1: number;
  let defId2: number;
  let defId3: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new InteractionRepository(db);
    moduleRepo = new ModuleRepository(db);
    fileRepo = new FileRepository(db);
    relationshipRepo = new RelationshipRepository(db);
    callGraphService = new CallGraphService(db);
    interactionAnalysis = new InteractionAnalysis(db);

    // Set up test modules
    const rootId = moduleRepo.ensureRoot();
    moduleId1 = moduleRepo.insert(rootId, 'auth', 'Authentication');
    moduleId2 = moduleRepo.insert(rootId, 'api', 'API');
    moduleId3 = moduleRepo.insert(rootId, 'core', 'Core');

    // Set up test definitions
    const fileId = fileRepo.insert({
      path: '/test/file.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    defId1 = fileRepo.insertDefinition(fileId, {
      name: 'AuthService',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    defId2 = fileRepo.insertDefinition(fileId, {
      name: 'ApiHandler',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 25, column: 0 },
      endPosition: { row: 45, column: 1 },
    });

    defId3 = fileRepo.insertDefinition(fileId, {
      name: 'CoreUtils',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 50, column: 0 },
      endPosition: { row: 60, column: 1 },
    });

    // Assign definitions to modules
    moduleRepo.assignSymbol(defId1, moduleId1);
    moduleRepo.assignSymbol(defId2, moduleId2);
    moduleRepo.assignSymbol(defId3, moduleId3);
  });

  afterEach(() => {
    db.close();
  });

  describe('insert', () => {
    it('inserts a new interaction', () => {
      const id = repo.insert(moduleId1, moduleId2);

      expect(id).toBeGreaterThan(0);
      expect(repo.getCount()).toBe(1);
    });

    it('inserts with options', () => {
      const id = repo.insert(moduleId1, moduleId2, {
        direction: 'bi',
        weight: 5,
        pattern: 'business',
        symbols: ['login', 'logout'],
        semantic: 'Authentication flow',
        source: 'llm-inferred',
      });

      const interaction = repo.getById(id);
      expect(interaction).not.toBeNull();
      expect(interaction!.direction).toBe('bi');
      expect(interaction!.weight).toBe(5);
      expect(interaction!.pattern).toBe('business');
      expect(interaction!.symbols).toEqual(['login', 'logout']);
      expect(interaction!.semantic).toBe('Authentication flow');
      expect(interaction!.source).toBe('llm-inferred');
    });

    it('throws on duplicate module pair', () => {
      repo.insert(moduleId1, moduleId2);
      expect(() => repo.insert(moduleId1, moduleId2)).toThrow();
    });
  });

  describe('upsert', () => {
    it('inserts when interaction does not exist', () => {
      const id = repo.upsert(moduleId1, moduleId2, { weight: 3 });

      expect(repo.getCount()).toBe(1);
      const interaction = repo.getById(id);
      expect(interaction!.weight).toBe(3);
    });

    it('updates when interaction exists', () => {
      const id1 = repo.insert(moduleId1, moduleId2, { weight: 1 });
      const id2 = repo.upsert(moduleId1, moduleId2, { weight: 5, pattern: 'utility' });

      expect(id1).toBe(id2);
      expect(repo.getCount()).toBe(1);
      const interaction = repo.getById(id2);
      expect(interaction!.weight).toBe(5);
      expect(interaction!.pattern).toBe('utility');
    });
  });

  describe('getById', () => {
    it('returns interaction by ID', () => {
      const id = repo.insert(moduleId1, moduleId2, { semantic: 'test' });

      const interaction = repo.getById(id);

      expect(interaction).not.toBeNull();
      expect(interaction!.id).toBe(id);
      expect(interaction!.fromModuleId).toBe(moduleId1);
      expect(interaction!.toModuleId).toBe(moduleId2);
    });

    it('returns null for non-existent ID', () => {
      const interaction = repo.getById(999);
      expect(interaction).toBeNull();
    });

    it('parses symbols JSON', () => {
      const id = repo.insert(moduleId1, moduleId2, { symbols: ['a', 'b', 'c'] });

      const interaction = repo.getById(id);

      expect(interaction!.symbols).toEqual(['a', 'b', 'c']);
    });
  });

  describe('getByModules', () => {
    it('returns interaction by module pair', () => {
      repo.insert(moduleId1, moduleId2);

      const interaction = repo.getByModules(moduleId1, moduleId2);

      expect(interaction).not.toBeNull();
      expect(interaction!.fromModuleId).toBe(moduleId1);
      expect(interaction!.toModuleId).toBe(moduleId2);
    });

    it('returns null for non-existent pair', () => {
      const interaction = repo.getByModules(moduleId1, moduleId3);
      expect(interaction).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns all interactions with module paths', () => {
      repo.insert(moduleId1, moduleId2);
      repo.insert(moduleId2, moduleId3);

      const interactions = repo.getAll();

      expect(interactions).toHaveLength(2);
      expect(interactions[0].fromModulePath).toBeDefined();
      expect(interactions[0].toModulePath).toBeDefined();
    });

    it('orders by weight descending', () => {
      repo.insert(moduleId1, moduleId2, { weight: 5 });
      repo.insert(moduleId2, moduleId3, { weight: 10 });

      const interactions = repo.getAll();

      expect(interactions[0].weight).toBe(10);
      expect(interactions[1].weight).toBe(5);
    });
  });

  describe('getByPattern', () => {
    it('returns interactions filtered by pattern', () => {
      repo.insert(moduleId1, moduleId2, { pattern: 'business' });
      repo.insert(moduleId2, moduleId3, { pattern: 'utility' });

      const business = repo.getByPattern('business');
      const utility = repo.getByPattern('utility');

      expect(business).toHaveLength(1);
      expect(business[0].pattern).toBe('business');
      expect(utility).toHaveLength(1);
      expect(utility[0].pattern).toBe('utility');
    });
  });

  describe('getFromModule', () => {
    it('returns interactions originating from a module', () => {
      repo.insert(moduleId1, moduleId2);
      repo.insert(moduleId1, moduleId3);
      repo.insert(moduleId2, moduleId3);

      const interactions = repo.getFromModule(moduleId1);

      expect(interactions).toHaveLength(2);
      expect(interactions.every((i) => i.fromModuleId === moduleId1)).toBe(true);
    });
  });

  describe('getToModule', () => {
    it('returns interactions targeting a module', () => {
      repo.insert(moduleId1, moduleId3);
      repo.insert(moduleId2, moduleId3);
      repo.insert(moduleId1, moduleId2);

      const interactions = repo.getToModule(moduleId3);

      expect(interactions).toHaveLength(2);
      expect(interactions.every((i) => i.toModuleId === moduleId3)).toBe(true);
    });
  });

  describe('update', () => {
    it('updates interaction fields', () => {
      const id = repo.insert(moduleId1, moduleId2, { direction: 'uni' });

      const updated = repo.update(id, {
        direction: 'bi',
        pattern: 'business',
        semantic: 'Updated semantic',
      });

      expect(updated).toBe(true);
      const interaction = repo.getById(id);
      expect(interaction!.direction).toBe('bi');
      expect(interaction!.pattern).toBe('business');
      expect(interaction!.semantic).toBe('Updated semantic');
    });

    it('returns false when nothing to update', () => {
      const id = repo.insert(moduleId1, moduleId2);
      const updated = repo.update(id, {});
      expect(updated).toBe(false);
    });

    it('updates symbols as JSON', () => {
      const id = repo.insert(moduleId1, moduleId2);

      repo.update(id, { symbols: ['x', 'y', 'z'] });

      const interaction = repo.getById(id);
      expect(interaction!.symbols).toEqual(['x', 'y', 'z']);
    });
  });

  describe('delete', () => {
    it('deletes an interaction', () => {
      const id = repo.insert(moduleId1, moduleId2);

      const deleted = repo.delete(id);

      expect(deleted).toBe(true);
      expect(repo.getById(id)).toBeNull();
    });

    it('returns false for non-existent ID', () => {
      const deleted = repo.delete(999);
      expect(deleted).toBe(false);
    });
  });

  describe('clear', () => {
    it('deletes all interactions', () => {
      repo.insert(moduleId1, moduleId2);
      repo.insert(moduleId2, moduleId3);

      const count = repo.clear();

      expect(count).toBe(2);
      expect(repo.getCount()).toBe(0);
    });
  });

  describe('getCount', () => {
    it('returns count of interactions', () => {
      expect(repo.getCount()).toBe(0);

      repo.insert(moduleId1, moduleId2);
      expect(repo.getCount()).toBe(1);

      repo.insert(moduleId2, moduleId3);
      expect(repo.getCount()).toBe(2);
    });
  });

  describe('getStats', () => {
    it('returns interaction statistics', () => {
      repo.insert(moduleId1, moduleId2, { pattern: 'business', direction: 'bi' });
      repo.insert(moduleId2, moduleId3, { pattern: 'utility', direction: 'uni' });
      repo.insert(moduleId1, moduleId3, { pattern: 'business', direction: 'uni' });

      const stats = repo.getStats();

      expect(stats.totalCount).toBe(3);
      expect(stats.businessCount).toBe(2);
      expect(stats.utilityCount).toBe(1);
      expect(stats.biDirectionalCount).toBe(1);
    });
  });

  describe('confidence', () => {
    it('inserts with confidence', () => {
      const id = repo.insert(moduleId1, moduleId2, {
        source: 'llm-inferred',
        confidence: 'high',
      });

      const interaction = repo.getById(id);
      expect(interaction).not.toBeNull();
      expect(interaction!.confidence).toBe('high');
    });

    it('defaults confidence to null', () => {
      const id = repo.insert(moduleId1, moduleId2);

      const interaction = repo.getById(id);
      expect(interaction!.confidence).toBeNull();
    });

    it('persists confidence on upsert (insert path)', () => {
      const id = repo.upsert(moduleId1, moduleId2, {
        source: 'llm-inferred',
        confidence: 'medium',
      });

      const interaction = repo.getById(id);
      expect(interaction!.confidence).toBe('medium');
    });

    it('updates confidence on upsert (update path)', () => {
      repo.insert(moduleId1, moduleId2, {
        source: 'llm-inferred',
        confidence: 'medium',
      });

      repo.upsert(moduleId1, moduleId2, {
        confidence: 'high',
      });

      const interaction = repo.getByModules(moduleId1, moduleId2);
      expect(interaction!.confidence).toBe('high');
    });

    it('confidence returned in getAll()', () => {
      repo.insert(moduleId1, moduleId2, {
        source: 'llm-inferred',
        confidence: 'high',
      });

      const all = repo.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].confidence).toBe('high');
    });
  });

  describe('removeInferredToModule', () => {
    it('removes all llm-inferred to target, keeps AST', () => {
      // AST interaction targeting moduleId3
      repo.insert(moduleId1, moduleId2, { source: 'ast' });
      // LLM-inferred interactions targeting moduleId2
      repo.insert(moduleId1, moduleId3, { source: 'llm-inferred' });
      repo.insert(moduleId2, moduleId3, { source: 'llm-inferred' });

      const removed = repo.removeInferredToModule(moduleId3);

      expect(removed).toBe(2);
      expect(repo.getCount()).toBe(1);
      // The AST one should remain
      const remaining = repo.getByModules(moduleId1, moduleId2);
      expect(remaining).not.toBeNull();
      expect(remaining!.source).toBe('ast');
    });

    it('returns 0 when no llm-inferred interactions to target', () => {
      repo.insert(moduleId1, moduleId2, { source: 'ast' });

      const removed = repo.removeInferredToModule(moduleId2);
      expect(removed).toBe(0);
      expect(repo.getCount()).toBe(1);
    });
  });

  describe('getBySource', () => {
    it('returns interactions filtered by source', () => {
      repo.insert(moduleId1, moduleId2, { source: 'ast' });
      repo.insert(moduleId2, moduleId3, { source: 'llm-inferred' });

      const ast = repo.getBySource('ast');
      const llm = repo.getBySource('llm-inferred');

      expect(ast).toHaveLength(1);
      expect(llm).toHaveLength(1);
    });
  });

  describe('getCountBySource', () => {
    it('returns count of interactions by source', () => {
      repo.insert(moduleId1, moduleId2, { source: 'ast' });
      repo.insert(moduleId2, moduleId3, { source: 'ast' });
      repo.insert(moduleId1, moduleId3, { source: 'llm-inferred' });

      expect(repo.getCountBySource('ast')).toBe(2);
      expect(repo.getCountBySource('llm-inferred')).toBe(1);
    });
  });

  describe('getRelationshipCoverage', () => {
    it('returns coverage statistics', () => {
      // Add relationship annotations (set(from, to, semantic, type))
      relationshipRepo.set(defId1, defId2, 'Auth uses API', 'uses');
      relationshipRepo.set(defId2, defId3, 'API uses Core', 'uses');

      // Add interaction that covers one relationship
      repo.insert(moduleId1, moduleId2);

      const coverage = interactionAnalysis.getRelationshipCoverage();

      expect(coverage.totalRelationships).toBe(2);
      expect(coverage.crossModuleRelationships).toBe(2);
      expect(coverage.relationshipsContributingToInteractions).toBe(1);
    });

    it('excludes same-module relationships from coverage', () => {
      // Create a definition in the same module
      const fileId = fileRepo.insert({
        path: '/test/file2.ts',
        language: 'typescript',
        contentHash: 'def456',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const defId4 = fileRepo.insertDefinition(fileId, {
        name: 'AuthHelper',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
      });
      moduleRepo.assignSymbol(defId4, moduleId1); // Same module as defId1

      // Add same-module relationship (note: set(from, to, semantic, type))
      relationshipRepo.set(defId1, defId4, 'Internal use', 'uses');

      const coverage = interactionAnalysis.getRelationshipCoverage();

      expect(coverage.sameModuleCount).toBe(1);
    });
  });

  describe('getRelationshipCoverageBreakdown', () => {
    it('returns detailed breakdown structure', () => {
      const breakdown = interactionAnalysis.getRelationshipCoverageBreakdown();

      expect(breakdown).toHaveProperty('covered');
      expect(breakdown).toHaveProperty('sameModule');
      expect(breakdown).toHaveProperty('noCallEdge');
      expect(breakdown).toHaveProperty('orphaned');
      expect(breakdown).toHaveProperty('byType');
      expect(breakdown.byType).toHaveProperty('uses');
      expect(breakdown.byType).toHaveProperty('extends');
      expect(breakdown.byType).toHaveProperty('implements');
    });

    it('counts relationships by type', () => {
      // Add relationship annotations (note: set(from, to, semantic, type))
      relationshipRepo.set(defId1, defId2, 'Auth uses API', 'uses');
      relationshipRepo.set(defId2, defId3, 'API uses Core', 'uses');

      const breakdown = interactionAnalysis.getRelationshipCoverageBreakdown();

      // Both symbols have module assignments, so they should be counted
      expect(breakdown.byType.uses).toBe(2);
    });
  });

  describe('syncInheritanceInteractions', () => {
    it('returns created count', () => {
      // Without inheritance relationships, should return 0
      const result = interactionAnalysis.syncInheritanceInteractions();
      expect(result).toHaveProperty('created');
      expect(typeof result.created).toBe('number');
    });

    it('creates interactions for extends relationships', () => {
      // Add extends relationship (note: set(from, to, semantic, type))
      relationshipRepo.set(defId1, defId2, 'Auth extends Api', 'extends');

      const result = interactionAnalysis.syncInheritanceInteractions();

      // Should create an interaction since defId1 (auth) and defId2 (api) are in different modules
      expect(result.created).toBe(1);
    });

    it('does not create duplicate interactions', () => {
      relationshipRepo.set(defId1, defId2, 'Auth extends Api', 'extends');

      // Run twice
      interactionAnalysis.syncInheritanceInteractions();
      const result2 = interactionAnalysis.syncInheritanceInteractions();

      // Second run should not create any new interactions
      expect(result2.created).toBe(0);
    });
  });

  describe('getModuleCallGraph', () => {
    it('returns empty array when no calls exist', () => {
      const edges = callGraphService.getModuleCallGraph();
      expect(edges).toHaveLength(0);
    });
  });

  describe('getEnrichedModuleCallGraph', () => {
    it('returns empty array when no calls exist', () => {
      const edges = callGraphService.getEnrichedModuleCallGraph();
      expect(edges).toHaveLength(0);
    });
  });

  describe('syncFromCallGraph', () => {
    it('returns zero changes when call graph is empty', () => {
      const result = callGraphService.syncFromCallGraph(repo);
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
    });
  });

  describe('getDefinitionCallGraph', () => {
    it('returns empty array when no calls exist', () => {
      const edges = repo.getDefinitionCallGraph();
      expect(edges).toHaveLength(0);
    });
  });

  describe('getDefinitionCallGraphMap', () => {
    it('returns empty map when no calls exist', () => {
      const map = repo.getDefinitionCallGraphMap();
      expect(map.size).toBe(0);
    });
  });

  // ============================================================
  // Process Group Detection Methods
  // ============================================================

  describe('getRuntimeImportEdges', () => {
    let fileId2: number;

    beforeEach(() => {
      fileId2 = fileRepo.insert({
        path: '/test/file2.ts',
        language: 'typescript',
        contentHash: 'def456',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
    });

    it('returns empty array when no imports exist', () => {
      const edges = repo.getRuntimeImportEdges();
      expect(edges).toHaveLength(0);
    });

    it('returns only non-type-only imports', () => {
      const fileId1 = db.prepare("SELECT id FROM files WHERE path = '/test/file.ts'").get() as { id: number };

      // Runtime import
      db.prepare(
        'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(fileId1.id, fileId2, 'import', './file2', 0, 0, 1, 0);

      // Type-only import
      db.prepare(
        'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(fileId2, fileId1.id, 'import', './file', 0, 1, 1, 0);

      const edges = repo.getRuntimeImportEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].fromFileId).toBe(fileId1.id);
      expect(edges[0].toFileId).toBe(fileId2);
    });

    it('excludes imports where to_file_id is NULL (external)', () => {
      const fileId1 = db.prepare("SELECT id FROM files WHERE path = '/test/file.ts'").get() as { id: number };

      // External import (to_file_id = NULL)
      db.prepare(
        'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(fileId1.id, null, 'import', 'lodash', 1, 0, 1, 0);

      // Internal import
      db.prepare(
        'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(fileId1.id, fileId2, 'import', './file2', 0, 0, 2, 0);

      const edges = repo.getRuntimeImportEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].toFileId).toBe(fileId2);
    });

    it('returns distinct edges', () => {
      const fileId1 = db.prepare("SELECT id FROM files WHERE path = '/test/file.ts'").get() as { id: number };

      // Two imports between same files
      db.prepare(
        'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(fileId1.id, fileId2, 'import', './file2', 0, 0, 1, 0);
      db.prepare(
        'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(fileId1.id, fileId2, 'import', './file2', 0, 0, 3, 0);

      const edges = repo.getRuntimeImportEdges();
      expect(edges).toHaveLength(1);
    });
  });

  describe('getFileToModuleMap', () => {
    it('returns map with entries from beforeEach setup', () => {
      // beforeEach already assigns defId1→moduleId1, defId2→moduleId2, defId3→moduleId3
      // All definitions are in the same file, so the map has 1 entry
      const map = repo.getFileToModuleMap();
      expect(map.size).toBe(1);
    });

    it('maps file IDs to module IDs correctly', () => {
      const map = repo.getFileToModuleMap();
      const fileId1 = db.prepare("SELECT id FROM files WHERE path = '/test/file.ts'").get() as { id: number };

      expect(map.has(fileId1.id)).toBe(true);
    });

    it('handles definitions in multiple files', () => {
      const fileId2 = fileRepo.insert({
        path: '/test/file2.ts',
        language: 'typescript',
        contentHash: 'xyz789',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
      const defId4 = fileRepo.insertDefinition(fileId2, {
        name: 'NewService',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
      });
      moduleRepo.assignSymbol(defId4, moduleId2);

      const map = repo.getFileToModuleMap();
      expect(map.has(fileId2)).toBe(true);
      expect(map.get(fileId2)).toBe(moduleId2);
    });
  });

  describe('validateInferredInteractions', () => {
    let fileId2: number;

    beforeEach(() => {
      // Create a second file for import paths
      fileId2 = fileRepo.insert({
        path: '/test/file2.ts',
        language: 'typescript',
        contentHash: 'validate456',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
    });

    it('flags REVERSED when AST interaction exists in reverse direction', () => {
      // AST interaction: moduleId2 → moduleId1
      repo.insert(moduleId2, moduleId1, { source: 'ast' });
      // LLM-inferred interaction: moduleId1 → moduleId2 (reverse)
      repo.insert(moduleId1, moduleId2, { source: 'llm-inferred' });

      const issues = interactionAnalysis.validateInferredInteractions(repo);
      expect(issues).toHaveLength(1);
      expect(issues[0].issue).toContain('REVERSED');
    });

    it('with isSameProcess callback: skips import checks for separate-process pairs', () => {
      // LLM-inferred interaction with no import path
      repo.insert(moduleId1, moduleId2, { source: 'llm-inferred' });

      const isSameProcess = () => false; // All pairs are separate-process
      const issues = interactionAnalysis.validateInferredInteractions(repo, isSameProcess);

      // Should skip import checks for separate-process
      const importIssues = issues.filter(
        (i) => i.issue.includes('NO_IMPORTS') || i.issue.includes('DIRECTION_CONFUSED')
      );
      expect(importIssues).toHaveLength(0);
    });

    it('with isSameProcess callback: applies import checks for same-process pairs', () => {
      // LLM-inferred interaction with no import path
      repo.insert(moduleId1, moduleId2, { source: 'llm-inferred' });

      const isSameProcess = () => true; // All pairs are same-process
      const issues = interactionAnalysis.validateInferredInteractions(repo, isSameProcess);

      // Should report NO_IMPORTS since no import path exists
      expect(issues.some((i) => i.issue.includes('NO_IMPORTS'))).toBe(true);
    });

    it('without callback: treats all as same-process (backward compat)', () => {
      // LLM-inferred interaction with no import path
      repo.insert(moduleId1, moduleId2, { source: 'llm-inferred' });

      const issues = interactionAnalysis.validateInferredInteractions(repo);

      // Should apply import checks (same-process assumption)
      expect(issues.some((i) => i.issue.includes('NO_IMPORTS'))).toBe(true);
    });

    it('separate-process pair with no imports: no issue reported', () => {
      repo.insert(moduleId1, moduleId2, { source: 'llm-inferred' });

      const isSameProcess = () => false;
      const issues = interactionAnalysis.validateInferredInteractions(repo, isSameProcess);

      expect(issues).toHaveLength(0);
    });

    it('same-process pair with reverse imports: DIRECTION_CONFUSED reported', () => {
      const fileId1 = db.prepare("SELECT id FROM files WHERE path = '/test/file.ts'").get() as { id: number };

      // Put moduleId2's definition in file2 so module→file mapping is distinct
      const defId4 = fileRepo.insertDefinition(fileId2, {
        name: 'ApiRouter',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
      });
      moduleRepo.assignSymbol(defId4, moduleId2);

      // Create import from file2 → file1 (reverse: moduleId2 imports from moduleId1)
      db.prepare(
        'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(fileId2, fileId1.id, 'import', './file', 0, 0, 1, 0);

      // LLM-inferred: moduleId1 → moduleId2 (but imports go moduleId2 → moduleId1)
      repo.insert(moduleId1, moduleId2, { source: 'llm-inferred' });

      const isSameProcess = () => true;
      const issues = interactionAnalysis.validateInferredInteractions(repo, isSameProcess);

      expect(issues.some((i) => i.issue.includes('DIRECTION_CONFUSED'))).toBe(true);
    });
  });
});
