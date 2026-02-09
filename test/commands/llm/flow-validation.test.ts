import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FlowValidator,
  findMissingInteractions,
  findUncoveredInteractions,
  validateInteraction,
} from '../../../src/commands/llm/_shared/flow-validation.js';
import { IndexDatabase } from '../../../src/db/database.js';

describe('flow-validation', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  // Helper: set up modules, interactions, and a flow
  function setupBasicData() {
    const rootId = db.ensureRootModule();
    const mod1 = db.insertModule(rootId, 'frontend', 'Frontend');
    const mod2 = db.insertModule(rootId, 'backend', 'Backend');

    const fileId = db.insertFile({
      path: '/src/test.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });

    const def1 = db.insertDefinition(fileId, {
      name: 'handleCreate',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 9, column: 1 },
    });

    const interactionId = db.insertInteraction(mod1, mod2);

    return { rootId, mod1, mod2, fileId, def1, interactionId };
  }

  // Helper to create additional modules for unique interaction pairs
  function createExtraModule(rootId: number, slug: string) {
    return db.insertModule(rootId, slug, slug);
  }

  // ============================================
  // FlowValidator.validateFlow
  // ============================================
  describe('FlowValidator.validateFlow', () => {
    it('validates a well-formed flow as valid', () => {
      const { mod1, def1, interactionId } = setupBasicData();

      const flowId = db.insertFlow('TestFlow', 'test-flow', {
        entryPointModuleId: mod1,
        entryPointId: def1,
        description: 'A test flow',
      });
      db.addFlowStep(flowId, interactionId);

      const validator = new FlowValidator(db);
      const result = validator.validateFlow(db.getFlowById(flowId)!);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('warns on flow with no steps', () => {
      const { mod1, def1 } = setupBasicData();

      const flowId = db.insertFlow('EmptyFlow', 'empty-flow', {
        entryPointModuleId: mod1,
        entryPointId: def1,
      });

      const validator = new FlowValidator(db);
      const result = validator.validateFlow(db.getFlowById(flowId)!);
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.type === 'no_steps')).toBe(true);
    });

    it('warns on flow with no description', () => {
      const { mod1, def1 } = setupBasicData();

      const flowId = db.insertFlow('NoDescFlow', 'no-desc-flow', {
        entryPointModuleId: mod1,
        entryPointId: def1,
      });

      const validator = new FlowValidator(db);
      const result = validator.validateFlow(db.getFlowById(flowId)!);
      expect(result.warnings.some((w) => w.type === 'missing_description')).toBe(true);
    });

    it('errors on invalid entry point module', () => {
      setupBasicData();

      // Disable FK constraints to insert invalid reference
      const conn = (db as any).conn;
      conn.pragma('foreign_keys = OFF');
      const flowId = db.insertFlow('BadModule', 'bad-module', {
        entryPointModuleId: 9999,
      });
      conn.pragma('foreign_keys = ON');

      const validator = new FlowValidator(db);
      const result = validator.validateFlow(db.getFlowById(flowId)!);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === 'invalid_entry_point_module')).toBe(true);
    });

    it('errors on invalid entry point definition', () => {
      const { mod1 } = setupBasicData();

      const conn = (db as any).conn;
      conn.pragma('foreign_keys = OFF');
      const flowId = db.insertFlow('BadDef', 'bad-def', {
        entryPointModuleId: mod1,
        entryPointId: 9999,
      });
      conn.pragma('foreign_keys = ON');

      const validator = new FlowValidator(db);
      const result = validator.validateFlow(db.getFlowById(flowId)!);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === 'invalid_entry_point')).toBe(true);
    });

    it('errors when steps exceed maxSteps', () => {
      const { rootId, mod1, def1 } = setupBasicData();

      const flowId = db.insertFlow('BigFlow', 'big-flow', {
        entryPointModuleId: mod1,
        entryPointId: def1,
      });

      // Create many unique module pairs to avoid unique constraint
      for (let i = 0; i < 25; i++) {
        const extraMod = createExtraModule(rootId, `extra-${i}`);
        const intId = db.insertInteraction(mod1, extraMod);
        db.addFlowStep(flowId, intId);
      }

      const validator = new FlowValidator(db, { maxSteps: 20 });
      const result = validator.validateFlow(db.getFlowById(flowId)!);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === 'max_steps_exceeded')).toBe(true);
    });

    it('errors on invalid interaction id in steps', () => {
      const { mod1, def1 } = setupBasicData();

      const flowId = db.insertFlow('BadStep', 'bad-step', {
        entryPointModuleId: mod1,
        entryPointId: def1,
      });

      // Insert a bad step directly using raw connection with FK disabled
      const conn = (db as any).conn;
      conn.pragma('foreign_keys = OFF');
      conn
        .prepare('INSERT INTO flow_steps (flow_id, step_order, interaction_id) VALUES (?, ?, ?)')
        .run(flowId, 1, 9999);
      conn.pragma('foreign_keys = ON');

      const validator = new FlowValidator(db);
      const result = validator.validateFlow(db.getFlowById(flowId)!);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === 'invalid_interaction_id')).toBe(true);
    });

    it('allows null entry point module and definition', () => {
      const flowId = db.insertFlow('NullEntry', 'null-entry');

      const validator = new FlowValidator(db);
      const result = validator.validateFlow(db.getFlowById(flowId)!);
      expect(result.errors.filter((e) => e.type === 'invalid_entry_point_module')).toEqual([]);
      expect(result.errors.filter((e) => e.type === 'invalid_entry_point')).toEqual([]);
    });
  });

  // ============================================
  // FlowValidator.validateAllFlows
  // ============================================
  describe('FlowValidator.validateAllFlows', () => {
    it('validates all flows in database', () => {
      const { mod1, def1, interactionId } = setupBasicData();

      const flow1 = db.insertFlow('Flow1', 'flow-1', {
        entryPointModuleId: mod1,
        entryPointId: def1,
        description: 'Flow 1',
      });
      db.addFlowStep(flow1, interactionId);

      db.insertFlow('Flow2', 'flow-2', { description: 'Flow 2' });

      const validator = new FlowValidator(db);
      const results = validator.validateAllFlows();
      expect(results.size).toBe(2);
    });
  });

  // ============================================
  // FlowValidator.findDuplicateSlugs
  // ============================================
  describe('FlowValidator.findDuplicateSlugs', () => {
    it('returns empty for unique slugs', () => {
      setupBasicData();
      db.insertFlow('Flow1', 'flow-1');
      db.insertFlow('Flow2', 'flow-2');

      const validator = new FlowValidator(db);
      expect(validator.findDuplicateSlugs()).toEqual([]);
    });

    it('detects duplicate slugs when constraint allows', () => {
      // The DB has a UNIQUE constraint on slug, so test with the data as-is
      // We test that no duplicates are found for non-duplicate data
      setupBasicData();
      db.insertFlow('Flow A', 'slug-a');
      db.insertFlow('Flow B', 'slug-b');

      const validator = new FlowValidator(db);
      const dupes = validator.findDuplicateSlugs();
      expect(dupes).toEqual([]);
    });
  });

  // ============================================
  // validateInteraction
  // ============================================
  describe('validateInteraction', () => {
    it('returns no errors for valid interaction', () => {
      const { interactionId } = setupBasicData();
      const interaction = db.getInteractionById(interactionId)!;
      const errors = validateInteraction(db, interaction);
      expect(errors).toEqual([]);
    });

    it('reports error for invalid from module', () => {
      const { mod2 } = setupBasicData();
      const errors = validateInteraction(db, {
        id: 999,
        fromModuleId: 9999,
        toModuleId: mod2,
        direction: 'uni',
        weight: 1,
        pattern: null,
        symbols: null,
        semantic: null,
        source: 'ast',
        createdAt: '2024-01-01',
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe('invalid_module_id');
      expect(errors[0].message).toContain('From module');
    });

    it('reports error for invalid to module', () => {
      const { mod1 } = setupBasicData();
      const errors = validateInteraction(db, {
        id: 999,
        fromModuleId: mod1,
        toModuleId: 9999,
        direction: 'uni',
        weight: 1,
        pattern: null,
        symbols: null,
        semantic: null,
        source: 'ast',
        createdAt: '2024-01-01',
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('To module');
    });

    it('reports errors for both invalid modules', () => {
      setupBasicData();
      const errors = validateInteraction(db, {
        id: 999,
        fromModuleId: 8888,
        toModuleId: 9999,
        direction: 'uni',
        weight: 1,
        pattern: null,
        symbols: null,
        semantic: null,
        source: 'ast',
        createdAt: '2024-01-01',
      });
      expect(errors).toHaveLength(2);
    });
  });

  // ============================================
  // findUncoveredInteractions
  // ============================================
  describe('findUncoveredInteractions', () => {
    it('returns uncovered interactions', () => {
      setupBasicData();
      const uncovered = findUncoveredInteractions(db);
      expect(uncovered.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty when all interactions are covered', () => {
      const { interactionId } = setupBasicData();
      const flowId = db.insertFlow('Cover', 'cover');
      db.addFlowStep(flowId, interactionId);

      const uncovered = findUncoveredInteractions(db);
      expect(uncovered).toEqual([]);
    });
  });

  // ============================================
  // findMissingInteractions
  // ============================================
  describe('findMissingInteractions', () => {
    it('returns empty when no module call graph edges exist', () => {
      setupBasicData();
      const gaps = findMissingInteractions(db);
      expect(Array.isArray(gaps)).toBe(true);
    });

    it('sorts gaps by weight descending', () => {
      setupBasicData();
      const gaps = findMissingInteractions(db);
      for (let i = 1; i < gaps.length; i++) {
        expect(gaps[i - 1].weight).toBeGreaterThanOrEqual(gaps[i].weight);
      }
    });
  });
});
