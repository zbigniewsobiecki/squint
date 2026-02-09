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
