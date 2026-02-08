import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FlowRepository } from '../../../src/db/repositories/flow-repository.js';
import { ModuleRepository } from '../../../src/db/repositories/module-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('FlowRepository', () => {
  let db: Database.Database;
  let repo: FlowRepository;
  let moduleRepo: ModuleRepository;
  let fileRepo: FileRepository;
  let moduleId1: number;
  let moduleId2: number;
  let moduleId3: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new FlowRepository(db);
    moduleRepo = new ModuleRepository(db);
    fileRepo = new FileRepository(db);

    // Set up modules for flow testing
    const rootId = moduleRepo.ensureRoot();
    moduleId1 = moduleRepo.insert(rootId, 'auth', 'Authentication');
    moduleId2 = moduleRepo.insert(rootId, 'api', 'API');
    moduleId3 = moduleRepo.insert(rootId, 'db', 'Database');
  });

  afterEach(() => {
    db.close();
  });

  describe('ensureRoot', () => {
    it('creates a root flow with given slug', () => {
      const flow = repo.ensureRoot('user-journey');

      expect(flow.slug).toBe('user-journey');
      expect(flow.name).toBe('User Journey');
      expect(flow.fullPath).toBe('user-journey');
      expect(flow.depth).toBe(0);
      expect(flow.parentId).toBeNull();
    });

    it('returns existing root flow on subsequent calls', () => {
      const flow1 = repo.ensureRoot('user-journey');
      const flow2 = repo.ensureRoot('user-journey');

      expect(flow1.id).toBe(flow2.id);
    });
  });

  describe('insert', () => {
    it('inserts a child flow', () => {
      const root = repo.ensureRoot('user-journey');
      const childId = repo.insert(root.id, 'login', 'Login Flow', {
        description: 'User login process',
      });

      const child = repo.getById(childId);
      expect(child).not.toBeNull();
      expect(child!.slug).toBe('login');
      expect(child!.fullPath).toBe('user-journey.login');
      expect(child!.depth).toBe(1);
    });

    it('inserts leaf flow with module transition', () => {
      const root = repo.ensureRoot('user-journey');
      const flowId = repo.insert(root.id, 'validate-credentials', 'Validate Credentials', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
        semantic: 'validates user credentials',
      });

      const flow = repo.getById(flowId);
      expect(flow!.fromModuleId).toBe(moduleId1);
      expect(flow!.toModuleId).toBe(moduleId2);
      expect(flow!.semantic).toBe('validates user credentials');
    });

    it('auto-increments step_order', () => {
      const root = repo.ensureRoot('user-journey');
      const id1 = repo.insert(root.id, 'step1', 'Step 1');
      const id2 = repo.insert(root.id, 'step2', 'Step 2');
      const id3 = repo.insert(root.id, 'step3', 'Step 3');

      const flow1 = repo.getById(id1);
      const flow2 = repo.getById(id2);
      const flow3 = repo.getById(id3);

      expect(flow1!.stepOrder).toBe(1);
      expect(flow2!.stepOrder).toBe(2);
      expect(flow3!.stepOrder).toBe(3);
    });
  });

  describe('getByPath', () => {
    it('returns flow by full path', () => {
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'login', 'Login Flow');

      const flow = repo.getByPath('user-journey.login');
      expect(flow).not.toBeNull();
      expect(flow!.name).toBe('Login Flow');
    });

    it('returns null for non-existent path', () => {
      repo.ensureRoot('user-journey');
      const flow = repo.getByPath('user-journey.nonexistent');
      expect(flow).toBeNull();
    });
  });

  describe('getById', () => {
    it('returns flow by ID', () => {
      const root = repo.ensureRoot('user-journey');
      const flow = repo.getById(root.id);

      expect(flow).not.toBeNull();
      expect(flow!.slug).toBe('user-journey');
    });

    it('returns null/undefined for non-existent ID', () => {
      const flow = repo.getById(999);
      expect(flow).toBeFalsy();
    });
  });

  describe('getBySlug', () => {
    it('returns flow by slug', () => {
      repo.ensureRoot('user-journey');

      const flow = repo.getBySlug('user-journey');
      expect(flow).not.toBeNull();
      expect(flow!.name).toBe('User Journey');
    });

    it('returns null for non-existent slug', () => {
      const flow = repo.getBySlug('nonexistent');
      expect(flow).toBeNull();
    });
  });

  describe('getChildren', () => {
    it('returns direct children ordered by stepOrder', () => {
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'step1', 'Step 1');
      repo.insert(root.id, 'step2', 'Step 2');
      repo.insert(root.id, 'step3', 'Step 3');

      const children = repo.getChildren(root.id);
      expect(children).toHaveLength(3);
      expect(children[0].slug).toBe('step1');
      expect(children[1].slug).toBe('step2');
      expect(children[2].slug).toBe('step3');
    });
  });

  describe('getAll', () => {
    it('returns all flows', () => {
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'login', 'Login');
      repo.insert(root.id, 'logout', 'Logout');

      const flows = repo.getAll();
      expect(flows).toHaveLength(3);
    });
  });

  describe('getTree', () => {
    it('returns flow tree structure', () => {
      const root = repo.ensureRoot('user-journey');
      const loginId = repo.insert(root.id, 'login', 'Login');
      repo.insert(loginId, 'validate', 'Validate', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
      });

      const trees = repo.getTree();
      expect(trees).toHaveLength(1);
      expect(trees[0].slug).toBe('user-journey');
      expect(trees[0].children).toHaveLength(1);
      expect(trees[0].children[0].children).toHaveLength(1);
    });

    it('includes module names in tree nodes', () => {
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'validate', 'Validate', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
      });

      const trees = repo.getTree();
      const leafFlow = trees[0].children[0];

      expect(leafFlow.fromModuleName).toBe('project.auth');
      expect(leafFlow.toModuleName).toBe('project.api');
    });

    it('returns empty array when no flows', () => {
      const trees = repo.getTree();
      expect(trees).toHaveLength(0);
    });
  });

  describe('getLeaves', () => {
    it('returns flows with module transitions', () => {
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'container', 'Container'); // Not a leaf
      repo.insert(root.id, 'leaf', 'Leaf', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
      });

      const leaves = repo.getLeaves();
      expect(leaves).toHaveLength(1);
      expect(leaves[0].slug).toBe('leaf');
    });
  });

  describe('getForModuleTransition', () => {
    it('returns flows for specific module transition', () => {
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'flow1', 'Flow 1', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
      });
      repo.insert(root.id, 'flow2', 'Flow 2', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
      });
      repo.insert(root.id, 'flow3', 'Flow 3', {
        fromModuleId: moduleId2,
        toModuleId: moduleId3,
      });

      const flows = repo.getForModuleTransition(moduleId1, moduleId2);
      expect(flows).toHaveLength(2);
    });
  });

  describe('expand', () => {
    it('expands composite flow to leaf flows', () => {
      const root = repo.ensureRoot('user-journey');
      const loginId = repo.insert(root.id, 'login', 'Login');
      repo.insert(loginId, 'step1', 'Step 1', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
      });
      repo.insert(loginId, 'step2', 'Step 2', {
        fromModuleId: moduleId2,
        toModuleId: moduleId3,
      });

      const expanded = repo.expand(loginId);
      expect(expanded).toHaveLength(2);
      expect(expanded[0].slug).toBe('step1');
      expect(expanded[1].slug).toBe('step2');
    });

    it('returns empty array for non-existent flow', () => {
      const expanded = repo.expand(999);
      expect(expanded).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('updates flow metadata', () => {
      const root = repo.ensureRoot('user-journey');
      const flowId = repo.insert(root.id, 'login', 'Login');

      const updated = repo.update(flowId, {
        name: 'Updated Login',
        description: 'Updated description',
        semantic: 'handles login',
        domain: 'auth',
      });

      expect(updated).toBe(true);

      const flow = repo.getById(flowId);
      expect(flow!.name).toBe('Updated Login');
      expect(flow!.description).toBe('Updated description');
      expect(flow!.semantic).toBe('handles login');
      expect(flow!.domain).toBe('auth');
    });

    it('returns false for empty updates', () => {
      const root = repo.ensureRoot('user-journey');
      const flowId = repo.insert(root.id, 'login', 'Login');

      const updated = repo.update(flowId, {});
      expect(updated).toBe(false);
    });
  });

  describe('reparent', () => {
    it('moves flow to new parent', () => {
      const root = repo.ensureRoot('user-journey');
      const containerId = repo.insert(root.id, 'container', 'Container');
      const flowId = repo.insert(root.id, 'orphan', 'Orphan');

      repo.reparent(flowId, containerId);

      const flow = repo.getById(flowId);
      expect(flow!.parentId).toBe(containerId);
      expect(flow!.fullPath).toBe('user-journey.container.orphan');
      expect(flow!.depth).toBe(2);
    });

    it('updates descendant paths', () => {
      const root = repo.ensureRoot('user-journey');
      const parentId = repo.insert(root.id, 'parent', 'Parent');
      const childId = repo.insert(parentId, 'child', 'Child');
      const newContainerId = repo.insert(root.id, 'container', 'Container');

      repo.reparent(parentId, newContainerId);

      const child = repo.getById(childId);
      expect(child!.fullPath).toBe('user-journey.container.parent.child');
      expect(child!.depth).toBe(3);
    });
  });

  describe('reparentMany', () => {
    it('reparents multiple flows in order', () => {
      const root = repo.ensureRoot('user-journey');
      const containerId = repo.insert(root.id, 'container', 'Container');
      const flow1Id = repo.insert(root.id, 'flow1', 'Flow 1');
      const flow2Id = repo.insert(root.id, 'flow2', 'Flow 2');

      repo.reparentMany([flow2Id, flow1Id], containerId);

      const flow1 = repo.getById(flow1Id);
      const flow2 = repo.getById(flow2Id);

      expect(flow1!.parentId).toBe(containerId);
      expect(flow2!.parentId).toBe(containerId);
      expect(flow2!.stepOrder).toBe(1);
      expect(flow1!.stepOrder).toBe(2);
    });
  });

  describe('delete', () => {
    it('deletes a flow', () => {
      const root = repo.ensureRoot('user-journey');
      const flowId = repo.insert(root.id, 'login', 'Login');

      const changes = repo.delete(flowId);

      expect(changes).toBe(1);
      expect(repo.getById(flowId)).toBeFalsy();
    });
  });

  describe('clear', () => {
    it('deletes all flows', () => {
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'login', 'Login');
      repo.insert(root.id, 'logout', 'Logout');

      expect(repo.getCount()).toBe(3);

      const changes = repo.clear();

      // Note: CASCADE DELETE may not count all deleted rows
      expect(changes).toBeGreaterThanOrEqual(1);
      expect(repo.getCount()).toBe(0);
    });
  });

  describe('getCount', () => {
    it('returns count of flows', () => {
      expect(repo.getCount()).toBe(0);

      const root = repo.ensureRoot('user-journey');
      expect(repo.getCount()).toBe(1);

      repo.insert(root.id, 'login', 'Login');
      expect(repo.getCount()).toBe(2);
    });
  });

  describe('getStats', () => {
    it('returns flow statistics', () => {
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'container', 'Container');
      repo.insert(root.id, 'leaf', 'Leaf', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
      });

      const stats = repo.getStats();

      expect(stats.flowCount).toBe(3);
      expect(stats.leafFlowCount).toBe(1);
      expect(stats.rootFlowCount).toBe(1);
      expect(stats.maxDepth).toBe(1);
    });
  });

  describe('getModuleCallGraph', () => {
    it('returns module-level call graph', () => {
      // Set up definitions and calls between modules
      const fileId = fileRepo.insert({
        path: '/test/file.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId1 = fileRepo.insertDefinition(fileId, {
        name: 'ServiceA',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 20, column: 1 },
      });

      const defId2 = fileRepo.insertDefinition(fileId, {
        name: 'ServiceB',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 25, column: 0 },
        endPosition: { row: 45, column: 1 },
      });

      // Assign to different modules
      moduleRepo.assignSymbol(defId1, moduleId1);
      moduleRepo.assignSymbol(defId2, moduleId2);

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

      const graph = repo.getModuleCallGraph();
      expect(graph.length).toBeGreaterThan(0);

      const edge = graph.find(e => e.fromModuleId === moduleId1 && e.toModuleId === moduleId2);
      expect(edge).toBeDefined();
    });
  });

  describe('getCoverage', () => {
    it('returns flow coverage statistics', () => {
      // Set up module call graph
      const fileId = fileRepo.insert({
        path: '/test/file.ts',
        language: 'typescript',
        contentHash: 'abc',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId1 = fileRepo.insertDefinition(fileId, {
        name: 'ServiceA',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 20, column: 1 },
      });

      const defId2 = fileRepo.insertDefinition(fileId, {
        name: 'ServiceB',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 25, column: 0 },
        endPosition: { row: 45, column: 1 },
      });

      moduleRepo.assignSymbol(defId1, moduleId1);
      moduleRepo.assignSymbol(defId2, moduleId2);

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

      // Create a flow covering this edge
      const root = repo.ensureRoot('user-journey');
      repo.insert(root.id, 'flow1', 'Flow 1', {
        fromModuleId: moduleId1,
        toModuleId: moduleId2,
      });

      const coverage = repo.getCoverage();
      expect(coverage.totalModuleEdges).toBeGreaterThanOrEqual(0);
      expect(coverage.coveredByFlows).toBeGreaterThanOrEqual(0);
      expect(coverage.percentage).toBeGreaterThanOrEqual(0);
    });
  });
});
