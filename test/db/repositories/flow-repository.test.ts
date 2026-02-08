import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowRepository } from '../../../src/db/repositories/flow-repository.js';
import { InteractionRepository } from '../../../src/db/repositories/interaction-repository.js';
import { ModuleRepository } from '../../../src/db/repositories/module-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('FlowRepository', () => {
  let db: Database.Database;
  let repo: FlowRepository;
  let interactionRepo: InteractionRepository;
  let moduleRepo: ModuleRepository;
  let moduleId1: number;
  let moduleId2: number;
  let moduleId3: number;
  let interactionId1: number;
  let interactionId2: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new FlowRepository(db);
    interactionRepo = new InteractionRepository(db);
    moduleRepo = new ModuleRepository(db);

    // Set up modules for testing
    const rootId = moduleRepo.ensureRoot();
    moduleId1 = moduleRepo.insert(rootId, 'auth', 'Authentication');
    moduleId2 = moduleRepo.insert(rootId, 'api', 'API');
    moduleId3 = moduleRepo.insert(rootId, 'db', 'Database');

    // Set up interactions for testing
    interactionId1 = interactionRepo.insert(moduleId1, moduleId2, {
      weight: 5,
      pattern: 'business',
      symbols: ['authenticate', 'validate'],
      semantic: 'Auth module calls API',
    });
    interactionId2 = interactionRepo.insert(moduleId2, moduleId3, {
      weight: 3,
      pattern: 'business',
      symbols: ['query', 'save'],
      semantic: 'API calls Database',
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('insert', () => {
    it('inserts a new flow', () => {
      const flowId = repo.insert('Login Flow', 'login-flow', {
        entryPath: 'POST /api/login',
        stakeholder: 'user',
        description: 'User login process',
      });

      const flow = repo.getById(flowId);
      expect(flow).not.toBeNull();
      expect(flow!.name).toBe('Login Flow');
      expect(flow!.slug).toBe('login-flow');
      expect(flow!.entryPath).toBe('POST /api/login');
      expect(flow!.stakeholder).toBe('user');
      expect(flow!.description).toBe('User login process');
    });

    it('inserts flow with entry path', () => {
      const flowId = repo.insert('Login Flow', 'login-flow', {
        entryPath: 'POST /api/login',
        stakeholder: 'user',
      });

      const flow = repo.getById(flowId);
      expect(flow!.entryPath).toBe('POST /api/login');
      expect(flow!.entryPointId).toBeNull();
    });
  });

  describe('getById', () => {
    it('returns flow by ID', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');
      const flow = repo.getById(flowId);

      expect(flow).not.toBeNull();
      expect(flow!.name).toBe('Test Flow');
    });

    it('returns null for non-existent ID', () => {
      const flow = repo.getById(999);
      expect(flow).toBeNull();
    });
  });

  describe('getBySlug', () => {
    it('returns flow by slug', () => {
      repo.insert('Test Flow', 'test-flow');

      const flow = repo.getBySlug('test-flow');
      expect(flow).not.toBeNull();
      expect(flow!.name).toBe('Test Flow');
    });

    it('returns null for non-existent slug', () => {
      const flow = repo.getBySlug('nonexistent');
      expect(flow).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns all flows', () => {
      repo.insert('Flow 1', 'flow-1');
      repo.insert('Flow 2', 'flow-2');
      repo.insert('Flow 3', 'flow-3');

      const flows = repo.getAll();
      expect(flows).toHaveLength(3);
    });
  });

  describe('getByStakeholder', () => {
    it('returns flows by stakeholder type', () => {
      repo.insert('User Flow 1', 'user-flow-1', { stakeholder: 'user' });
      repo.insert('User Flow 2', 'user-flow-2', { stakeholder: 'user' });
      repo.insert('Admin Flow', 'admin-flow', { stakeholder: 'admin' });

      const userFlows = repo.getByStakeholder('user');
      expect(userFlows).toHaveLength(2);

      const adminFlows = repo.getByStakeholder('admin');
      expect(adminFlows).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('updates flow metadata', () => {
      const flowId = repo.insert('Original', 'original');

      const updated = repo.update(flowId, {
        name: 'Updated',
        description: 'New description',
        stakeholder: 'admin',
      });

      expect(updated).toBe(true);

      const flow = repo.getById(flowId);
      expect(flow!.name).toBe('Updated');
      expect(flow!.description).toBe('New description');
      expect(flow!.stakeholder).toBe('admin');
    });

    it('returns false for empty updates', () => {
      const flowId = repo.insert('Test', 'test');
      const updated = repo.update(flowId, {});
      expect(updated).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes a flow', () => {
      const flowId = repo.insert('To Delete', 'to-delete');

      const deleted = repo.delete(flowId);
      expect(deleted).toBe(true);
      expect(repo.getById(flowId)).toBeNull();
    });
  });

  describe('clear', () => {
    it('deletes all flows', () => {
      repo.insert('Flow 1', 'flow-1');
      repo.insert('Flow 2', 'flow-2');

      expect(repo.getCount()).toBe(2);

      const changes = repo.clear();
      expect(changes).toBe(2);
      expect(repo.getCount()).toBe(0);
    });
  });

  describe('getCount', () => {
    it('returns count of flows', () => {
      expect(repo.getCount()).toBe(0);

      repo.insert('Flow 1', 'flow-1');
      expect(repo.getCount()).toBe(1);

      repo.insert('Flow 2', 'flow-2');
      expect(repo.getCount()).toBe(2);
    });
  });

  describe('addStep', () => {
    it('adds a step to a flow', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');

      repo.addStep(flowId, interactionId1);
      repo.addStep(flowId, interactionId2);

      const steps = repo.getSteps(flowId);
      expect(steps).toHaveLength(2);
      expect(steps[0].stepOrder).toBe(1);
      expect(steps[0].interactionId).toBe(interactionId1);
      expect(steps[1].stepOrder).toBe(2);
      expect(steps[1].interactionId).toBe(interactionId2);
    });

    it('adds step with explicit stepOrder', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');

      repo.addStep(flowId, interactionId1, 5);

      const steps = repo.getSteps(flowId);
      expect(steps[0].stepOrder).toBe(5);
    });
  });

  describe('addSteps', () => {
    it('adds multiple steps in order', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');

      repo.addSteps(flowId, [interactionId1, interactionId2]);

      const steps = repo.getSteps(flowId);
      expect(steps).toHaveLength(2);
      expect(steps[0].interactionId).toBe(interactionId1);
      expect(steps[1].interactionId).toBe(interactionId2);
    });
  });

  describe('removeStep', () => {
    it('removes a step from a flow', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');
      repo.addSteps(flowId, [interactionId1, interactionId2]);

      const removed = repo.removeStep(flowId, 1);
      expect(removed).toBe(true);

      const steps = repo.getSteps(flowId);
      expect(steps).toHaveLength(1);
      expect(steps[0].interactionId).toBe(interactionId2);
    });
  });

  describe('clearSteps', () => {
    it('clears all steps from a flow', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');
      repo.addSteps(flowId, [interactionId1, interactionId2]);

      const cleared = repo.clearSteps(flowId);
      expect(cleared).toBe(2);

      const steps = repo.getSteps(flowId);
      expect(steps).toHaveLength(0);
    });
  });

  describe('reorderSteps', () => {
    it('reorders steps in a flow', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');
      repo.addSteps(flowId, [interactionId1, interactionId2]);

      // Reorder: swap the order
      repo.reorderSteps(flowId, [interactionId2, interactionId1]);

      const steps = repo.getSteps(flowId);
      expect(steps[0].interactionId).toBe(interactionId2);
      expect(steps[1].interactionId).toBe(interactionId1);
    });
  });

  describe('getWithSteps', () => {
    it('returns flow with interaction details', () => {
      const flowId = repo.insert('Login Flow', 'login-flow', {
        stakeholder: 'user',
      });
      repo.addSteps(flowId, [interactionId1, interactionId2]);

      const flowWithSteps = repo.getWithSteps(flowId);
      expect(flowWithSteps).not.toBeNull();
      expect(flowWithSteps!.name).toBe('Login Flow');
      expect(flowWithSteps!.steps).toHaveLength(2);

      const step1 = flowWithSteps!.steps[0];
      expect(step1.stepOrder).toBe(1);
      expect(step1.interaction.fromModulePath).toBe('project.auth');
      expect(step1.interaction.toModulePath).toBe('project.api');
      expect(step1.interaction.semantic).toBe('Auth module calls API');
    });

    it('returns null for non-existent flow', () => {
      const flowWithSteps = repo.getWithSteps(999);
      expect(flowWithSteps).toBeNull();
    });
  });

  describe('expand', () => {
    it('expands flow to ordered interactions', () => {
      const flowId = repo.insert('Login Flow', 'login-flow');
      repo.addSteps(flowId, [interactionId1, interactionId2]);

      const expanded = repo.expand(flowId);
      expect(expanded).not.toBeNull();
      expect(expanded!.flow.name).toBe('Login Flow');
      expect(expanded!.interactions).toHaveLength(2);
      expect(expanded!.interactions[0].fromModulePath).toBe('project.auth');
    });

    it('returns null for non-existent flow', () => {
      const expanded = repo.expand(999);
      expect(expanded).toBeNull();
    });
  });

  describe('getStats', () => {
    it('returns flow statistics', () => {
      repo.insert('User Flow', 'user-flow', { stakeholder: 'user' });
      repo.insert('Admin Flow', 'admin-flow', { stakeholder: 'admin' });
      const flowId = repo.insert('System Flow', 'system-flow', { stakeholder: 'system' });
      repo.addSteps(flowId, [interactionId1, interactionId2]);

      const stats = repo.getStats();

      expect(stats.flowCount).toBe(3);
      expect(stats.byStakeholder.user).toBe(1);
      expect(stats.byStakeholder.admin).toBe(1);
      expect(stats.byStakeholder.system).toBe(1);
    });
  });

  describe('getCoverage', () => {
    it('returns flow coverage statistics', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');
      repo.addStep(flowId, interactionId1);

      const coverage = repo.getCoverage();
      expect(coverage.totalInteractions).toBe(2);
      expect(coverage.coveredByFlows).toBe(1);
      expect(coverage.percentage).toBe(50);
    });
  });

  describe('getFlowsWithInteraction', () => {
    it('returns flows that use a specific interaction', () => {
      const flow1Id = repo.insert('Flow 1', 'flow-1');
      const flow2Id = repo.insert('Flow 2', 'flow-2');
      repo.addStep(flow1Id, interactionId1);
      repo.addStep(flow2Id, interactionId1);

      const flows = repo.getFlowsWithInteraction(interactionId1);
      expect(flows).toHaveLength(2);
    });
  });

  describe('getUncoveredInteractions', () => {
    it('returns interactions not in any flow', () => {
      const flowId = repo.insert('Test Flow', 'test-flow');
      repo.addStep(flowId, interactionId1);

      const uncovered = repo.getUncoveredInteractions();
      expect(uncovered).toHaveLength(1);
      expect(uncovered[0].id).toBe(interactionId2);
    });
  });
});
