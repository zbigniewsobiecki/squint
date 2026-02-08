import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('Hierarchical Flow Detection', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a file
  function createFile(path: string): number {
    return db.insertFile({
      path,
      language: 'typescript',
      contentHash: computeHash(path),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });
  }

  // Helper to create a definition
  function createDefinition(
    fileId: number,
    name: string,
    kind: string,
    startRow: number,
    endRow: number,
    isExported = true
  ): number {
    return db.insertDefinition(fileId, {
      name,
      kind,
      isExported,
      isDefault: false,
      position: { row: startRow, column: 0 },
      endPosition: { row: endRow, column: 1 },
    });
  }

  // Helper to create a call relationship between definitions
  function createCallRelationship(
    callerFileId: number,
    calleeFileId: number,
    callerDefId: number,
    calleeDefId: number,
    calleeName: string,
    callRow: number
  ): void {
    const refId = db.insertReference(callerFileId, calleeFileId, {
      type: 'import',
      source: './callee',
      isExternal: false,
      isTypeOnly: false,
      imports: [],
      position: { row: 0, column: 0 },
    });

    const symbolId = db.insertSymbol(refId, calleeDefId, {
      name: calleeName,
      localName: calleeName,
      kind: 'named',
      usages: [],
    });

    db.insertUsage(symbolId, {
      position: { row: callRow, column: 10 },
      context: 'call_expression',
    });
  }

  describe('getCallGraph', () => {
    it('returns empty array when no calls exist', () => {
      const fileId = createFile('/project/controller.ts');
      createDefinition(fileId, 'SimpleFunction', 'function', 0, 10);

      const edges = db.getCallGraph();
      expect(edges).toEqual([]);
    });

    it('returns edges with weight and minUsageLine', () => {
      const callerFile = createFile('/project/caller.ts');
      const calleeFile = createFile('/project/callee.ts');

      const callerDef = createDefinition(callerFile, 'caller', 'function', 5, 20);
      const calleeDef = createDefinition(calleeFile, 'callee', 'function', 0, 10);

      // Row 10 becomes line 11 (1-indexed)
      createCallRelationship(callerFile, calleeFile, callerDef, calleeDef, 'callee', 10);

      const edges = db.getCallGraph();
      expect(edges).toHaveLength(1);
      expect(edges[0]).toEqual({
        fromId: callerDef,
        toId: calleeDef,
        weight: 1,
        minUsageLine: 11, // row 10 + 1 = line 11
      });
    });

    it('captures minimum usage line when multiple calls exist', () => {
      const callerFile = createFile('/project/caller.ts');
      const calleeFile = createFile('/project/callee.ts');

      const callerDef = createDefinition(callerFile, 'caller', 'function', 5, 30);
      const calleeDef = createDefinition(calleeFile, 'callee', 'function', 0, 10);

      // First call at line 10
      const refId1 = db.insertReference(callerFile, calleeFile, {
        type: 'import',
        source: './callee',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });
      const symbolId1 = db.insertSymbol(refId1, calleeDef, {
        name: 'callee',
        localName: 'callee',
        kind: 'named',
        usages: [],
      });
      db.insertUsage(symbolId1, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
      });

      // Second call at line 20 (later)
      db.insertUsage(symbolId1, {
        position: { row: 20, column: 5 },
        context: 'call_expression',
      });

      const edges = db.getCallGraph();
      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(2);
      expect(edges[0].minUsageLine).toBe(11); // row 10 + 1 = line 11 (minimum)
    });
  });

  describe('getModuleCallGraph', () => {
    it('returns empty array when no modules or calls exist', () => {
      const edges = db.getModuleCallGraph();
      expect(edges).toEqual([]);
    });

    it('aggregates symbol-level calls to module-level edges', () => {
      const file1 = createFile('/project/controllers/user.ts');
      const file2 = createFile('/project/services/user.ts');

      const def1 = createDefinition(file1, 'UserController', 'class', 0, 50);
      const def2 = createDefinition(file2, 'userService', 'function', 0, 30);

      // Create modules
      const rootId = db.ensureRootModule();
      const controllerModule = db.insertModule(rootId, 'controllers', 'Controllers');
      const serviceModule = db.insertModule(rootId, 'services', 'Services');

      // Assign definitions to modules
      db.assignSymbolToModule(def1, controllerModule);
      db.assignSymbolToModule(def2, serviceModule);

      // Create call relationship
      createCallRelationship(file1, file2, def1, def2, 'userService', 20);

      const moduleEdges = db.getModuleCallGraph();
      expect(moduleEdges).toHaveLength(1);
      expect(moduleEdges[0].fromModuleId).toBe(controllerModule);
      expect(moduleEdges[0].toModuleId).toBe(serviceModule);
      expect(moduleEdges[0].weight).toBe(1);
    });

    it('aggregates multiple calls between same modules', () => {
      const file1 = createFile('/project/controllers/user.ts');
      const file2 = createFile('/project/services/user.ts');

      const def1 = createDefinition(file1, 'UserController', 'class', 0, 50);
      const def2a = createDefinition(file2, 'createUser', 'function', 0, 30);
      const def2b = createDefinition(file2, 'updateUser', 'function', 35, 60);

      // Create modules
      const rootId = db.ensureRootModule();
      const controllerModule = db.insertModule(rootId, 'controllers', 'Controllers');
      const serviceModule = db.insertModule(rootId, 'services', 'Services');

      // Assign definitions to modules
      db.assignSymbolToModule(def1, controllerModule);
      db.assignSymbolToModule(def2a, serviceModule);
      db.assignSymbolToModule(def2b, serviceModule);

      // Create call relationships
      createCallRelationship(file1, file2, def1, def2a, 'createUser', 20);
      createCallRelationship(file1, file2, def1, def2b, 'updateUser', 30);

      const moduleEdges = db.getModuleCallGraph();
      expect(moduleEdges).toHaveLength(1);
      expect(moduleEdges[0].weight).toBe(2); // Aggregated
    });
  });

  describe('ensureRootFlow', () => {
    it('creates a root flow with depth 0', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      expect(rootFlow.id).toBeDefined();
      expect(rootFlow.name).toBe('User Journey');
      expect(rootFlow.slug).toBe('user-journey');
      expect(rootFlow.depth).toBe(0);
      expect(rootFlow.parentId).toBeNull();
    });

    it('returns existing root flow if slug matches', () => {
      const first = db.ensureRootFlow('user-journey');
      const second = db.ensureRootFlow('user-journey');
      expect(first.id).toBe(second.id);
    });
  });

  describe('insertFlow', () => {
    it('inserts a child flow under a parent', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      const childId = db.insertFlow(rootFlow.id, 'authentication', 'Authentication', {
        description: 'User authentication flow',
      });

      const child = db.getFlowById(childId);
      expect(child).not.toBeNull();
      expect(child!.name).toBe('Authentication');
      expect(child!.slug).toBe('authentication');
      expect(child!.parentId).toBe(rootFlow.id);
      expect(child!.depth).toBe(1);
      expect(child!.fullPath).toBe('user-journey.authentication');
    });

    it('creates leaf flows with module transitions', () => {
      // Create modules first
      const rootModule = db.ensureRootModule();
      const controllerModule = db.insertModule(rootModule, 'controllers', 'Controllers');
      const serviceModule = db.insertModule(rootModule, 'services', 'Services');

      const rootFlow = db.ensureRootFlow('user-journey');
      const leafId = db.insertFlow(rootFlow.id, 'controller-to-service', 'Controller to Service', {
        fromModuleId: controllerModule,
        toModuleId: serviceModule,
        semantic: 'Controller delegates to service',
      });

      const leaf = db.getFlowById(leafId);
      expect(leaf).not.toBeNull();
      expect(leaf!.fromModuleId).toBe(controllerModule);
      expect(leaf!.toModuleId).toBe(serviceModule);
      expect(leaf!.semantic).toBe('Controller delegates to service');
    });

    it('auto-assigns step order within parent', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      const child1 = db.insertFlow(rootFlow.id, 'step-1', 'Step 1');
      const child2 = db.insertFlow(rootFlow.id, 'step-2', 'Step 2');
      const child3 = db.insertFlow(rootFlow.id, 'step-3', 'Step 3');

      const flow1 = db.getFlowById(child1);
      const flow2 = db.getFlowById(child2);
      const flow3 = db.getFlowById(child3);

      expect(flow1!.stepOrder).toBe(1);
      expect(flow2!.stepOrder).toBe(2);
      expect(flow3!.stepOrder).toBe(3);
    });
  });

  describe('getFlowByPath', () => {
    it('retrieves a flow by its full path', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      db.insertFlow(rootFlow.id, 'authentication', 'Authentication');

      const flow = db.getFlowByPath('user-journey.authentication');
      expect(flow).not.toBeNull();
      expect(flow!.name).toBe('Authentication');
    });

    it('returns null for non-existent path', () => {
      const flow = db.getFlowByPath('non-existent.path');
      expect(flow).toBeNull();
    });
  });

  describe('getFlowChildren', () => {
    it('returns children ordered by stepOrder', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      db.insertFlow(rootFlow.id, 'step-3', 'Step 3');
      db.insertFlow(rootFlow.id, 'step-1', 'Step 1');
      db.insertFlow(rootFlow.id, 'step-2', 'Step 2');

      const children = db.getFlowChildren(rootFlow.id);
      expect(children).toHaveLength(3);
      // Should be in insertion order (step order assigned sequentially)
      expect(children[0].slug).toBe('step-3');
      expect(children[1].slug).toBe('step-1');
      expect(children[2].slug).toBe('step-2');
    });
  });

  describe('getFlowTree', () => {
    it('returns complete tree structure', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      const authId = db.insertFlow(rootFlow.id, 'authentication', 'Authentication');
      db.insertFlow(authId, 'validate', 'Validate Credentials');
      db.insertFlow(authId, 'create-session', 'Create Session');
      db.insertFlow(rootFlow.id, 'dashboard', 'Load Dashboard');

      const trees = db.getFlowTree();
      expect(trees).toHaveLength(1);

      const root = trees[0];
      expect(root.name).toBe('User Journey');
      expect(root.children).toHaveLength(2);

      const auth = root.children.find(c => c.slug === 'authentication');
      expect(auth).toBeDefined();
      expect(auth!.children).toHaveLength(2);
    });
  });

  describe('getLeafFlows', () => {
    it('returns only flows with module transitions', () => {
      // Create modules
      const rootModule = db.ensureRootModule();
      const controllerModule = db.insertModule(rootModule, 'controllers', 'Controllers');
      const serviceModule = db.insertModule(rootModule, 'services', 'Services');

      const rootFlow = db.ensureRootFlow('user-journey');
      const authId = db.insertFlow(rootFlow.id, 'authentication', 'Authentication');

      // Create leaf flow with module transition
      db.insertFlow(authId, 'validate', 'Validate', {
        fromModuleId: controllerModule,
        toModuleId: serviceModule,
        semantic: 'Validates credentials',
      });

      const leafFlows = db.getLeafFlows();
      expect(leafFlows).toHaveLength(1);
      expect(leafFlows[0].name).toBe('Validate');
      expect(leafFlows[0].fromModuleId).toBe(controllerModule);
    });
  });

  describe('expandFlow', () => {
    it('returns ordered leaf flows for a composite flow', () => {
      // Create modules
      const rootModule = db.ensureRootModule();
      const module1 = db.insertModule(rootModule, 'module-1', 'Module 1');
      const module2 = db.insertModule(rootModule, 'module-2', 'Module 2');
      const module3 = db.insertModule(rootModule, 'module-3', 'Module 3');

      const rootFlow = db.ensureRootFlow('user-journey');
      const authId = db.insertFlow(rootFlow.id, 'authentication', 'Authentication');

      // Create leaf flows
      db.insertFlow(authId, 'step-1', 'Step 1', {
        fromModuleId: module1,
        toModuleId: module2,
      });
      db.insertFlow(authId, 'step-2', 'Step 2', {
        fromModuleId: module2,
        toModuleId: module3,
      });

      const expanded = db.expandFlow(authId);
      expect(expanded).toHaveLength(2);
      expect(expanded[0].slug).toBe('step-1');
      expect(expanded[1].slug).toBe('step-2');
    });

    it('returns empty array for leaf flow', () => {
      const rootModule = db.ensureRootModule();
      const module1 = db.insertModule(rootModule, 'module-1', 'Module 1');
      const module2 = db.insertModule(rootModule, 'module-2', 'Module 2');

      const rootFlow = db.ensureRootFlow('user-journey');
      const leafId = db.insertFlow(rootFlow.id, 'leaf', 'Leaf Flow', {
        fromModuleId: module1,
        toModuleId: module2,
      });

      const expanded = db.expandFlow(leafId);
      expect(expanded).toHaveLength(0); // Leaf flow has no children
    });
  });

  describe('getFlowCoverage', () => {
    it('calculates coverage percentage', () => {
      // Create modules
      const rootModule = db.ensureRootModule();
      const module1 = db.insertModule(rootModule, 'module-1', 'Module 1');
      const module2 = db.insertModule(rootModule, 'module-2', 'Module 2');
      const module3 = db.insertModule(rootModule, 'module-3', 'Module 3');

      // Create definitions
      const file1 = createFile('/project/module1.ts');
      const file2 = createFile('/project/module2.ts');
      const file3 = createFile('/project/module3.ts');

      const def1 = createDefinition(file1, 'func1', 'function', 0, 10);
      const def2 = createDefinition(file2, 'func2', 'function', 0, 10);
      const def3 = createDefinition(file3, 'func3', 'function', 0, 10);

      db.assignSymbolToModule(def1, module1);
      db.assignSymbolToModule(def2, module2);
      db.assignSymbolToModule(def3, module3);

      // Create calls: module1->module2, module2->module3 (2 edges)
      createCallRelationship(file1, file2, def1, def2, 'func2', 5);
      createCallRelationship(file2, file3, def2, def3, 'func3', 5);

      // Create flow covering only one edge
      const rootFlow = db.ensureRootFlow('test-flow');
      db.insertFlow(rootFlow.id, 'covered', 'Covered Edge', {
        fromModuleId: module1,
        toModuleId: module2,
      });

      const coverage = db.getFlowCoverage();
      expect(coverage.totalModuleEdges).toBe(2);
      expect(coverage.coveredByFlows).toBe(1);
      expect(coverage.percentage).toBe(50.0);
    });

    it('returns 100% when all edges are covered', () => {
      // Create modules
      const rootModule = db.ensureRootModule();
      const module1 = db.insertModule(rootModule, 'module-1', 'Module 1');
      const module2 = db.insertModule(rootModule, 'module-2', 'Module 2');

      // Create definitions
      const file1 = createFile('/project/module1.ts');
      const file2 = createFile('/project/module2.ts');

      const def1 = createDefinition(file1, 'func1', 'function', 0, 10);
      const def2 = createDefinition(file2, 'func2', 'function', 0, 10);

      db.assignSymbolToModule(def1, module1);
      db.assignSymbolToModule(def2, module2);

      // Create call
      createCallRelationship(file1, file2, def1, def2, 'func2', 5);

      // Create flow covering the edge
      const rootFlow = db.ensureRootFlow('test-flow');
      db.insertFlow(rootFlow.id, 'covered', 'Covered Edge', {
        fromModuleId: module1,
        toModuleId: module2,
      });

      const coverage = db.getFlowCoverage();
      expect(coverage.totalModuleEdges).toBe(1);
      expect(coverage.coveredByFlows).toBe(1);
      expect(coverage.percentage).toBe(100.0);
    });
  });

  describe('getFlowCount / getFlowStats', () => {
    it('returns correct flow count', () => {
      expect(db.getFlowCount()).toBe(0);

      const rootFlow = db.ensureRootFlow('user-journey');
      expect(db.getFlowCount()).toBe(1);

      db.insertFlow(rootFlow.id, 'auth', 'Authentication');
      expect(db.getFlowCount()).toBe(2);
    });

    it('returns correct flow statistics', () => {
      // Create modules
      const rootModule = db.ensureRootModule();
      const module1 = db.insertModule(rootModule, 'module-1', 'Module 1');
      const module2 = db.insertModule(rootModule, 'module-2', 'Module 2');

      const rootFlow = db.ensureRootFlow('user-journey');
      const authId = db.insertFlow(rootFlow.id, 'auth', 'Authentication');
      db.insertFlow(authId, 'validate', 'Validate', {
        fromModuleId: module1,
        toModuleId: module2,
      });

      const stats = db.getFlowStats();
      expect(stats.flowCount).toBe(3);
      expect(stats.leafFlowCount).toBe(1);
      expect(stats.rootFlowCount).toBe(1);
      expect(stats.maxDepth).toBe(2);
    });
  });

  describe('clearFlows', () => {
    it('removes all flows', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      db.insertFlow(rootFlow.id, 'auth', 'Authentication');
      db.insertFlow(rootFlow.id, 'dashboard', 'Dashboard');

      expect(db.getFlowCount()).toBe(3);

      const cleared = db.clearFlows();
      // clearFlows deletes all flows and returns number of direct deletes
      // (children may be deleted via CASCADE, so cleared may be less than total)
      expect(cleared).toBeGreaterThanOrEqual(1);
      expect(db.getFlowCount()).toBe(0);
    });
  });

  describe('updateFlow', () => {
    it('updates flow name', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      const flowId = db.insertFlow(rootFlow.id, 'old-name', 'Old Name');

      const updated = db.updateFlow(flowId, { name: 'New Name' });
      expect(updated).toBe(true);

      const flow = db.getFlowById(flowId);
      expect(flow!.name).toBe('New Name');
    });

    it('updates flow description', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      const flowId = db.insertFlow(rootFlow.id, 'test', 'Test');

      db.updateFlow(flowId, { description: 'New description' });

      const flow = db.getFlowById(flowId);
      expect(flow!.description).toBe('New description');
    });

    it('updates flow semantic', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      const flowId = db.insertFlow(rootFlow.id, 'test', 'Test');

      db.updateFlow(flowId, { semantic: 'New semantic annotation' });

      const flow = db.getFlowById(flowId);
      expect(flow!.semantic).toBe('New semantic annotation');
    });

    it('returns false for non-existent flow', () => {
      const updated = db.updateFlow(999, { name: 'Test' });
      expect(updated).toBe(false);
    });

    it('returns false when no updates provided', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      const flowId = db.insertFlow(rootFlow.id, 'test', 'Test');

      const updated = db.updateFlow(flowId, {});
      expect(updated).toBe(false);
    });
  });

  describe('getFlowBySlug', () => {
    it('returns a flow by its slug', () => {
      const rootFlow = db.ensureRootFlow('user-journey');
      db.insertFlow(rootFlow.id, 'authentication', 'Authentication');

      const flow = db.getFlowBySlug('authentication');
      expect(flow).not.toBeNull();
      expect(flow!.name).toBe('Authentication');
    });

    it('returns null for non-existent slug', () => {
      const flow = db.getFlowBySlug('non-existent');
      expect(flow).toBeNull();
    });
  });

  describe('reparentFlow', () => {
    it('moves a flow under a new parent', () => {
      const root1 = db.ensureRootFlow('root-1');
      const root2 = db.ensureRootFlow('root-2');
      const childId = db.insertFlow(root1.id, 'child', 'Child Flow');

      // Initially under root1
      let child = db.getFlowById(childId);
      expect(child!.parentId).toBe(root1.id);
      expect(child!.fullPath).toBe('root-1.child');
      expect(child!.depth).toBe(1);

      // Reparent to root2
      db.reparentFlow(childId, root2.id);

      child = db.getFlowById(childId);
      expect(child!.parentId).toBe(root2.id);
      expect(child!.fullPath).toBe('root-2.child');
      expect(child!.depth).toBe(1);
    });

    it('recursively updates descendant paths', () => {
      const root = db.ensureRootFlow('root');
      const parentId = db.insertFlow(root.id, 'parent', 'Parent');
      const childId = db.insertFlow(parentId, 'child', 'Child');
      const grandchildId = db.insertFlow(childId, 'grandchild', 'Grandchild');

      // Initially: root.parent.child.grandchild
      let grandchild = db.getFlowById(grandchildId);
      expect(grandchild!.fullPath).toBe('root.parent.child.grandchild');
      expect(grandchild!.depth).toBe(3);

      // Move child directly under root
      db.reparentFlow(childId, root.id);

      // Now: root.child.grandchild
      grandchild = db.getFlowById(grandchildId);
      expect(grandchild!.fullPath).toBe('root.child.grandchild');
      expect(grandchild!.depth).toBe(2);

      // Verify child is updated
      const child = db.getFlowById(childId);
      expect(child!.fullPath).toBe('root.child');
      expect(child!.depth).toBe(1);
      expect(child!.parentId).toBe(root.id);
    });

    it('assigns step order correctly', () => {
      const root = db.ensureRootFlow('root');
      const child1 = db.insertFlow(root.id, 'child-1', 'Child 1');
      const child2 = db.insertFlow(root.id, 'child-2', 'Child 2');

      const newRoot = db.ensureRootFlow('new-root');

      // Move child2 first
      db.reparentFlow(child2, newRoot.id);
      // Move child1 second
      db.reparentFlow(child1, newRoot.id);

      const flow1 = db.getFlowById(child1);
      const flow2 = db.getFlowById(child2);
      expect(flow2!.stepOrder).toBe(1); // First
      expect(flow1!.stepOrder).toBe(2); // Second
    });

    it('allows explicit step order', () => {
      const root = db.ensureRootFlow('root');
      const child1 = db.insertFlow(root.id, 'child-1', 'Child 1');
      const child2 = db.insertFlow(root.id, 'child-2', 'Child 2');

      const newRoot = db.ensureRootFlow('new-root');

      // Move with explicit order
      db.reparentFlow(child1, newRoot.id, 5);
      db.reparentFlow(child2, newRoot.id, 3);

      const flow1 = db.getFlowById(child1);
      const flow2 = db.getFlowById(child2);
      expect(flow1!.stepOrder).toBe(5);
      expect(flow2!.stepOrder).toBe(3);
    });

    it('throws error for non-existent flow', () => {
      expect(() => db.reparentFlow(999, null)).toThrow('Flow 999 not found');
    });

    it('throws error for non-existent parent', () => {
      const root = db.ensureRootFlow('root');
      const childId = db.insertFlow(root.id, 'child', 'Child');

      expect(() => db.reparentFlow(childId, 999)).toThrow('Parent flow 999 not found');
    });

    it('moves flow to root level (parentId = null)', () => {
      const root = db.ensureRootFlow('root');
      const childId = db.insertFlow(root.id, 'child', 'Child');

      // Initially under root
      let child = db.getFlowById(childId);
      expect(child!.parentId).toBe(root.id);
      expect(child!.depth).toBe(1);

      // Move to root level
      db.reparentFlow(childId, null);

      child = db.getFlowById(childId);
      expect(child!.parentId).toBeNull();
      expect(child!.fullPath).toBe('child');
      expect(child!.depth).toBe(0);
    });
  });

  describe('reparentFlows (bulk)', () => {
    it('reparents flows in order', () => {
      // Create orphaned flows
      const a = db.insertFlow(null, 'a', 'A');
      const b = db.insertFlow(null, 'b', 'B');
      const c = db.insertFlow(null, 'c', 'C');

      const newParent = db.ensureRootFlow('parent');

      // Reparent in specific order: C, A, B
      db.reparentFlows([c, a, b], newParent.id);

      const flowC = db.getFlowById(c)!;
      const flowA = db.getFlowById(a)!;
      const flowB = db.getFlowById(b)!;

      expect(flowC.stepOrder).toBe(1);
      expect(flowA.stepOrder).toBe(2);
      expect(flowB.stepOrder).toBe(3);

      expect(flowC.parentId).toBe(newParent.id);
      expect(flowA.parentId).toBe(newParent.id);
      expect(flowB.parentId).toBe(newParent.id);

      expect(flowC.fullPath).toBe('parent.c');
      expect(flowA.fullPath).toBe('parent.a');
      expect(flowB.fullPath).toBe('parent.b');
    });

    it('handles empty array', () => {
      const parent = db.ensureRootFlow('parent');

      // Should not throw
      db.reparentFlows([], parent.id);

      const children = db.getFlowChildren(parent.id);
      expect(children).toHaveLength(0);
    });

    it('maintains correct depth for nested reparenting', () => {
      // Create a flow with children
      const childId = db.insertFlow(null, 'child', 'Child');
      const grandchildId = db.insertFlow(childId, 'grandchild', 'Grandchild');

      // Create a deep parent structure
      const root = db.ensureRootFlow('root');
      const level1 = db.insertFlow(root.id, 'level-1', 'Level 1');

      // Reparent the child (with grandchild) under level1
      db.reparentFlows([childId], level1);

      const child = db.getFlowById(childId)!;
      const grandchild = db.getFlowById(grandchildId)!;

      expect(child.depth).toBe(2);  // root(0) -> level1(1) -> child(2)
      expect(grandchild.depth).toBe(3);  // root(0) -> level1(1) -> child(2) -> grandchild(3)
      expect(child.fullPath).toBe('root.level-1.child');
      expect(grandchild.fullPath).toBe('root.level-1.child.grandchild');
    });
  });

  describe('deleteFlow', () => {
    it('deletes a flow', () => {
      const root = db.ensureRootFlow('root');
      const childId = db.insertFlow(root.id, 'child', 'Child');

      expect(db.getFlowCount()).toBe(2);

      const deleted = db.deleteFlow(childId);
      expect(deleted).toBe(1);
      expect(db.getFlowCount()).toBe(1);
    });

    it('cascades delete to descendants', () => {
      const root = db.ensureRootFlow('root');
      const parentId = db.insertFlow(root.id, 'parent', 'Parent');
      db.insertFlow(parentId, 'child', 'Child');

      expect(db.getFlowCount()).toBe(3);

      // Delete parent should cascade to child
      db.deleteFlow(parentId);

      expect(db.getFlowCount()).toBe(1);  // Only root remains
    });
  });

  describe('integration: hierarchical flow detection', () => {
    it('builds a complete flow hierarchy from module call graph', () => {
      // Setup: Controller -> Service -> Repository
      const controllerFile = createFile('/project/controllers/sales.controller.ts');
      const serviceFile = createFile('/project/services/sales.service.ts');
      const repoFile = createFile('/project/repositories/sales.repository.ts');

      const controllerDef = createDefinition(controllerFile, 'SalesController', 'class', 0, 50);
      const serviceDef = createDefinition(serviceFile, 'salesService', 'function', 0, 40);
      const repoDef = createDefinition(repoFile, 'salesRepository', 'function', 0, 30);

      // Create modules
      const rootId = db.ensureRootModule();
      const controllerModule = db.insertModule(rootId, 'sales-api', 'Sales API');
      const serviceModule = db.insertModule(rootId, 'sales-service', 'Sales Service');
      const repoModule = db.insertModule(rootId, 'sales-repository', 'Sales Repository');

      db.assignSymbolToModule(controllerDef, controllerModule);
      db.assignSymbolToModule(serviceDef, serviceModule);
      db.assignSymbolToModule(repoDef, repoModule);

      // Create call relationships
      createCallRelationship(controllerFile, serviceFile, controllerDef, serviceDef, 'salesService', 20);
      createCallRelationship(serviceFile, repoFile, serviceDef, repoDef, 'salesRepository', 15);

      // Verify module call graph
      const moduleEdges = db.getModuleCallGraph();
      expect(moduleEdges).toHaveLength(2);

      // Create flow hierarchy
      const salesFlow = db.ensureRootFlow('create-sale');
      const apiToServiceId = db.insertFlow(salesFlow.id, 'api-to-service', 'API to Service', {
        fromModuleId: controllerModule,
        toModuleId: serviceModule,
        semantic: 'Controller delegates to service',
      });
      const serviceToRepoId = db.insertFlow(salesFlow.id, 'service-to-repo', 'Service to Repository', {
        fromModuleId: serviceModule,
        toModuleId: repoModule,
        semantic: 'Service persists data',
      });

      // Verify flow structure
      const trees = db.getFlowTree();
      expect(trees).toHaveLength(1);
      expect(trees[0].name).toBe('Create Sale');
      expect(trees[0].children).toHaveLength(2);

      // Verify leaf flows
      const leafFlows = db.getLeafFlows();
      expect(leafFlows).toHaveLength(2);

      // Verify coverage
      const coverage = db.getFlowCoverage();
      expect(coverage.totalModuleEdges).toBe(2);
      expect(coverage.coveredByFlows).toBe(2);
      expect(coverage.percentage).toBe(100.0);

      // Verify expansion
      const expanded = db.expandFlow(salesFlow.id);
      expect(expanded).toHaveLength(2);
      expect(expanded[0].slug).toBe('api-to-service');
      expect(expanded[1].slug).toBe('service-to-repo');
    });
  });
});
