import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('Interactions and Flows', () => {
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

  // Helper to create modules
  function createModules(): { module1: number; module2: number; module3: number } {
    const rootId = db.ensureRootModule();
    const module1 = db.insertModule(rootId, 'controllers', 'Controllers');
    const module2 = db.insertModule(rootId, 'services', 'Services');
    const module3 = db.insertModule(rootId, 'repositories', 'Repositories');
    return { module1, module2, module3 };
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

  describe('Interactions', () => {
    describe('insertInteraction', () => {
      it('inserts a basic interaction', () => {
        const { module1, module2 } = createModules();

        const id = db.insertInteraction(module1, module2, {
          direction: 'uni',
          weight: 1,
          pattern: 'business',
        });

        expect(id).toBeGreaterThan(0);

        const interaction = db.getInteractionById(id);
        expect(interaction).not.toBeNull();
        expect(interaction!.fromModuleId).toBe(module1);
        expect(interaction!.toModuleId).toBe(module2);
        expect(interaction!.direction).toBe('uni');
        expect(interaction!.pattern).toBe('business');
      });

      it('inserts interaction with symbols', () => {
        const { module1, module2 } = createModules();

        const id = db.insertInteraction(module1, module2, {
          direction: 'uni',
          symbols: ['getUser', 'createUser', 'deleteUser'],
        });

        const interaction = db.getInteractionById(id);
        expect(interaction!.symbols).toEqual(['getUser', 'createUser', 'deleteUser']);
      });

      it('inserts interaction with semantic', () => {
        const { module1, module2 } = createModules();

        const id = db.insertInteraction(module1, module2, {
          direction: 'uni',
          semantic: 'Controller delegates business logic to service',
        });

        const interaction = db.getInteractionById(id);
        expect(interaction!.semantic).toBe('Controller delegates business logic to service');
      });
    });

    describe('upsertInteraction', () => {
      it('inserts when not exists', () => {
        const { module1, module2 } = createModules();

        const id = db.upsertInteraction(module1, module2, {
          direction: 'uni',
          weight: 5,
        });

        const interaction = db.getInteractionById(id);
        expect(interaction!.weight).toBe(5);
      });

      it('updates when exists', () => {
        const { module1, module2 } = createModules();

        // First insert
        const id1 = db.insertInteraction(module1, module2, {
          direction: 'uni',
          weight: 1,
          pattern: 'utility',
        });

        // Upsert with new values
        const id2 = db.upsertInteraction(module1, module2, {
          direction: 'bi',
          weight: 10,
          pattern: 'business',
          semantic: 'Updated semantic',
        });

        expect(id2).toBe(id1);

        const interaction = db.getInteractionById(id2);
        expect(interaction!.direction).toBe('bi');
        expect(interaction!.weight).toBe(10);
        expect(interaction!.pattern).toBe('business');
        expect(interaction!.semantic).toBe('Updated semantic');
      });
    });

    describe('getInteractionByModules', () => {
      it('returns interaction by module pair', () => {
        const { module1, module2 } = createModules();

        db.insertInteraction(module1, module2, { direction: 'uni' });

        const interaction = db.getInteractionByModules(module1, module2);
        expect(interaction).not.toBeNull();
        expect(interaction!.fromModuleId).toBe(module1);
        expect(interaction!.toModuleId).toBe(module2);
      });

      it('returns null when not found', () => {
        const { module1, module2 } = createModules();

        const interaction = db.getInteractionByModules(module1, module2);
        expect(interaction).toBeNull();
      });
    });

    describe('getAllInteractions', () => {
      it('returns all interactions with module paths', () => {
        const { module1, module2, module3 } = createModules();

        db.insertInteraction(module1, module2, { direction: 'uni', pattern: 'business' });
        db.insertInteraction(module2, module3, { direction: 'uni', pattern: 'business' });

        const interactions = db.getAllInteractions();
        expect(interactions).toHaveLength(2);
        expect(interactions[0].fromModulePath).toBeDefined();
        expect(interactions[0].toModulePath).toBeDefined();
      });
    });

    describe('getInteractionsByPattern', () => {
      it('filters interactions by pattern', () => {
        const { module1, module2, module3 } = createModules();

        db.insertInteraction(module1, module2, { direction: 'uni', pattern: 'business' });
        db.insertInteraction(module2, module3, { direction: 'uni', pattern: 'utility' });

        const business = db.getInteractionsByPattern('business');
        expect(business).toHaveLength(1);
        expect(business[0].fromModuleId).toBe(module1);

        const utility = db.getInteractionsByPattern('utility');
        expect(utility).toHaveLength(1);
        expect(utility[0].fromModuleId).toBe(module2);
      });
    });

    describe('getInteractionCount', () => {
      it('returns correct count', () => {
        const { module1, module2, module3 } = createModules();

        expect(db.getInteractionCount()).toBe(0);

        db.insertInteraction(module1, module2, { direction: 'uni' });
        expect(db.getInteractionCount()).toBe(1);

        db.insertInteraction(module2, module3, { direction: 'uni' });
        expect(db.getInteractionCount()).toBe(2);
      });
    });

    describe('clearInteractions', () => {
      it('removes all interactions', () => {
        const { module1, module2, module3 } = createModules();

        db.insertInteraction(module1, module2, { direction: 'uni' });
        db.insertInteraction(module2, module3, { direction: 'uni' });

        expect(db.getInteractionCount()).toBe(2);

        const cleared = db.clearInteractions();
        expect(cleared).toBe(2);
        expect(db.getInteractionCount()).toBe(0);
      });
    });
  });

  describe('Flows', () => {
    describe('insertFlow', () => {
      it('inserts a basic flow', () => {
        const id = db.insertFlow('UserLoginFlow', 'user-login-flow', {
          description: 'Handles user login',
          stakeholder: 'user',
        });

        expect(id).toBeGreaterThan(0);

        const flow = db.getFlowById(id);
        expect(flow).not.toBeNull();
        expect(flow!.name).toBe('UserLoginFlow');
        expect(flow!.slug).toBe('user-login-flow');
        expect(flow!.description).toBe('Handles user login');
        expect(flow!.stakeholder).toBe('user');
      });

      it('inserts flow with entry point', () => {
        const fileId = createFile('/project/controllers/auth.ts');
        const entryPointId = createDefinition(fileId, 'handleLogin', 'function', 0, 50);

        const id = db.insertFlow('UserLoginFlow', 'user-login-flow', {
          entryPointId,
          entryPath: 'POST /api/auth/login',
        });

        const flow = db.getFlowById(id);
        expect(flow!.entryPointId).toBe(entryPointId);
        expect(flow!.entryPath).toBe('POST /api/auth/login');
      });

      it('enforces unique slug', () => {
        db.insertFlow('Flow1', 'my-flow', {});

        expect(() => {
          db.insertFlow('Flow2', 'my-flow', {});
        }).toThrow();
      });
    });

    describe('getFlowBySlug', () => {
      it('returns flow by slug', () => {
        db.insertFlow('TestFlow', 'test-flow', { description: 'Test' });

        const flow = db.getFlowBySlug('test-flow');
        expect(flow).not.toBeNull();
        expect(flow!.name).toBe('TestFlow');
      });

      it('returns null for non-existent slug', () => {
        const flow = db.getFlowBySlug('non-existent');
        expect(flow).toBeNull();
      });
    });

    describe('getAllFlows', () => {
      it('returns all flows', () => {
        db.insertFlow('Flow1', 'flow-1', {});
        db.insertFlow('Flow2', 'flow-2', {});
        db.insertFlow('Flow3', 'flow-3', {});

        const flows = db.getAllFlows();
        expect(flows).toHaveLength(3);
      });
    });

    describe('getFlowsByStakeholder', () => {
      it('filters flows by stakeholder', () => {
        db.insertFlow('UserFlow', 'user-flow', { stakeholder: 'user' });
        db.insertFlow('AdminFlow', 'admin-flow', { stakeholder: 'admin' });
        db.insertFlow('SystemFlow', 'system-flow', { stakeholder: 'system' });

        const userFlows = db.getFlowsByStakeholder('user');
        expect(userFlows).toHaveLength(1);
        expect(userFlows[0].name).toBe('UserFlow');

        const adminFlows = db.getFlowsByStakeholder('admin');
        expect(adminFlows).toHaveLength(1);
        expect(adminFlows[0].name).toBe('AdminFlow');
      });
    });

    describe('updateFlow', () => {
      it('updates flow name', () => {
        const id = db.insertFlow('OldName', 'test-flow', {});

        const updated = db.updateFlow(id, { name: 'NewName' });
        expect(updated).toBe(true);

        const flow = db.getFlowById(id);
        expect(flow!.name).toBe('NewName');
      });

      it('updates flow description', () => {
        const id = db.insertFlow('Test', 'test-flow', {});

        db.updateFlow(id, { description: 'New description' });

        const flow = db.getFlowById(id);
        expect(flow!.description).toBe('New description');
      });

      it('returns false for non-existent flow', () => {
        const updated = db.updateFlow(999, { name: 'Test' });
        expect(updated).toBe(false);
      });

      it('returns false when no updates provided', () => {
        const id = db.insertFlow('Test', 'test-flow', {});

        const updated = db.updateFlow(id, {});
        expect(updated).toBe(false);
      });
    });

    describe('deleteFlow', () => {
      it('deletes a flow', () => {
        const id = db.insertFlow('Test', 'test-flow', {});
        expect(db.getFlowCount()).toBe(1);

        const deleted = db.deleteFlow(id);
        expect(deleted).toBe(true);
        expect(db.getFlowCount()).toBe(0);
      });
    });

    describe('getFlowCount', () => {
      it('returns correct count', () => {
        expect(db.getFlowCount()).toBe(0);

        db.insertFlow('Flow1', 'flow-1', {});
        expect(db.getFlowCount()).toBe(1);

        db.insertFlow('Flow2', 'flow-2', {});
        expect(db.getFlowCount()).toBe(2);
      });
    });

    describe('clearFlows', () => {
      it('removes all flows', () => {
        db.insertFlow('Flow1', 'flow-1', {});
        db.insertFlow('Flow2', 'flow-2', {});

        expect(db.getFlowCount()).toBe(2);

        const cleared = db.clearFlows();
        expect(cleared).toBe(2);
        expect(db.getFlowCount()).toBe(0);
      });
    });
  });

  describe('Flow Steps', () => {
    it('adds steps to a flow', () => {
      const { module1, module2, module3 } = createModules();

      // Create interactions
      const int1 = db.insertInteraction(module1, module2, { direction: 'uni' });
      const int2 = db.insertInteraction(module2, module3, { direction: 'uni' });

      // Create flow
      const flowId = db.insertFlow('TestFlow', 'test-flow', {});

      // Add steps
      db.addFlowSteps(flowId, [int1, int2]);

      // Get flow with steps
      const flow = db.getFlowWithSteps(flowId);
      expect(flow).not.toBeNull();
      expect(flow!.steps).toHaveLength(2);
      expect(flow!.steps[0].stepOrder).toBe(1);
      expect(flow!.steps[0].interactionId).toBe(int1);
      expect(flow!.steps[1].stepOrder).toBe(2);
      expect(flow!.steps[1].interactionId).toBe(int2);
    });

    it('expands flow to full interaction details', () => {
      const { module1, module2, module3 } = createModules();

      // Create interactions
      const int1 = db.insertInteraction(module1, module2, {
        direction: 'uni',
        semantic: 'First step',
      });
      const int2 = db.insertInteraction(module2, module3, {
        direction: 'uni',
        semantic: 'Second step',
      });

      // Create flow with steps
      const flowId = db.insertFlow('TestFlow', 'test-flow', {});
      db.addFlowSteps(flowId, [int1, int2]);

      // Expand flow
      const expanded = db.expandFlow(flowId);
      expect(expanded).not.toBeNull();
      expect(expanded!.interactions).toHaveLength(2);
      expect(expanded!.interactions[0].id).toBe(int1);
      expect(expanded!.interactions[0].semantic).toBe('First step');
      expect(expanded!.interactions[1].id).toBe(int2);
      expect(expanded!.interactions[1].semantic).toBe('Second step');
    });

    it('clears steps from a flow', () => {
      const { module1, module2 } = createModules();

      const int1 = db.insertInteraction(module1, module2, { direction: 'uni' });
      const flowId = db.insertFlow('TestFlow', 'test-flow', {});
      db.addFlowSteps(flowId, [int1]);

      let flow = db.getFlowWithSteps(flowId);
      expect(flow!.steps).toHaveLength(1);

      db.clearFlowSteps(flowId);

      flow = db.getFlowWithSteps(flowId);
      expect(flow!.steps).toHaveLength(0);
    });
  });

  describe('Flow Coverage', () => {
    it('calculates coverage percentage', () => {
      const { module1, module2, module3 } = createModules();

      // Create 3 interactions
      const int1 = db.insertInteraction(module1, module2, { direction: 'uni' });
      const int2 = db.insertInteraction(module2, module3, { direction: 'uni' });
      db.insertInteraction(module1, module3, { direction: 'uni' }); // Uncovered

      // Create flow covering 2 interactions
      const flowId = db.insertFlow('TestFlow', 'test-flow', {});
      db.addFlowSteps(flowId, [int1, int2]);

      const coverage = db.getFlowCoverage();
      expect(coverage.totalInteractions).toBe(3);
      expect(coverage.coveredByFlows).toBe(2);
      expect(coverage.percentage).toBeCloseTo(66.67, 1);
    });

    it('returns 100% when all interactions are covered', () => {
      const { module1, module2 } = createModules();

      const int1 = db.insertInteraction(module1, module2, { direction: 'uni' });

      const flowId = db.insertFlow('TestFlow', 'test-flow', {});
      db.addFlowSteps(flowId, [int1]);

      const coverage = db.getFlowCoverage();
      expect(coverage.totalInteractions).toBe(1);
      expect(coverage.coveredByFlows).toBe(1);
      expect(coverage.percentage).toBe(100.0);
    });

    it('returns 0% when no flows exist', () => {
      const { module1, module2 } = createModules();

      db.insertInteraction(module1, module2, { direction: 'uni' });

      const coverage = db.getFlowCoverage();
      expect(coverage.totalInteractions).toBe(1);
      expect(coverage.coveredByFlows).toBe(0);
      expect(coverage.percentage).toBe(0);
    });

    it('finds uncovered interactions', () => {
      const { module1, module2, module3 } = createModules();

      const int1 = db.insertInteraction(module1, module2, { direction: 'uni' });
      const int2 = db.insertInteraction(module2, module3, { direction: 'uni' });
      const int3 = db.insertInteraction(module1, module3, { direction: 'uni' });

      // Cover only int1 and int2
      const flowId = db.insertFlow('TestFlow', 'test-flow', {});
      db.addFlowSteps(flowId, [int1, int2]);

      const uncovered = db.getUncoveredInteractions();
      expect(uncovered).toHaveLength(1);
      expect(uncovered[0].id).toBe(int3);
    });
  });

  describe('Integration: Flow Tracing', () => {
    it('builds complete interaction and flow model', () => {
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

      // Create interactions
      const int1 = db.insertInteraction(controllerModule, serviceModule, {
        direction: 'uni',
        pattern: 'business',
        semantic: 'Controller delegates to service',
      });
      const int2 = db.insertInteraction(serviceModule, repoModule, {
        direction: 'uni',
        pattern: 'business',
        semantic: 'Service persists data',
      });

      // Verify interactions
      const interactions = db.getAllInteractions();
      expect(interactions).toHaveLength(2);

      // Create flow
      const flowId = db.insertFlow('CreateSaleFlow', 'create-sale-flow', {
        entryPointId: controllerDef,
        entryPath: 'POST /api/sales',
        stakeholder: 'user',
        description: 'Creates a new sale record',
      });

      // Add steps
      db.addFlowSteps(flowId, [int1, int2]);

      // Verify flow structure
      const flow = db.getFlowById(flowId);
      expect(flow!.name).toBe('CreateSaleFlow');
      expect(flow!.stakeholder).toBe('user');

      const flowWithSteps = db.getFlowWithSteps(flowId);
      expect(flowWithSteps!.steps).toHaveLength(2);

      // Verify expanded flow
      const expanded = db.expandFlow(flowId);
      expect(expanded!.interactions).toHaveLength(2);
      expect(expanded!.interactions[0].semantic).toBe('Controller delegates to service');
      expect(expanded!.interactions[1].semantic).toBe('Service persists data');

      // Verify coverage
      const coverage = db.getFlowCoverage();
      expect(coverage.totalInteractions).toBe(2);
      expect(coverage.coveredByFlows).toBe(2);
      expect(coverage.percentage).toBe(100.0);

      // Verify stats
      const stats = db.getStats();
      expect(stats.flows).toBe(1);
      expect(stats.interactions).toBe(2);
    });
  });
});
