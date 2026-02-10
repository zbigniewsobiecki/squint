import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database.js';
import {
  getFlowsDagData,
  getFlowsData,
  getInteractionsData,
  getModulesData,
  getProcessGroupsData,
  getSymbolGraph,
} from '../../src/web/api-transforms.js';

describe('api-transforms', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================
  // Helpers
  // ============================================================

  function insertFile(filePath: string) {
    return db.insertFile({
      path: filePath,
      language: 'typescript',
      contentHash: `hash-${filePath}`,
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDefinition(
    fileId: number,
    name: string,
    kind = 'function',
    opts?: { line?: number; endLine?: number; isExported?: boolean; extendsName?: string }
  ) {
    return db.insertDefinition(fileId, {
      name,
      kind,
      isExported: opts?.isExported ?? true,
      isDefault: false,
      position: { row: (opts?.line ?? 1) - 1, column: 0 },
      endPosition: { row: (opts?.endLine ?? 10) - 1, column: 1 },
      extendsName: opts?.extendsName,
    });
  }

  function setupModuleHierarchy() {
    const rootId = db.ensureRootModule();
    const modA = db.insertModule(rootId, 'mod-a', 'ModA');
    const modB = db.insertModule(rootId, 'mod-b', 'ModB');
    return { rootId, modA, modB };
  }

  // ============================================================
  // getSymbolGraph
  // ============================================================

  describe('getSymbolGraph', () => {
    it('empty DB → empty graph', () => {
      const result = getSymbolGraph(db);
      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.stats.totalSymbols).toBe(0);
      expect(result.stats.totalRelationships).toBe(0);
    });

    it('definitions with metadata (purpose, pure flag)', () => {
      const fileId = insertFile('/src/utils.ts');
      const defId = insertDefinition(fileId, 'helper');
      db.setDefinitionMetadata(defId, 'purpose', 'Utility helper');
      db.setDefinitionMetadata(defId, 'pure', 'true');

      const result = getSymbolGraph(db);
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].name).toBe('helper');
      expect(result.nodes[0].purpose).toBe('Utility helper');
      expect(result.nodes[0].pure).toBe(true);
    });

    it('domain metadata as JSON array', () => {
      const fileId = insertFile('/src/utils.ts');
      const defId = insertDefinition(fileId, 'helper');
      db.setDefinitionMetadata(defId, 'domain', '["auth","billing"]');

      const result = getSymbolGraph(db);
      expect(result.nodes[0].domain).toEqual(['auth', 'billing']);
    });

    it('domain metadata as plain string', () => {
      const fileId = insertFile('/src/utils.ts');
      const defId = insertDefinition(fileId, 'helper');
      db.setDefinitionMetadata(defId, 'domain', 'infrastructure');

      const result = getSymbolGraph(db);
      expect(result.nodes[0].domain).toEqual(['infrastructure']);
    });

    it('relationship annotations appear as edges', () => {
      const fileId = insertFile('/src/a.ts');
      const def1 = insertDefinition(fileId, 'funcA');
      const def2 = insertDefinition(fileId, 'funcB');
      db.setRelationshipAnnotation(def1, def2, 'delegates to', 'uses');

      const result = getSymbolGraph(db);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].source).toBe(def1);
      expect(result.edges[0].target).toBe(def2);
      expect(result.edges[0].semantic).toBe('delegates to');
      expect(result.stats.totalRelationships).toBe(1);
      // Both defs should be marked as having annotations
      expect(result.nodes.find((n) => n.id === def1)?.hasAnnotations).toBe(true);
      expect(result.nodes.find((n) => n.id === def2)?.hasAnnotations).toBe(true);
    });

    it('module membership mapping', () => {
      const { modA } = setupModuleHierarchy();
      const fileId = insertFile('/src/a.ts');
      const defId = insertDefinition(fileId, 'funcA');
      db.assignSymbolToModule(defId, modA);

      const result = getSymbolGraph(db);
      const node = result.nodes.find((n) => n.id === defId);
      expect(node?.moduleId).toBe(modA);
      expect(node?.moduleName).toBe('ModA');
      expect(result.stats.moduleCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // getModulesData
  // ============================================================

  describe('getModulesData', () => {
    it('empty DB (catch branch) → empty modules', () => {
      // Before module tables are created, this should hit the catch
      const freshDb = new IndexDatabase(':memory:');
      freshDb.initialize();
      // No modules inserted → getAllModulesWithMembers returns empty or throws
      const result = getModulesData(freshDb);
      expect(result.modules).toEqual([]);
      expect(result.stats.moduleCount).toBe(0);
      freshDb.close();
    });

    it('modules with members and stats', () => {
      const { modA } = setupModuleHierarchy();
      const fileId = insertFile('/src/a.ts');
      const defId = insertDefinition(fileId, 'funcA');
      db.assignSymbolToModule(defId, modA);

      const result = getModulesData(db);
      expect(result.modules.length).toBeGreaterThanOrEqual(1);
      const mod = result.modules.find((m) => m.id === modA);
      expect(mod).toBeDefined();
      expect(mod!.name).toBe('ModA');
      expect(mod!.memberCount).toBeGreaterThanOrEqual(1);
    });

    it('module hierarchy with depth and colorIndex', () => {
      const rootId = db.ensureRootModule();
      const parent = db.insertModule(rootId, 'parent', 'Parent');
      const child = db.insertModule(parent, 'child', 'Child');
      const fileId = insertFile('/src/c.ts');
      const defId = insertDefinition(fileId, 'funcC');
      db.assignSymbolToModule(defId, child);

      const result = getModulesData(db);
      const childMod = result.modules.find((m) => m.id === child);
      expect(childMod).toBeDefined();
      expect(childMod!.depth).toBeGreaterThanOrEqual(2);
      expect(childMod!.parentId).toBe(parent);
    });
  });

  // ============================================================
  // getInteractionsData
  // ============================================================

  describe('getInteractionsData', () => {
    it('empty DB (catch branch) → empty data', () => {
      const freshDb = new IndexDatabase(':memory:');
      freshDb.initialize();
      const result = getInteractionsData(freshDb);
      expect(result.interactions).toEqual([]);
      expect(result.stats.totalCount).toBe(0);
      freshDb.close();
    });

    it('interactions with stats and relationship coverage', () => {
      const { modA, modB } = setupModuleHierarchy();
      db.insertInteraction(modA, modB, { direction: 'uni' });

      const result = getInteractionsData(db);
      expect(result.interactions).toHaveLength(1);
      expect(result.interactions[0].fromModuleId).toBe(modA);
      expect(result.interactions[0].toModuleId).toBe(modB);
      expect(result.stats.totalCount).toBeGreaterThanOrEqual(1);
    });

    it('process groups sub-call', () => {
      const { modA, modB } = setupModuleHierarchy();
      // Add files and definitions so modules have files for process grouping
      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);
      db.insertInteraction(modA, modB);

      const result = getInteractionsData(db);
      expect(result.processGroups).toBeDefined();
      expect(result.processGroups.groupCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================
  // getFlowsData
  // ============================================================

  describe('getFlowsData', () => {
    it('empty DB (catch branch) → empty data', () => {
      const freshDb = new IndexDatabase(':memory:');
      freshDb.initialize();
      const result = getFlowsData(freshDb);
      expect(result.flows).toEqual([]);
      expect(result.stats.flowCount).toBe(0);
      freshDb.close();
    });

    it('flow with interaction steps', () => {
      const { modA, modB } = setupModuleHierarchy();
      const intId = db.insertInteraction(modA, modB);
      const flowId = db.insertFlow('Login Flow', 'login-flow', {
        stakeholder: 'user',
        description: 'User login journey',
      });
      db.addFlowStep(flowId, intId);

      const result = getFlowsData(db);
      expect(result.flows).toHaveLength(1);
      expect(result.flows[0].name).toBe('Login Flow');
      expect(result.flows[0].stepCount).toBe(1);
      expect(result.flows[0].steps).toHaveLength(1);
    });

    it('flow stats and coverage', () => {
      const { modA, modB } = setupModuleHierarchy();
      const intId = db.insertInteraction(modA, modB);
      const flowId = db.insertFlow('F1', 'f1');
      db.addFlowStep(flowId, intId);

      const result = getFlowsData(db);
      expect(result.stats.flowCount).toBe(1);
      expect(result.coverage.totalInteractions).toBeGreaterThanOrEqual(1);
    });

    it('flow with no steps', () => {
      db.insertFlow('Empty Flow', 'empty-flow');

      const result = getFlowsData(db);
      expect(result.flows).toHaveLength(1);
      expect(result.flows[0].stepCount).toBe(0);
      expect(result.flows[0].steps).toEqual([]);
    });
  });

  // ============================================================
  // getFlowsDagData
  // ============================================================

  describe('getFlowsDagData', () => {
    it('empty DB → empty data', () => {
      const freshDb = new IndexDatabase(':memory:');
      freshDb.initialize();
      const result = getFlowsDagData(freshDb);
      expect(result.modules).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.flows).toEqual([]);
      expect(result.features).toEqual([]);
      freshDb.close();
    });

    it('modules with call graph edges', () => {
      const { modA, modB } = setupModuleHierarchy();
      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      // Create a reference from file A to file B to generate call graph edges
      db.insertReference(fileA, fileB, {
        type: 'import',
        source: './b',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
      });
      db.syncInteractionsFromCallGraph();

      const result = getFlowsDagData(db);
      expect(result.modules.length).toBeGreaterThanOrEqual(2);
    });

    it('flows falling back to interaction steps', () => {
      const { modA, modB } = setupModuleHierarchy();
      const intId = db.insertInteraction(modA, modB);
      const flowId = db.insertFlow('Test Flow', 'test-flow');
      db.addFlowStep(flowId, intId);

      const result = getFlowsDagData(db);
      expect(result.flows).toHaveLength(1);
      expect(result.flows[0].stepCount).toBeGreaterThanOrEqual(1);
    });

    it('flows with definition steps (preferred path)', () => {
      const { modA, modB } = setupModuleHierarchy();
      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      const flowId = db.insertFlow('Def Step Flow', 'def-step-flow');
      db.addFlowDefinitionStep(flowId, defA, defB);

      const result = getFlowsDagData(db);
      const flow = result.flows.find((f) => f.name === 'Def Step Flow');
      expect(flow).toBeDefined();
      // Definition steps have fromDefName/toDefName
      if (flow && flow.steps.length > 0) {
        expect(flow.steps[0].interactionId).toBeNull();
      }
    });

    it('features sub-section', () => {
      const flowId = db.insertFlow('My Flow', 'my-flow');
      const featureId = db.insertFeature('My Feature', 'my-feature', { description: 'A feature' });
      db.addFeatureFlows(featureId, [flowId]);

      // Need modules for the outer try to succeed
      db.ensureRootModule();

      const result = getFlowsDagData(db);
      expect(result.features).toHaveLength(1);
      expect(result.features[0].name).toBe('My Feature');
      expect(result.features[0].flowIds).toContain(flowId);
    });
  });

  // ============================================================
  // getProcessGroupsData
  // ============================================================

  describe('getProcessGroupsData', () => {
    it('empty DB → empty groups', () => {
      const freshDb = new IndexDatabase(':memory:');
      freshDb.initialize();
      const result = getProcessGroupsData(freshDb);
      expect(result.groups).toEqual([]);
      expect(result.groupCount).toBe(0);
      freshDb.close();
    });

    it('groups with isolated singleton filtering', () => {
      const { modA, modB } = setupModuleHierarchy();
      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      // Connect A and B via import so they share a group
      db.insertReference(fileA, fileB, {
        type: 'import',
        source: './b',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
      });

      const result = getProcessGroupsData(db);
      // Should have at least one group, isolated singletons with negative groupId filtered
      expect(result.groupCount).toBeGreaterThanOrEqual(1);
      for (const group of result.groups) {
        expect(group.label).toBeDefined();
        expect(group.moduleIds.length).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
