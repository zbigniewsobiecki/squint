import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database.js';
import { getFlowsDagData, getFlowsData, getInteractionsData } from '../../src/web/transforms/flow-transforms.js';

describe('flow-transforms', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  function insertFile(filePath: string) {
    return db.files.insert({
      path: filePath,
      language: 'typescript',
      contentHash: `hash-${filePath}`,
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDefinition(fileId: number, name: string, kind = 'function') {
    return db.files.insertDefinition(fileId, {
      name,
      kind,
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 10, column: 1 },
    });
  }

  function insertModule(parentId: number, slug: string, name: string) {
    return db.modules.insert(parentId, slug, name);
  }

  describe('getInteractionsData', () => {
    it('returns empty data when no interactions exist', () => {
      const result = getInteractionsData(db);
      expect(result.interactions).toEqual([]);
      expect(result.stats.totalCount).toBe(0);
      // SUM returns null for empty tables, not 0
      expect(result.stats.businessCount ?? 0).toBe(0);
      expect(result.stats.utilityCount ?? 0).toBe(0);
      expect(result.stats.biDirectionalCount ?? 0).toBe(0);
      expect(result.relationshipCoverage.totalRelationships).toBe(0);
      expect(result.processGroups.groups).toEqual([]);
      expect(result.processGroups.groupCount).toBe(0);
    });

    it('returns mapped interaction data with module paths', () => {
      const fileId = insertFile('/src/auth.ts');
      const defId1 = insertDefinition(fileId, 'AuthService', 'class');
      const defId2 = insertDefinition(fileId, 'ApiService', 'class');
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 'auth', 'Authentication');
      const mod2 = insertModule(rootId, 'api', 'API');
      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);

      const interactionId = db.interactions.insert(mod1, mod2, {
        direction: 'uni',
        weight: 5,
        pattern: 'business',
        symbols: ['login', 'logout'],
        semantic: 'Auth calls API',
        source: 'ast',
      });

      const result = getInteractionsData(db);

      expect(result.interactions).toHaveLength(1);
      expect(result.interactions[0].id).toBe(interactionId);
      expect(result.interactions[0].fromModuleId).toBe(mod1);
      expect(result.interactions[0].toModuleId).toBe(mod2);
      expect(result.interactions[0].fromModulePath).toContain('auth');
      expect(result.interactions[0].toModulePath).toContain('api');
      expect(result.interactions[0].direction).toBe('uni');
      expect(result.interactions[0].weight).toBe(5);
      expect(result.interactions[0].pattern).toBe('business');
      expect(result.interactions[0].symbols).toBe('["login","logout"]');
      expect(result.interactions[0].semantic).toBe('Auth calls API');
      expect(result.interactions[0].source).toBe('ast');
    });

    it('returns accurate stats for multiple interactions', () => {
      const fileId = insertFile('/src/services.ts');
      const defId1 = insertDefinition(fileId, 'ServiceA');
      const defId2 = insertDefinition(fileId, 'ServiceB');
      const defId3 = insertDefinition(fileId, 'ServiceC');
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 'a', 'Module A');
      const mod2 = insertModule(rootId, 'b', 'Module B');
      const mod3 = insertModule(rootId, 'c', 'Module C');
      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);
      db.modules.assignSymbol(defId3, mod3);

      db.interactions.insert(mod1, mod2, { pattern: 'business', direction: 'bi' });
      db.interactions.insert(mod2, mod3, { pattern: 'utility', direction: 'uni' });
      db.interactions.insert(mod1, mod3, { pattern: 'business', direction: 'uni' });

      const result = getInteractionsData(db);

      expect(result.stats.totalCount).toBe(3);
      expect(result.stats.businessCount).toBe(2);
      expect(result.stats.utilityCount).toBe(1);
      expect(result.stats.biDirectionalCount).toBe(1);
    });

    it('returns relationship coverage metrics', () => {
      const fileId = insertFile('/src/code.ts');
      const defId1 = insertDefinition(fileId, 'FuncA');
      const defId2 = insertDefinition(fileId, 'FuncB');
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 'modA', 'Module A');
      const mod2 = insertModule(rootId, 'modB', 'Module B');
      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);

      // Add relationship annotation
      db.relationships.set(defId1, defId2, 'A uses B', 'uses');

      // Add interaction that covers the relationship
      db.interactions.insert(mod1, mod2);

      const result = getInteractionsData(db);

      expect(result.relationshipCoverage.totalRelationships).toBeGreaterThan(0);
      expect(result.relationshipCoverage.crossModuleRelationships).toBeGreaterThan(0);
      expect(result.relationshipCoverage.relationshipsContributingToInteractions).toBe(1);
    });

    it('handles errors gracefully and returns empty state', () => {
      // Close the database to trigger errors
      db.close();

      const result = getInteractionsData(db);

      expect(result.interactions).toEqual([]);
      expect(result.stats.totalCount).toBe(0);
      expect(result.relationshipCoverage.coveragePercent).toBe(0);
      expect(result.processGroups.groupCount).toBe(0);
    });
  });

  describe('getFlowsData', () => {
    it('returns empty data when no flows exist', () => {
      const result = getFlowsData(db);
      expect(result.flows).toEqual([]);
      expect(result.stats.flowCount).toBe(0);
      expect(result.stats.withEntryPointCount).toBe(0);
      expect(result.stats.avgStepsPerFlow).toBe(0);
      expect(result.coverage.totalInteractions).toBe(0);
      expect(result.coverage.coveredByFlows).toBe(0);
      expect(result.coverage.percentage).toBe(0);
    });

    it('returns flows with hierarchical structure and steps', () => {
      const fileId = insertFile('/src/flows.ts');
      const defId1 = insertDefinition(fileId, 'EntryPoint');
      const defId2 = insertDefinition(fileId, 'ServiceA');
      const defId3 = insertDefinition(fileId, 'ServiceB');
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 'frontend', 'Frontend');
      const mod2 = insertModule(rootId, 'backend', 'Backend');
      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod1);
      db.modules.assignSymbol(defId3, mod2);

      const int1 = db.interactions.insert(mod1, mod2, { semantic: 'Frontend calls Backend' });

      const flowId = db.flows.insert('User Login', 'user-login', {
        entryPath: null,
        stakeholder: 'User',
        description: 'User logs into the system',
        actionType: 'create',
        targetEntity: 'session',
        tier: 1,
      });

      db.flows.addStep(flowId, int1, 1);

      const result = getFlowsData(db);

      expect(result.flows).toHaveLength(1);
      expect(result.flows[0].id).toBe(flowId);
      expect(result.flows[0].name).toBe('User Login');
      expect(result.flows[0].slug).toBe('user-login');
      expect(result.flows[0].stakeholder).toBe('User');
      expect(result.flows[0].description).toBe('User logs into the system');
      expect(result.flows[0].actionType).toBe('create');
      expect(result.flows[0].targetEntity).toBe('session');
      expect(result.flows[0].tier).toBe(1);
      expect(result.flows[0].stepCount).toBe(1);
      expect(result.flows[0].steps).toHaveLength(1);
      expect(result.flows[0].steps[0].stepOrder).toBe(1);
      expect(result.flows[0].steps[0].fromModulePath).toContain('frontend');
      expect(result.flows[0].steps[0].toModulePath).toContain('backend');
      expect(result.flows[0].steps[0].semantic).toBe('Frontend calls Backend');
    });

    it('returns accurate flow statistics', () => {
      const fileId = insertFile('/src/app.ts');
      const defEntry = insertDefinition(fileId, 'MainEntry');
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 'main', 'Main');
      db.modules.assignSymbol(defEntry, mod1);

      db.flows.insert('Flow 1', 'flow-1', {
        entryPointModuleId: mod1,
        tier: 1,
      });
      db.flows.insert('Flow 2', 'flow-2', {
        entryPath: null,
        tier: 2,
      });

      const result = getFlowsData(db);

      expect(result.stats.flowCount).toBe(2);
      expect(result.stats.withEntryPointCount).toBe(1);
    });

    it('returns flow coverage metrics', () => {
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 'm1', 'M1');
      const mod2 = insertModule(rootId, 'm2', 'M2');
      const int1 = db.interactions.insert(mod1, mod2);

      const flowId = db.flows.insert('Test Flow', 'test-flow', {
        tier: 1,
      });
      db.flows.addStep(flowId, int1, 1);

      const result = getFlowsData(db);

      expect(result.coverage.totalInteractions).toBe(1);
      expect(result.coverage.coveredByFlows).toBe(1);
      expect(result.coverage.percentage).toBe(100);
    });

    it('handles errors gracefully and returns empty state', () => {
      db.close();

      const result = getFlowsData(db);

      expect(result.flows).toEqual([]);
      expect(result.stats.flowCount).toBe(0);
      expect(result.coverage.percentage).toBe(0);
    });
  });

  describe('getFlowsDagData', () => {
    it('returns empty data when no modules/flows exist', () => {
      const result = getFlowsDagData(db);
      expect(result.modules).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.flows).toEqual([]);
      expect(result.features).toEqual([]);
    });

    it('returns modules with member counts', () => {
      const fileId = insertFile('/src/mod.ts');
      const defId1 = insertDefinition(fileId, 'ClassA', 'class');
      const defId2 = insertDefinition(fileId, 'ClassB', 'class');
      const rootId = db.modules.ensureRoot();
      const modId = insertModule(rootId, 'services', 'Services');
      db.modules.assignSymbol(defId1, modId);
      db.modules.assignSymbol(defId2, modId);

      const result = getFlowsDagData(db);

      const serviceModule = result.modules.find((m) => m.name === 'Services');
      expect(serviceModule).toBeDefined();
      expect(serviceModule!.id).toBe(modId);
      expect(serviceModule!.fullPath).toContain('services');
      expect(serviceModule!.memberCount).toBe(2);
    });

    it('returns call graph edges with weights', () => {
      const fileId1 = insertFile('/src/mod1.ts');
      const fileId2 = insertFile('/src/mod2.ts');
      const defId1 = insertDefinition(fileId1, 'CallerFunc', 'function', 5);
      const defId2 = insertDefinition(fileId2, 'CalleeFunc', 'function', 0);
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 'mod1', 'Mod1');
      const mod2 = insertModule(rootId, 'mod2', 'Mod2');
      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);

      // Create call relationship to generate call graph edge
      const refId = db.insertReference(fileId1, fileId2, {
        type: 'import',
        source: './mod2',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });
      const symbolId = db.insertSymbol(refId, defId2, {
        name: 'CalleeFunc',
        localName: 'CalleeFunc',
        kind: 'named',
        usages: [],
      });
      db.insertUsage(symbolId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
      });

      const result = getFlowsDagData(db);

      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].fromModuleId).toBe(mod1);
      expect(result.edges[0].toModuleId).toBe(mod2);
      expect(result.edges[0].weight).toBe(1);
    });

    it('returns flows with definition-level steps when available', () => {
      const fileId = insertFile('/src/flow.ts');
      const defId1 = insertDefinition(fileId, 'Caller');
      const defId2 = insertDefinition(fileId, 'Callee');
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 'caller', 'Caller Mod');
      const mod2 = insertModule(rootId, 'callee', 'Callee Mod');
      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);

      const flowId = db.flows.insert('Def Flow', 'def-flow', {
        tier: 1,
      });

      db.flows.addDefinitionStep(flowId, defId1, defId2, 1);

      const result = getFlowsDagData(db);

      const flow = result.flows.find((f) => f.name === 'Def Flow');
      expect(flow).toBeDefined();
      expect(flow!.stepCount).toBe(1);
      expect(flow!.steps).toHaveLength(1);
      expect(flow!.steps[0].fromModuleId).toBe(mod1);
      expect(flow!.steps[0].toModuleId).toBe(mod2);
      expect(flow!.steps[0].semantic).toBeNull(); // Definition steps don't have semantic
      expect(flow!.steps[0].fromDefName).toBe('Caller');
      expect(flow!.steps[0].toDefName).toBe('Callee');
      expect(flow!.steps[0].interactionId).toBeNull();
    });

    it('falls back to interaction steps when no definition steps exist', () => {
      const fileId = insertFile('/src/interact.ts');
      const defId1 = insertDefinition(fileId, 'S1');
      const defId2 = insertDefinition(fileId, 'S2');
      const rootId = db.modules.ensureRoot();
      const mod1 = insertModule(rootId, 's1', 'S1');
      const mod2 = insertModule(rootId, 's2', 'S2');
      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);

      const intId = db.interactions.insert(mod1, mod2, {
        semantic: 'S1 to S2',
      });

      const flowId = db.flows.insert('Int Flow', 'int-flow', {
        tier: 1,
      });
      db.flows.addStep(flowId, intId, 1);

      const result = getFlowsDagData(db);

      const flow = result.flows.find((f) => f.name === 'Int Flow');
      expect(flow).toBeDefined();
      expect(flow!.stepCount).toBe(1);
      expect(flow!.steps[0].interactionId).toBe(intId);
      expect(flow!.steps[0].fromModuleId).toBe(mod1);
      expect(flow!.steps[0].toModuleId).toBe(mod2);
      expect(flow!.steps[0].semantic).toBe('S1 to S2');
      expect(flow!.steps[0].fromDefName).toBeNull();
      expect(flow!.steps[0].toDefName).toBeNull();
    });

    it('returns features with associated flow IDs', () => {
      const flowId1 = db.flows.insert('Flow A', 'flow-a', {
        tier: 1,
      });
      const flowId2 = db.flows.insert('Flow B', 'flow-b', {
        tier: 1,
      });

      const featureId = db.features.insert('Auth Feature', 'auth-feature', {
        description: 'User authentication',
      });

      db.features.addFlows(featureId, [flowId1, flowId2]);

      const result = getFlowsDagData(db);

      expect(result.features).toHaveLength(1);
      expect(result.features[0].id).toBe(featureId);
      expect(result.features[0].name).toBe('Auth Feature');
      expect(result.features[0].slug).toBe('auth-feature');
      expect(result.features[0].description).toBe('User authentication');
      expect(result.features[0].flowIds).toEqual([flowId1, flowId2]);
    });

    it('handles missing features gracefully', () => {
      const rootId = db.modules.ensureRoot();
      const modId = insertModule(rootId, 'test', 'Test');

      // No features exist, should not throw
      const result = getFlowsDagData(db);

      expect(result.features).toEqual([]);
      expect(result.modules.length).toBeGreaterThan(0); // Still returns modules
    });

    it('handles errors gracefully and returns empty state', () => {
      db.close();

      const result = getFlowsDagData(db);

      expect(result.modules).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.flows).toEqual([]);
      expect(result.features).toEqual([]);
    });
  });
});
