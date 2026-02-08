import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';
import type { Definition } from '../../src/parser/definition-extractor.js';

describe('Flow Detection', () => {
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

  describe('getEntryPoints', () => {
    it('returns empty array when no entry points exist', () => {
      const entryPoints = db.getEntryPoints();
      expect(entryPoints).toEqual([]);
    });

    it('identifies functions with Controller in name as entry points', () => {
      const fileId = createFile('/project/controllers/user.ts');
      createDefinition(fileId, 'UserController', 'class', 0, 50);
      createDefinition(fileId, 'helper', 'function', 55, 60, false); // non-exported helper

      const entryPoints = db.getEntryPoints();
      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].name).toBe('UserController');
    });

    it('identifies functions with Handler in name as entry points', () => {
      const fileId = createFile('/project/handlers/request.ts');
      createDefinition(fileId, 'RequestHandler', 'function', 0, 20);

      const entryPoints = db.getEntryPoints();
      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].name).toBe('RequestHandler');
    });

    it('identifies exported functions in routes directories as entry points', () => {
      const fileId = createFile('/project/routes/users.ts');
      createDefinition(fileId, 'getUsers', 'function', 0, 10, true);
      createDefinition(fileId, 'privateHelper', 'function', 15, 20, false);

      const entryPoints = db.getEntryPoints();
      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].name).toBe('getUsers');
    });

    it('identifies exported functions in controllers directories as entry points', () => {
      const fileId = createFile('/project/src/controllers/auth.ts');
      createDefinition(fileId, 'login', 'function', 0, 10);
      createDefinition(fileId, 'logout', 'function', 15, 25);

      const entryPoints = db.getEntryPoints();
      expect(entryPoints).toHaveLength(2);
      expect(entryPoints.map(ep => ep.name).sort()).toEqual(['login', 'logout']);
    });

    it('identifies symbols with role=controller metadata as entry points', () => {
      const fileId = createFile('/project/api/users.ts');
      const defId = createDefinition(fileId, 'usersEndpoint', 'function', 0, 10);
      db.setDefinitionMetadata(defId, 'role', 'controller');

      const entryPoints = db.getEntryPoints();
      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].name).toBe('usersEndpoint');
    });

    it('returns domain from metadata', () => {
      const fileId = createFile('/project/routes/sales.ts');
      const defId = createDefinition(fileId, 'createSale', 'function', 0, 10);
      db.setDefinitionMetadata(defId, 'domain', '["sales", "commerce"]');

      const entryPoints = db.getEntryPoints();
      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].domain).toBe('sales');
    });
  });

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

    it('aggregates edges from both internal and imported symbols', () => {
      const file = createFile('/project/file.ts');

      const callerDef = createDefinition(file, 'caller', 'function', 5, 30);
      const calleeDef = createDefinition(file, 'callee', 'function', 35, 45);

      // Internal call (same file) at line 15
      const internalSymbolId = db.insertSymbol(null, calleeDef, {
        name: 'callee',
        localName: 'callee',
        kind: 'named',
        usages: [],
      }, file);
      db.insertUsage(internalSymbolId, {
        position: { row: 15, column: 5 },
        context: 'call_expression',
      });

      // Imported call at line 10 (earlier)
      const refId = db.insertReference(file, file, {
        type: 'import',
        source: './self',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });
      const importedSymbolId = db.insertSymbol(refId, calleeDef, {
        name: 'callee',
        localName: 'callee',
        kind: 'named',
        usages: [],
      });
      db.insertUsage(importedSymbolId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
      });

      const edges = db.getCallGraph();
      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(2); // Aggregated from both
      expect(edges[0].minUsageLine).toBe(11); // row 10 + 1 = line 11 (minimum from both)
    });
  });

  describe('traceFlowFromEntry', () => {
    it('returns only entry point when no calls exist', () => {
      const fileId = createFile('/project/controller.ts');
      const entryId = createDefinition(fileId, 'SimpleController', 'function', 0, 10);

      const trace = db.traceFlowFromEntry(entryId);
      expect(trace).toHaveLength(1);
      expect(trace[0].definitionId).toBe(entryId);
      expect(trace[0].depth).toBe(0);
    });

    it('traces through call graph to depth 1', () => {
      const controllerFile = createFile('/project/controller.ts');
      const serviceFile = createFile('/project/service.ts');

      const controllerDef = createDefinition(controllerFile, 'UserController', 'function', 5, 20);
      const serviceDef = createDefinition(serviceFile, 'userService', 'function', 0, 30);

      // Controller calls service
      createCallRelationship(controllerFile, serviceFile, controllerDef, serviceDef, 'userService', 10);

      const trace = db.traceFlowFromEntry(controllerDef);
      expect(trace).toHaveLength(2);

      const depths = trace.map(t => ({ id: t.definitionId, depth: t.depth }));
      expect(depths).toContainEqual({ id: controllerDef, depth: 0 });
      expect(depths).toContainEqual({ id: serviceDef, depth: 1 });
    });

    it('traces through multiple levels', () => {
      const controllerFile = createFile('/project/controller.ts');
      const serviceFile = createFile('/project/service.ts');
      const repoFile = createFile('/project/repository.ts');

      const controllerDef = createDefinition(controllerFile, 'Controller', 'function', 5, 20);
      const serviceDef = createDefinition(serviceFile, 'service', 'function', 5, 40);
      const repoDef = createDefinition(repoFile, 'repository', 'function', 0, 30);

      // Controller -> Service
      createCallRelationship(controllerFile, serviceFile, controllerDef, serviceDef, 'service', 10);
      // Service -> Repository
      createCallRelationship(serviceFile, repoFile, serviceDef, repoDef, 'repository', 20);

      const trace = db.traceFlowFromEntry(controllerDef);
      expect(trace).toHaveLength(3);

      const sorted = [...trace].sort((a, b) => a.depth - b.depth);
      expect(sorted[0].definitionId).toBe(controllerDef);
      expect(sorted[0].depth).toBe(0);
      expect(sorted[1].definitionId).toBe(serviceDef);
      expect(sorted[1].depth).toBe(1);
      expect(sorted[2].definitionId).toBe(repoDef);
      expect(sorted[2].depth).toBe(2);
    });

    it('respects maxDepth parameter', () => {
      const file1 = createFile('/project/a.ts');
      const file2 = createFile('/project/b.ts');
      const file3 = createFile('/project/c.ts');
      const file4 = createFile('/project/d.ts');

      const def1 = createDefinition(file1, 'a', 'function', 5, 20);
      const def2 = createDefinition(file2, 'b', 'function', 5, 20);
      const def3 = createDefinition(file3, 'c', 'function', 5, 20);
      const def4 = createDefinition(file4, 'd', 'function', 5, 20);

      createCallRelationship(file1, file2, def1, def2, 'b', 10);
      createCallRelationship(file2, file3, def2, def3, 'c', 10);
      createCallRelationship(file3, file4, def3, def4, 'd', 10);

      // With maxDepth=1, should only get def1 and def2
      const trace = db.traceFlowFromEntry(def1, 1);
      expect(trace).toHaveLength(2);
      expect(trace.map(t => t.definitionId)).toContain(def1);
      expect(trace.map(t => t.definitionId)).toContain(def2);
      expect(trace.map(t => t.definitionId)).not.toContain(def3);
    });

    it('handles circular dependencies', () => {
      const fileA = createFile('/project/a.ts');
      const fileB = createFile('/project/b.ts');

      const defA = createDefinition(fileA, 'funcA', 'function', 5, 20);
      const defB = createDefinition(fileB, 'funcB', 'function', 5, 20);

      // A calls B
      createCallRelationship(fileA, fileB, defA, defB, 'funcB', 10);
      // B calls A (circular)
      createCallRelationship(fileB, fileA, defB, defA, 'funcA', 10);

      const trace = db.traceFlowFromEntry(defA);
      expect(trace).toHaveLength(2);
      // Should not infinite loop
    });

    it('includes module info when available', () => {
      const fileId = createFile('/project/controller.ts');
      const defId = createDefinition(fileId, 'Controller', 'function', 0, 10);

      // Create a module tree and assign the definition to it
      const rootId = db.ensureRootModule();
      const moduleId = db.insertModule(rootId, 'test-module', 'Test Module');
      db.assignSymbolToModule(defId, moduleId);

      const trace = db.traceFlowFromEntry(defId);
      expect(trace).toHaveLength(1);
      expect(trace[0].moduleId).toBe(moduleId);
      // Layer is now null since it's no longer stored in modules
      expect(trace[0].layer).toBeNull();
    });

    it('sorts steps at same depth by usage line order', () => {
      const callerFile = createFile('/project/caller.ts');
      const calleeFileA = createFile('/project/calleeA.ts');
      const calleeFileB = createFile('/project/calleeB.ts');
      const calleeFileC = createFile('/project/calleeC.ts');

      // Caller function spans lines 5-50
      const callerDef = createDefinition(callerFile, 'caller', 'function', 5, 50);
      // Three callees
      const calleeDefA = createDefinition(calleeFileA, 'calleeA', 'function', 0, 10);
      const calleeDefB = createDefinition(calleeFileB, 'calleeB', 'function', 0, 10);
      const calleeDefC = createDefinition(calleeFileC, 'calleeC', 'function', 0, 10);

      // Create calls in source order: B at line 10, C at line 20, A at line 30
      // (intentionally not alphabetical to verify sorting)
      createCallRelationship(callerFile, calleeFileB, callerDef, calleeDefB, 'calleeB', 10);
      createCallRelationship(callerFile, calleeFileC, callerDef, calleeDefC, 'calleeC', 20);
      createCallRelationship(callerFile, calleeFileA, callerDef, calleeDefA, 'calleeA', 30);

      const trace = db.traceFlowFromEntry(callerDef);

      // Should have 4 items: caller + 3 callees
      expect(trace).toHaveLength(4);

      // First should be caller at depth 0
      expect(trace[0].definitionId).toBe(callerDef);
      expect(trace[0].depth).toBe(0);

      // Remaining should be callees at depth 1, sorted by usage line
      const depth1Items = trace.filter(t => t.depth === 1);
      expect(depth1Items).toHaveLength(3);

      // Order should be: B (line 10), C (line 20), A (line 30)
      expect(depth1Items[0].definitionId).toBe(calleeDefB);
      expect(depth1Items[1].definitionId).toBe(calleeDefC);
      expect(depth1Items[2].definitionId).toBe(calleeDefA);
    });

    it('sorts by depth first, then by usage line within same depth', () => {
      const file1 = createFile('/project/a.ts');
      const file2 = createFile('/project/b.ts');
      const file3 = createFile('/project/c.ts');
      const file4 = createFile('/project/d.ts');

      // Entry point
      const entryDef = createDefinition(file1, 'entry', 'function', 5, 50);
      // Depth 1 callees (called at different lines)
      const dep1Early = createDefinition(file2, 'dep1Early', 'function', 0, 10);
      const dep1Late = createDefinition(file3, 'dep1Late', 'function', 0, 10);
      // Depth 2 callee
      const dep2 = createDefinition(file4, 'dep2', 'function', 0, 10);

      // entry calls dep1Late at line 30, dep1Early at line 10
      createCallRelationship(file1, file3, entryDef, dep1Late, 'dep1Late', 30);
      createCallRelationship(file1, file2, entryDef, dep1Early, 'dep1Early', 10);
      // dep1Early calls dep2 (this should appear after both depth-1 items)
      createCallRelationship(file2, file4, dep1Early, dep2, 'dep2', 5);

      const trace = db.traceFlowFromEntry(entryDef);

      expect(trace).toHaveLength(4);

      // Order should be: entry (depth 0), dep1Early (depth 1, line 10), dep1Late (depth 1, line 30), dep2 (depth 2)
      expect(trace[0].definitionId).toBe(entryDef);
      expect(trace[0].depth).toBe(0);

      expect(trace[1].definitionId).toBe(dep1Early);
      expect(trace[1].depth).toBe(1);

      expect(trace[2].definitionId).toBe(dep1Late);
      expect(trace[2].depth).toBe(1);

      expect(trace[3].definitionId).toBe(dep2);
      expect(trace[3].depth).toBe(2);
    });
  });

  describe('insertFlow / getFlows', () => {
    it('inserts a flow and retrieves it', () => {
      const fileId = createFile('/project/controller.ts');
      const entryId = createDefinition(fileId, 'MyController', 'function', 0, 10);

      const flowId = db.insertFlow('CreateUser', entryId, 'Creates a new user', 'user-management');

      const flows = db.getFlows();
      expect(flows).toHaveLength(1);
      expect(flows[0].id).toBe(flowId);
      expect(flows[0].name).toBe('CreateUser');
      expect(flows[0].description).toBe('Creates a new user');
      expect(flows[0].domain).toBe('user-management');
      expect(flows[0].entryPointId).toBe(entryId);
    });

    it('inserts multiple flows', () => {
      const fileId = createFile('/project/controller.ts');
      const entry1 = createDefinition(fileId, 'Controller1', 'function', 0, 10);
      const entry2 = createDefinition(fileId, 'Controller2', 'function', 15, 25);

      db.insertFlow('Flow1', entry1);
      db.insertFlow('Flow2', entry2);

      const flows = db.getFlows();
      expect(flows).toHaveLength(2);
      expect(flows.map(f => f.name).sort()).toEqual(['Flow1', 'Flow2']);
    });
  });

  describe('addFlowStep / getFlowWithSteps', () => {
    it('adds steps to a flow and retrieves them', () => {
      const controllerFile = createFile('/project/controller.ts');
      const serviceFile = createFile('/project/service.ts');

      const controllerDef = createDefinition(controllerFile, 'UserController', 'function', 0, 20);
      const serviceDef = createDefinition(serviceFile, 'userService', 'function', 0, 30);

      const flowId = db.insertFlow('GetUser', controllerDef);
      db.addFlowStep(flowId, 1, controllerDef, undefined, 'controller');
      db.addFlowStep(flowId, 2, serviceDef, undefined, 'service');

      const flowWithSteps = db.getFlowWithSteps(flowId);
      expect(flowWithSteps).not.toBeNull();
      expect(flowWithSteps!.steps).toHaveLength(2);
      expect(flowWithSteps!.steps[0].stepOrder).toBe(1);
      expect(flowWithSteps!.steps[0].name).toBe('UserController');
      expect(flowWithSteps!.steps[0].layer).toBe('controller');
      expect(flowWithSteps!.steps[1].stepOrder).toBe(2);
      expect(flowWithSteps!.steps[1].name).toBe('userService');
      expect(flowWithSteps!.steps[1].layer).toBe('service');
    });

    it('includes module name in steps when available', () => {
      const fileId = createFile('/project/service.ts');
      const defId = createDefinition(fileId, 'MyService', 'function', 0, 20);

      const rootId = db.ensureRootModule();
      const moduleId = db.insertModule(rootId, 'service-module', 'Service Module');
      db.assignSymbolToModule(defId, moduleId);

      const flowId = db.insertFlow('TestFlow', defId);
      db.addFlowStep(flowId, 1, defId, moduleId, 'service');

      const flowWithSteps = db.getFlowWithSteps(flowId);
      expect(flowWithSteps!.steps[0].moduleName).toBe('Service Module');
    });

    it('returns null for non-existent flow', () => {
      const flowWithSteps = db.getFlowWithSteps(999);
      expect(flowWithSteps).toBeNull();
    });
  });

  describe('getAllFlowsWithSteps', () => {
    it('returns all flows with their steps', () => {
      const file1 = createFile('/project/a.ts');
      const file2 = createFile('/project/b.ts');

      const def1 = createDefinition(file1, 'Controller1', 'function', 0, 10);
      const def2 = createDefinition(file1, 'Service1', 'function', 15, 25);
      const def3 = createDefinition(file2, 'Controller2', 'function', 0, 10);

      const flow1 = db.insertFlow('Flow1', def1);
      db.addFlowStep(flow1, 1, def1);
      db.addFlowStep(flow1, 2, def2);

      const flow2 = db.insertFlow('Flow2', def3);
      db.addFlowStep(flow2, 1, def3);

      const allFlows = db.getAllFlowsWithSteps();
      expect(allFlows).toHaveLength(2);
      expect(allFlows.find(f => f.name === 'Flow1')!.steps).toHaveLength(2);
      expect(allFlows.find(f => f.name === 'Flow2')!.steps).toHaveLength(1);
    });
  });

  describe('getFlowCount / getFlowStats', () => {
    it('returns correct flow count', () => {
      const fileId = createFile('/project/controller.ts');
      const def1 = createDefinition(fileId, 'Controller1', 'function', 0, 10);
      const def2 = createDefinition(fileId, 'Controller2', 'function', 15, 25);

      expect(db.getFlowCount()).toBe(0);

      db.insertFlow('Flow1', def1);
      expect(db.getFlowCount()).toBe(1);

      db.insertFlow('Flow2', def2);
      expect(db.getFlowCount()).toBe(2);
    });

    it('returns correct flow statistics', () => {
      const fileId = createFile('/project/controller.ts');
      const def1 = createDefinition(fileId, 'Controller1', 'function', 0, 10);
      const def2 = createDefinition(fileId, 'Service1', 'function', 15, 25);
      const def3 = createDefinition(fileId, 'Repository1', 'function', 30, 40);

      const rootId = db.ensureRootModule();
      const moduleId = db.insertModule(rootId, 'test-module', 'Test Module');
      db.assignSymbolToModule(def2, moduleId);

      const flowId = db.insertFlow('TestFlow', def1);
      db.addFlowStep(flowId, 1, def1);
      db.addFlowStep(flowId, 2, def2, moduleId);
      db.addFlowStep(flowId, 3, def3);

      const stats = db.getFlowStats();
      expect(stats.flowCount).toBe(1);
      expect(stats.totalSteps).toBe(3);
      expect(stats.avgStepsPerFlow).toBe(3);
      expect(stats.modulesCovered).toBe(1);
    });
  });

  describe('clearFlows', () => {
    it('removes all flows and their steps', () => {
      const fileId = createFile('/project/controller.ts');
      const def1 = createDefinition(fileId, 'Controller1', 'function', 0, 10);
      const def2 = createDefinition(fileId, 'Controller2', 'function', 15, 25);

      const flow1 = db.insertFlow('Flow1', def1);
      db.addFlowStep(flow1, 1, def1);
      const flow2 = db.insertFlow('Flow2', def2);
      db.addFlowStep(flow2, 1, def2);

      expect(db.getFlowCount()).toBe(2);

      const cleared = db.clearFlows();
      expect(cleared).toBe(2);
      expect(db.getFlowCount()).toBe(0);
      expect(db.getFlowStats().totalSteps).toBe(0);
    });
  });

  describe('updateFlow', () => {
    it('updates flow name', () => {
      const fileId = createFile('/project/controller.ts');
      const defId = createDefinition(fileId, 'Controller', 'function', 0, 10);

      const flowId = db.insertFlow('OldName', defId);
      const updated = db.updateFlow(flowId, { name: 'NewName' });

      expect(updated).toBe(true);
      const flows = db.getFlows();
      expect(flows[0].name).toBe('NewName');
    });

    it('updates flow description', () => {
      const fileId = createFile('/project/controller.ts');
      const defId = createDefinition(fileId, 'Controller', 'function', 0, 10);

      const flowId = db.insertFlow('TestFlow', defId);
      db.updateFlow(flowId, { description: 'New description' });

      const flows = db.getFlows();
      expect(flows[0].description).toBe('New description');
    });

    it('updates flow domain', () => {
      const fileId = createFile('/project/controller.ts');
      const defId = createDefinition(fileId, 'Controller', 'function', 0, 10);

      const flowId = db.insertFlow('TestFlow', defId, undefined, 'old-domain');
      db.updateFlow(flowId, { domain: 'new-domain' });

      const flows = db.getFlows();
      expect(flows[0].domain).toBe('new-domain');
    });

    it('returns false for non-existent flow', () => {
      const updated = db.updateFlow(999, { name: 'Test' });
      expect(updated).toBe(false);
    });

    it('returns false when no updates provided', () => {
      const fileId = createFile('/project/controller.ts');
      const defId = createDefinition(fileId, 'Controller', 'function', 0, 10);

      const flowId = db.insertFlow('TestFlow', defId);
      const updated = db.updateFlow(flowId, {});

      expect(updated).toBe(false);
    });
  });

  describe('integration: full flow detection', () => {
    it('detects a complete flow from controller to repository', () => {
      // Setup a realistic flow: Controller -> Service -> Repository
      const controllerFile = createFile('/project/controllers/sales.controller.ts');
      const serviceFile = createFile('/project/services/sales.service.ts');
      const repoFile = createFile('/project/repositories/sales.repository.ts');

      const controllerDef = createDefinition(controllerFile, 'SalesController', 'class', 0, 50);
      const serviceDef = createDefinition(serviceFile, 'salesService', 'function', 0, 40);
      const repoDef = createDefinition(repoFile, 'salesRepository', 'function', 0, 30);

      // Set metadata
      db.setDefinitionMetadata(controllerDef, 'role', 'controller');
      db.setDefinitionMetadata(controllerDef, 'domain', '["sales"]');
      db.setDefinitionMetadata(serviceDef, 'role', 'service');
      db.setDefinitionMetadata(serviceDef, 'domain', '["sales"]');
      db.setDefinitionMetadata(repoDef, 'role', 'repository');
      db.setDefinitionMetadata(repoDef, 'domain', '["sales"]');

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

      // Find entry points
      const entryPoints = db.getEntryPoints();
      expect(entryPoints.length).toBeGreaterThanOrEqual(1);
      const salesEntry = entryPoints.find(ep => ep.name === 'SalesController');
      expect(salesEntry).toBeDefined();
      expect(salesEntry!.domain).toBe('sales');

      // Trace flow
      const trace = db.traceFlowFromEntry(salesEntry!.id);
      expect(trace.length).toBeGreaterThanOrEqual(3);

      // Create flow
      const flowId = db.insertFlow('CreateSale', salesEntry!.id, 'Creates a new sale', 'sales');
      for (let i = 0; i < trace.length; i++) {
        db.addFlowStep(flowId, i + 1, trace[i].definitionId, trace[i].moduleId ?? undefined, trace[i].layer ?? undefined);
      }

      // Verify flow
      const flow = db.getFlowWithSteps(flowId);
      expect(flow).not.toBeNull();
      expect(flow!.name).toBe('CreateSale');
      expect(flow!.entryPointName).toBe('SalesController');
      expect(flow!.steps.length).toBeGreaterThanOrEqual(3);

      // Verify steps are in correct order
      const stepNames = flow!.steps.map(s => s.name);
      expect(stepNames[0]).toBe('SalesController');
      expect(stepNames).toContain('salesService');
      expect(stepNames).toContain('salesRepository');
    });
  });
});
