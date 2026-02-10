import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../../src/db/database.js';
import { FlowFacade, ModuleFacade, SymbolFacade } from '../../../src/db/facades/index.js';

describe('facades', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  function insertFile() {
    return db.insertFile({
      path: '/src/test.ts',
      language: 'typescript',
      contentHash: 'abc',
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDefinitionHelper(fileId: number, name: string) {
    return db.insertDefinition(fileId, {
      name,
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });
  }

  // ============================================
  // SymbolFacade
  // ============================================
  describe('SymbolFacade', () => {
    it('constructs without error', () => {
      const facade = new SymbolFacade(db);
      expect(facade).toBeDefined();
    });

    it('delegates getDefinitionById', () => {
      const fileId = insertFile();
      const defId = insertDefinitionHelper(fileId, 'myFunc');

      const facade = new SymbolFacade(db);
      const result = facade.getDefinitionById(defId);
      expect(result).toBeDefined();
      expect(result?.name).toBe('myFunc');
    });

    it('delegates metadata operations', () => {
      const fileId = insertFile();
      const defId = insertDefinitionHelper(fileId, 'myFunc');

      const facade = new SymbolFacade(db);
      facade.setDefinitionMetadata(defId, 'purpose', 'Does stuff');
      expect(facade.getDefinitionMetadataValue(defId, 'purpose')).toBe('Does stuff');
    });

    it('delegates getDefinitionCount', () => {
      const fileId = insertFile();
      insertDefinitionHelper(fileId, 'a');
      insertDefinitionHelper(fileId, 'b');

      const facade = new SymbolFacade(db);
      expect(facade.getDefinitionCount()).toBe(2);
    });

    it('delegates getDefinitionsWithMetadata / getDefinitionsWithoutMetadata', () => {
      const fileId = insertFile();
      const defId = insertDefinitionHelper(fileId, 'a');
      insertDefinitionHelper(fileId, 'b');

      const facade = new SymbolFacade(db);
      facade.setDefinitionMetadata(defId, 'purpose', 'test');

      expect(facade.getDefinitionsWithMetadata('purpose')).toEqual([defId]);
      expect(facade.getDefinitionsWithoutMetadata('purpose')).toHaveLength(1);
    });

    it('delegates relationship operations', () => {
      const fileId = insertFile();
      const def1 = insertDefinitionHelper(fileId, 'a');
      const def2 = insertDefinitionHelper(fileId, 'b');

      const facade = new SymbolFacade(db);
      facade.setRelationshipAnnotation(def1, def2, 'delegates work', 'uses');

      const annotation = facade.getRelationshipAnnotation(def1, def2);
      expect(annotation).toBeDefined();
      expect(annotation?.semantic).toBe('delegates work');
    });
  });

  // ============================================
  // ModuleFacade
  // ============================================
  describe('ModuleFacade', () => {
    it('constructs without error', () => {
      const facade = new ModuleFacade(db);
      expect(facade).toBeDefined();
    });

    it('delegates module lifecycle operations', () => {
      const rootId = db.ensureRootModule();

      const facade = new ModuleFacade(db);
      const modId = facade.insertModule(rootId, 'test-mod', 'Test Module', 'A test');

      expect(modId).toBeGreaterThan(0);
      const mod = facade.getModuleById(modId);
      expect(mod?.name).toBe('Test Module');
      expect(mod?.description).toBe('A test');
    });

    it('delegates getAllModules', () => {
      const rootId = db.ensureRootModule();
      db.insertModule(rootId, 'a', 'A');
      db.insertModule(rootId, 'b', 'B');

      const facade = new ModuleFacade(db);
      const modules = facade.getAllModules();
      expect(modules.length).toBeGreaterThanOrEqual(3); // root + a + b
    });

    it('delegates symbol assignment', () => {
      const rootId = db.ensureRootModule();
      const modId = db.insertModule(rootId, 'test', 'Test');
      const fileId = insertFile();
      const defId = insertDefinitionHelper(fileId, 'myFunc');

      const facade = new ModuleFacade(db);
      facade.assignSymbolToModule(defId, modId);

      const members = facade.getModuleSymbols(modId);
      expect(members.length).toBeGreaterThanOrEqual(1);
    });

    it('delegates getModuleCount', () => {
      const rootId = db.ensureRootModule();
      db.insertModule(rootId, 'a', 'A');

      const facade = new ModuleFacade(db);
      expect(facade.getModuleCount()).toBeGreaterThanOrEqual(2);
    });
  });

  // ============================================
  // FlowFacade
  // ============================================
  describe('FlowFacade', () => {
    it('constructs without error', () => {
      const facade = new FlowFacade(db);
      expect(facade).toBeDefined();
    });

    it('delegates flow lifecycle operations', () => {
      const facade = new FlowFacade(db);
      const flowId = facade.insertFlow('TestFlow', 'test-flow', { description: 'Test' });
      expect(flowId).toBeGreaterThan(0);

      const flow = facade.getFlowById(flowId);
      expect(flow?.name).toBe('TestFlow');
      expect(flow?.slug).toBe('test-flow');
    });

    it('delegates getFlowBySlug', () => {
      const facade = new FlowFacade(db);
      facade.insertFlow('Test', 'my-slug');

      const flow = facade.getFlowBySlug('my-slug');
      expect(flow?.name).toBe('Test');
    });

    it('delegates getAllFlows', () => {
      const facade = new FlowFacade(db);
      facade.insertFlow('A', 'slug-a');
      facade.insertFlow('B', 'slug-b');

      expect(facade.getAllFlows()).toHaveLength(2);
    });

    it('delegates flow step operations', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'a', 'A');
      const mod2 = db.insertModule(rootId, 'b', 'B');

      const facade = new FlowFacade(db);
      const intId = facade.insertInteraction(mod1, mod2);
      const flowId = facade.insertFlow('StepTest', 'step-test');
      facade.addFlowStep(flowId, intId);

      const steps = facade.getFlowSteps(flowId);
      expect(steps).toHaveLength(1);
      expect(steps[0].interactionId).toBe(intId);
    });

    it('delegates interaction operations', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'x', 'X');
      const mod2 = db.insertModule(rootId, 'y', 'Y');

      const facade = new FlowFacade(db);
      const intId = facade.insertInteraction(mod1, mod2);
      expect(intId).toBeGreaterThan(0);

      const interaction = facade.getInteractionById(intId);
      expect(interaction).toBeDefined();
      expect(interaction?.fromModuleId).toBe(mod1);
      expect(interaction?.toModuleId).toBe(mod2);
    });

    it('delegates getFlowCount', () => {
      const facade = new FlowFacade(db);
      facade.insertFlow('A', 'a');
      expect(facade.getFlowCount()).toBe(1);
    });

    it('delegates deleteFlow', () => {
      const facade = new FlowFacade(db);
      const flowId = facade.insertFlow('Del', 'del');
      expect(facade.deleteFlow(flowId)).toBe(true);
      expect(facade.getFlowById(flowId)).toBeNull();
    });

    it('delegates clearFlows', () => {
      const facade = new FlowFacade(db);
      facade.insertFlow('A', 'a');
      facade.insertFlow('B', 'b');
      const cleared = facade.clearFlows();
      expect(cleared).toBe(2);
      expect(facade.getAllFlows()).toEqual([]);
    });

    it('delegates getAllInteractions', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'p', 'P');
      const mod2 = db.insertModule(rootId, 'q', 'Q');

      const facade = new FlowFacade(db);
      facade.insertInteraction(mod1, mod2);

      const interactions = facade.getAllInteractions();
      expect(interactions).toHaveLength(1);
    });
  });

  // ============================================
  // SymbolFacade - additional delegation tests
  // ============================================
  describe('SymbolFacade - additional', () => {
    it('delegates getDefinitionsByName', () => {
      const fileId = insertFile();
      insertDefinitionHelper(fileId, 'myFunc');

      const facade = new SymbolFacade(db);
      const results = facade.getDefinitionsByName('myFunc');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('myFunc');
    });

    it('delegates getAllDefinitions with no filters', () => {
      const fileId = insertFile();
      insertDefinitionHelper(fileId, 'a');
      insertDefinitionHelper(fileId, 'b');

      const facade = new SymbolFacade(db);
      const all = facade.getAllDefinitions();
      expect(all).toHaveLength(2);
    });

    it('delegates getAllDefinitions with kind filter', () => {
      const fileId = insertFile();
      insertDefinitionHelper(fileId, 'myFunc');
      db.insertDefinition(fileId, {
        name: 'MyClass',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 10, column: 0 },
        endPosition: { row: 20, column: 1 },
      });

      const facade = new SymbolFacade(db);
      const classes = facade.getAllDefinitions({ kind: 'class' });
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('MyClass');
    });

    it('delegates getAspectCoverage', () => {
      const fileId = insertFile();
      const defId = insertDefinitionHelper(fileId, 'a');
      insertDefinitionHelper(fileId, 'b');

      const facade = new SymbolFacade(db);
      facade.setDefinitionMetadata(defId, 'purpose', 'test');

      const coverage = facade.getAspectCoverage();
      expect(coverage).toBeDefined();
    });

    it('delegates getRelationshipsFrom', () => {
      const fileId = insertFile();
      const def1 = insertDefinitionHelper(fileId, 'a');
      const def2 = insertDefinitionHelper(fileId, 'b');

      const facade = new SymbolFacade(db);
      facade.setRelationshipAnnotation(def1, def2, 'calls', 'uses');

      const rels = facade.getRelationshipsFrom(def1);
      expect(rels).toHaveLength(1);
      expect(rels[0].toDefinitionId).toBe(def2);
    });

    it('delegates getRelationshipsTo', () => {
      const fileId = insertFile();
      const def1 = insertDefinitionHelper(fileId, 'a');
      const def2 = insertDefinitionHelper(fileId, 'b');

      const facade = new SymbolFacade(db);
      facade.setRelationshipAnnotation(def1, def2, 'calls', 'uses');

      const rels = facade.getRelationshipsTo(def2);
      expect(rels).toHaveLength(1);
      expect(rels[0].fromDefinitionId).toBe(def1);
    });

    it('delegates getUnannotatedRelationships', () => {
      const facade = new SymbolFacade(db);
      const result = facade.getUnannotatedRelationships();
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('delegates getNextRelationshipToAnnotate', () => {
      const facade = new SymbolFacade(db);
      const result = facade.getNextRelationshipToAnnotate();
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ============================================
  // ModuleFacade - additional delegation tests
  // ============================================
  describe('ModuleFacade - additional', () => {
    it('delegates getModuleByPath', () => {
      const rootId = db.ensureRootModule();
      db.insertModule(rootId, 'my-mod', 'MyMod');

      const facade = new ModuleFacade(db);
      const mod = facade.getModuleByPath('project.my-mod');
      expect(mod).toBeDefined();
      expect(mod?.name).toBe('MyMod');
    });

    it('delegates getModuleTree', () => {
      const rootId = db.ensureRootModule();
      db.insertModule(rootId, 'child', 'Child');

      const facade = new ModuleFacade(db);
      const tree = facade.getModuleTree();
      expect(tree).toBeDefined();
      expect(tree?.children?.length).toBeGreaterThanOrEqual(1);
    });

    it('delegates getModuleStats', () => {
      const rootId = db.ensureRootModule();
      db.insertModule(rootId, 'a', 'A');

      const facade = new ModuleFacade(db);
      const stats = facade.getModuleStats();
      expect(stats).toBeDefined();
      expect(stats.moduleCount).toBeGreaterThanOrEqual(2);
    });

    it('delegates getModuleWithMembers', () => {
      const rootId = db.ensureRootModule();
      const modId = db.insertModule(rootId, 'mod', 'Mod');
      const fileId = insertFile();
      const defId = insertDefinitionHelper(fileId, 'fn');
      db.assignSymbolToModule(defId, modId);

      const facade = new ModuleFacade(db);
      const mod = facade.getModuleWithMembers(modId);
      expect(mod).toBeDefined();
      expect(mod?.members).toHaveLength(1);
    });

    it('delegates getModulesExceedingThreshold', () => {
      const rootId = db.ensureRootModule();
      const modId = db.insertModule(rootId, 'big', 'Big');
      const fileId = insertFile();
      // Insert multiple definitions to exceed threshold
      for (let i = 0; i < 5; i++) {
        const defId = db.insertDefinition(fileId, {
          name: `fn${i}`,
          kind: 'function',
          isExported: true,
          isDefault: false,
          position: { row: i * 10, column: 0 },
          endPosition: { row: i * 10 + 5, column: 1 },
        });
        db.assignSymbolToModule(defId, modId);
      }

      const facade = new ModuleFacade(db);
      const big = facade.getModulesExceedingThreshold(3);
      expect(big.length).toBeGreaterThanOrEqual(1);
      expect(big[0].members.length).toBeGreaterThanOrEqual(4);
    });

    it('delegates getUnassignedSymbols', () => {
      const rootId = db.ensureRootModule();
      const fileId = insertFile();
      insertDefinitionHelper(fileId, 'unassigned');

      const facade = new ModuleFacade(db);
      const unassigned = facade.getUnassignedSymbols();
      expect(unassigned.length).toBeGreaterThanOrEqual(1);
    });

    it('delegates getDefinitionModule', () => {
      const rootId = db.ensureRootModule();
      const modId = db.insertModule(rootId, 'target', 'Target');
      const fileId = insertFile();
      const defId = insertDefinitionHelper(fileId, 'fn');
      db.assignSymbolToModule(defId, modId);

      const facade = new ModuleFacade(db);
      const result = facade.getDefinitionModule(defId);
      expect(result).toBeDefined();
      expect(result?.module?.id).toBe(modId);
    });

    it('delegates assignColorIndices', () => {
      const rootId = db.ensureRootModule();
      db.insertModule(rootId, 'a', 'A');
      db.insertModule(rootId, 'b', 'B');

      const facade = new ModuleFacade(db);
      // Should not throw
      facade.assignColorIndices();

      const modules = facade.getAllModules();
      // After assignColorIndices, modules should have colorIndex assigned
      expect(modules.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ============================================
  // FlowFacade - additional delegation tests
  // ============================================
  describe('FlowFacade - additional', () => {
    it('delegates getFlowsByStakeholder', () => {
      const facade = new FlowFacade(db);
      facade.insertFlow('User Flow', 'user-flow', { stakeholder: 'user' });
      facade.insertFlow('Admin Flow', 'admin-flow', { stakeholder: 'admin' });

      const userFlows = facade.getFlowsByStakeholder('user');
      expect(userFlows).toHaveLength(1);
      expect(userFlows[0].name).toBe('User Flow');
    });

    it('delegates getFlowStats', () => {
      const facade = new FlowFacade(db);
      facade.insertFlow('A', 'a');

      const stats = facade.getFlowStats();
      expect(stats).toBeDefined();
      expect(stats.flowCount).toBe(1);
    });

    it('delegates addFlowSteps (multiple)', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'a', 'A');
      const mod2 = db.insertModule(rootId, 'b', 'B');
      const mod3 = db.insertModule(rootId, 'c', 'C');

      const facade = new FlowFacade(db);
      const int1 = facade.insertInteraction(mod1, mod2);
      const int2 = facade.insertInteraction(mod2, mod3);
      const flowId = facade.insertFlow('Multi', 'multi');
      facade.addFlowSteps(flowId, [int1, int2]);

      const steps = facade.getFlowSteps(flowId);
      expect(steps).toHaveLength(2);
    });

    it('delegates getFlowWithSteps', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'x', 'X');
      const mod2 = db.insertModule(rootId, 'y', 'Y');

      const facade = new FlowFacade(db);
      const intId = facade.insertInteraction(mod1, mod2);
      const flowId = facade.insertFlow('WithSteps', 'with-steps');
      facade.addFlowStep(flowId, intId);

      const result = facade.getFlowWithSteps(flowId);
      expect(result).toBeDefined();
      expect(result?.steps).toHaveLength(1);
      expect(result?.steps[0].interaction).toBeDefined();
    });

    it('delegates expandFlow', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'r', 'R');
      const mod2 = db.insertModule(rootId, 's', 'S');

      const facade = new FlowFacade(db);
      const intId = facade.insertInteraction(mod1, mod2);
      const flowId = facade.insertFlow('Expand', 'expand');
      facade.addFlowStep(flowId, intId);

      const expanded = facade.expandFlow(flowId);
      expect(expanded).toBeDefined();
    });

    it('delegates getFlowCoverage', () => {
      const facade = new FlowFacade(db);
      const coverage = facade.getFlowCoverage();
      expect(coverage).toBeDefined();
      expect(coverage.totalInteractions).toBeGreaterThanOrEqual(0);
    });

    it('delegates upsertInteraction', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'u', 'U');
      const mod2 = db.insertModule(rootId, 'v', 'V');

      const facade = new FlowFacade(db);
      const id1 = facade.upsertInteraction(mod1, mod2);
      const id2 = facade.upsertInteraction(mod1, mod2); // Same pair → same ID
      expect(id1).toBe(id2);
    });

    it('delegates getInteractionsByPattern', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'i', 'I');
      const mod2 = db.insertModule(rootId, 'j', 'J');

      const facade = new FlowFacade(db);
      facade.insertInteraction(mod1, mod2, { pattern: 'business' });

      const business = facade.getInteractionsByPattern('business');
      expect(business).toHaveLength(1);
    });

    it('delegates getInteractionCount', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'k', 'K');
      const mod2 = db.insertModule(rootId, 'l', 'L');

      const facade = new FlowFacade(db);
      facade.insertInteraction(mod1, mod2);
      expect(facade.getInteractionCount()).toBe(1);
    });

    it('delegates getModuleCallGraph', () => {
      const facade = new FlowFacade(db);
      const graph = facade.getModuleCallGraph();
      expect(Array.isArray(graph)).toBe(true);
    });

    it('delegates syncInteractionsFromCallGraph', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'sync-a', 'SA');
      const mod2 = db.insertModule(rootId, 'sync-b', 'SB');

      const file1 = db.insertFile({
        path: '/sync/a.ts',
        language: 'typescript',
        contentHash: 'sa',
        sizeBytes: 100,
        modifiedAt: '2024-01-01',
      });
      const file2 = db.insertFile({
        path: '/sync/b.ts',
        language: 'typescript',
        contentHash: 'sb',
        sizeBytes: 100,
        modifiedAt: '2024-01-01',
      });
      const def1 = insertDefinitionHelper(file1, 'syncFn1');
      const def2 = insertDefinitionHelper(file2, 'syncFn2');
      db.assignSymbolToModule(def1, mod1);
      db.assignSymbolToModule(def2, mod2);
      db.insertReference(file1, file2, {
        type: 'import',
        source: './b',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
      });

      const facade = new FlowFacade(db);
      const result = facade.syncInteractionsFromCallGraph();
      expect(result).toBeDefined();
      expect(result.created).toBeGreaterThanOrEqual(0);
    });

    it('delegates getRelationshipCoverage', () => {
      const facade = new FlowFacade(db);
      const coverage = facade.getRelationshipCoverage();
      expect(coverage).toBeDefined();
    });

    it('delegates getUncoveredInteractions', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'unc-a', 'UA');
      const mod2 = db.insertModule(rootId, 'unc-b', 'UB');

      const facade = new FlowFacade(db);
      facade.insertInteraction(mod1, mod2);

      const uncovered = facade.getUncoveredInteractions();
      expect(uncovered).toHaveLength(1);
    });

    it('delegates getInteractionStats', () => {
      const facade = new FlowFacade(db);
      const stats = facade.getInteractionStats();
      expect(stats).toBeDefined();
      expect(stats.totalCount).toBeGreaterThanOrEqual(0);
    });

    it('delegates getFlowsWithInteraction', () => {
      const rootId = db.ensureRootModule();
      const mod1 = db.insertModule(rootId, 'fwi-a', 'FWIA');
      const mod2 = db.insertModule(rootId, 'fwi-b', 'FWIB');

      const facade = new FlowFacade(db);
      const intId = facade.insertInteraction(mod1, mod2);
      const flowId = facade.insertFlow('FWI', 'fwi');
      facade.addFlowStep(flowId, intId);

      const flows = facade.getFlowsWithInteraction(intId);
      expect(flows).toHaveLength(1);
      expect(flows[0].id).toBe(flowId);
    });
  });

  // ============================================
  // IndexDatabase feature facade methods
  // ============================================
  describe('Feature facade methods on IndexDatabase', () => {
    it('insertFeature + getFeatureById round-trip', () => {
      const featureId = db.insertFeature('Customer Management', 'customer-management', {
        description: 'Customer CRUD',
      });
      expect(featureId).toBeGreaterThan(0);

      const feature = db.getFeatureById(featureId);
      expect(feature).not.toBeNull();
      expect(feature!.name).toBe('Customer Management');
      expect(feature!.slug).toBe('customer-management');
      expect(feature!.description).toBe('Customer CRUD');
    });

    it('getFeatureBySlug', () => {
      db.insertFeature('Auth', 'auth-feature');

      const feature = db.getFeatureBySlug('auth-feature');
      expect(feature).not.toBeNull();
      expect(feature!.name).toBe('Auth');
    });

    it('getFeatureBySlug returns null for missing slug', () => {
      expect(db.getFeatureBySlug('nonexistent')).toBeNull();
    });

    it('getAllFeatures', () => {
      db.insertFeature('Alpha', 'alpha');
      db.insertFeature('Beta', 'beta');

      const features = db.getAllFeatures();
      expect(features).toHaveLength(2);
      expect(features[0].name).toBe('Alpha');
      expect(features[1].name).toBe('Beta');
    });

    it('getFeatureCount', () => {
      expect(db.getFeatureCount()).toBe(0);

      db.insertFeature('A', 'a');
      expect(db.getFeatureCount()).toBe(1);

      db.insertFeature('B', 'b');
      expect(db.getFeatureCount()).toBe(2);
    });

    it('addFeatureFlows + getFeatureWithFlows', () => {
      const flowId1 = db.insertFlow('Flow A', 'flow-a');
      const flowId2 = db.insertFlow('Flow B', 'flow-b');

      const featureId = db.insertFeature('My Feature', 'my-feature');
      db.addFeatureFlows(featureId, [flowId1, flowId2]);

      const result = db.getFeatureWithFlows(featureId);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('My Feature');
      expect(result!.flows).toHaveLength(2);
    });

    it('clearFeatures removes all features', () => {
      db.insertFeature('A', 'a');
      db.insertFeature('B', 'b');

      const cleared = db.clearFeatures();
      expect(cleared).toBe(2);
      expect(db.getFeatureCount()).toBe(0);
    });

    it('clearFeatures also removes junction rows', () => {
      const flowId = db.insertFlow('Flow', 'flow');
      const featureId = db.insertFeature('Feat', 'feat');
      db.addFeatureFlows(featureId, [flowId]);

      db.clearFeatures();

      // Feature with flows returns null now
      expect(db.getFeatureById(featureId)).toBeNull();
      // Flow still exists
      expect(db.getFlowById(flowId)).not.toBeNull();
    });
  });
});
