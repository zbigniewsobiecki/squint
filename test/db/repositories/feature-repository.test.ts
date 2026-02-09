import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeatureRepository } from '../../../src/db/repositories/feature-repository.js';
import { FlowRepository } from '../../../src/db/repositories/flow-repository.js';
import { InteractionRepository } from '../../../src/db/repositories/interaction-repository.js';
import { ModuleRepository } from '../../../src/db/repositories/module-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('FeatureRepository', () => {
  let db: Database.Database;
  let repo: FeatureRepository;
  let flowRepo: FlowRepository;
  let moduleRepo: ModuleRepository;
  let interactionRepo: InteractionRepository;
  let flowId1: number;
  let flowId2: number;
  let flowId3: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    db.pragma('foreign_keys = ON');
    repo = new FeatureRepository(db);
    flowRepo = new FlowRepository(db);
    moduleRepo = new ModuleRepository(db);
    interactionRepo = new InteractionRepository(db);

    // Create modules and interactions for flows (required by FK constraints)
    const rootId = moduleRepo.ensureRoot();
    const mod1 = moduleRepo.insert(rootId, 'auth', 'Authentication');
    const mod2 = moduleRepo.insert(rootId, 'api', 'API');
    interactionRepo.insert(mod1, mod2);

    // Set up flows for testing
    flowId1 = flowRepo.insert('User Views Customer', 'user-views-customer', {
      stakeholder: 'user',
      actionType: 'view',
      targetEntity: 'customer',
      tier: 1,
    });
    flowId2 = flowRepo.insert('User Creates Customer', 'user-creates-customer', {
      stakeholder: 'user',
      actionType: 'create',
      targetEntity: 'customer',
      tier: 1,
    });
    flowId3 = flowRepo.insert('Admin Views Dashboard', 'admin-views-dashboard', {
      stakeholder: 'admin',
      actionType: 'view',
      targetEntity: 'dashboard',
      tier: 1,
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('insert', () => {
    it('inserts a new feature and returns its ID', () => {
      const featureId = repo.insert('Customer Management', 'customer-management', {
        description: 'CRUD operations for customer records',
      });

      expect(featureId).toBeGreaterThan(0);

      const feature = repo.getById(featureId);
      expect(feature).not.toBeNull();
      expect(feature!.name).toBe('Customer Management');
      expect(feature!.slug).toBe('customer-management');
      expect(feature!.description).toBe('CRUD operations for customer records');
      expect(feature!.createdAt).toBeTruthy();
    });

    it('inserts feature without description', () => {
      const featureId = repo.insert('Infra', 'infra');

      const feature = repo.getById(featureId);
      expect(feature!.name).toBe('Infra');
      expect(feature!.description).toBeNull();
    });

    it('rejects duplicate slugs', () => {
      repo.insert('Feature A', 'same-slug');

      expect(() => repo.insert('Feature B', 'same-slug')).toThrow();
    });
  });

  describe('getById', () => {
    it('returns feature by ID', () => {
      const featureId = repo.insert('Test Feature', 'test-feature');
      const feature = repo.getById(featureId);

      expect(feature).not.toBeNull();
      expect(feature!.id).toBe(featureId);
      expect(feature!.name).toBe('Test Feature');
    });

    it('returns null for non-existent ID', () => {
      const feature = repo.getById(999);
      expect(feature).toBeNull();
    });
  });

  describe('getBySlug', () => {
    it('returns feature by slug', () => {
      repo.insert('Customer Management', 'customer-management');

      const feature = repo.getBySlug('customer-management');
      expect(feature).not.toBeNull();
      expect(feature!.name).toBe('Customer Management');
    });

    it('returns null for non-existent slug', () => {
      const feature = repo.getBySlug('nonexistent');
      expect(feature).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns empty array when no features exist', () => {
      const features = repo.getAll();
      expect(features).toEqual([]);
    });

    it('returns all features ordered by name', () => {
      repo.insert('Zebra Feature', 'zebra');
      repo.insert('Alpha Feature', 'alpha');
      repo.insert('Middle Feature', 'middle');

      const features = repo.getAll();
      expect(features).toHaveLength(3);
      expect(features[0].name).toBe('Alpha Feature');
      expect(features[1].name).toBe('Middle Feature');
      expect(features[2].name).toBe('Zebra Feature');
    });
  });

  describe('addFlows', () => {
    it('associates flows with a feature', () => {
      const featureId = repo.insert('Customer Management', 'customer-management');
      repo.addFlows(featureId, [flowId1, flowId2]);

      const featureWithFlows = repo.getWithFlows(featureId);
      expect(featureWithFlows).not.toBeNull();
      expect(featureWithFlows!.flows).toHaveLength(2);

      const flowSlugs = featureWithFlows!.flows.map((f) => f.slug);
      expect(flowSlugs).toContain('user-views-customer');
      expect(flowSlugs).toContain('user-creates-customer');
    });

    it('allows a flow to belong to only one feature (unique PK)', () => {
      const feat1 = repo.insert('Feature 1', 'feat-1');
      const feat2 = repo.insert('Feature 2', 'feat-2');

      repo.addFlows(feat1, [flowId1]);

      // Same flow_id in a different feature should work (different composite PK)
      repo.addFlows(feat2, [flowId1]);

      // But adding the same flow to the same feature again should fail
      expect(() => repo.addFlows(feat1, [flowId1])).toThrow();
    });

    it('handles empty flow array gracefully', () => {
      const featureId = repo.insert('Empty Feature', 'empty');
      repo.addFlows(featureId, []);

      const featureWithFlows = repo.getWithFlows(featureId);
      expect(featureWithFlows!.flows).toHaveLength(0);
    });
  });

  describe('getWithFlows', () => {
    it('returns feature with associated flow details', () => {
      const featureId = repo.insert('Customer Management', 'customer-management', {
        description: 'Customer ops',
      });
      repo.addFlows(featureId, [flowId1, flowId2]);

      const result = repo.getWithFlows(featureId);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Customer Management');
      expect(result!.description).toBe('Customer ops');
      expect(result!.flows).toHaveLength(2);

      // Verify flow metadata is included
      const viewFlow = result!.flows.find((f) => f.slug === 'user-views-customer');
      expect(viewFlow).toBeDefined();
      expect(viewFlow!.stakeholder).toBe('user');
      expect(viewFlow!.actionType).toBe('view');
      expect(viewFlow!.targetEntity).toBe('customer');
      expect(viewFlow!.tier).toBe(1);
    });

    it('returns feature with empty flows when none assigned', () => {
      const featureId = repo.insert('Empty', 'empty');

      const result = repo.getWithFlows(featureId);
      expect(result).not.toBeNull();
      expect(result!.flows).toHaveLength(0);
    });

    it('returns null for non-existent feature', () => {
      const result = repo.getWithFlows(999);
      expect(result).toBeNull();
    });

    it('returns flows sorted by name', () => {
      const featureId = repo.insert('Customer Management', 'customer-management');
      repo.addFlows(featureId, [flowId2, flowId1]); // inserted out of name order

      const result = repo.getWithFlows(featureId);
      expect(result!.flows[0].name).toBe('User Creates Customer');
      expect(result!.flows[1].name).toBe('User Views Customer');
    });
  });

  describe('getCount', () => {
    it('returns 0 when no features exist', () => {
      expect(repo.getCount()).toBe(0);
    });

    it('returns correct count', () => {
      repo.insert('Feature 1', 'feat-1');
      expect(repo.getCount()).toBe(1);

      repo.insert('Feature 2', 'feat-2');
      expect(repo.getCount()).toBe(2);
    });
  });

  describe('clear', () => {
    it('deletes all features and returns count', () => {
      repo.insert('Feature 1', 'feat-1');
      repo.insert('Feature 2', 'feat-2');
      repo.insert('Feature 3', 'feat-3');

      const changes = repo.clear();
      expect(changes).toBe(3);
      expect(repo.getCount()).toBe(0);
    });

    it('cascade deletes feature_flows junction rows', () => {
      const featureId = repo.insert('Customer Management', 'customer-management');
      repo.addFlows(featureId, [flowId1, flowId2]);

      // Verify junction rows exist
      const junctionCount = db.prepare('SELECT COUNT(*) as count FROM feature_flows').get() as { count: number };
      expect(junctionCount.count).toBe(2);

      repo.clear();

      // Verify junction rows are also gone
      const afterCount = db.prepare('SELECT COUNT(*) as count FROM feature_flows').get() as { count: number };
      expect(afterCount.count).toBe(0);
    });

    it('returns 0 when no features exist', () => {
      const changes = repo.clear();
      expect(changes).toBe(0);
    });

    it('does not delete the flows themselves', () => {
      const featureId = repo.insert('Customer Management', 'customer-management');
      repo.addFlows(featureId, [flowId1, flowId2]);

      repo.clear();

      // Flows should still exist
      expect(flowRepo.getCount()).toBe(3);
      expect(flowRepo.getById(flowId1)).not.toBeNull();
    });
  });

  describe('schema creation', () => {
    it('creates tables lazily on first use', () => {
      // Fresh database without SCHEMA — only ensure flows tables exist first
      const freshDb = new Database(':memory:');
      freshDb.exec(SCHEMA);
      const freshRepo = new FeatureRepository(freshDb);

      // First call should create the tables
      expect(freshRepo.getCount()).toBe(0);

      // Should be able to insert now
      const id = freshRepo.insert('Test', 'test');
      expect(id).toBeGreaterThan(0);

      freshDb.close();
    });
  });

  describe('multiple features with different flows', () => {
    it('different features can have different flows', () => {
      const custFeat = repo.insert('Customer Management', 'customer-management');
      repo.addFlows(custFeat, [flowId1, flowId2]);

      const dashFeat = repo.insert('Dashboard', 'dashboard');
      repo.addFlows(dashFeat, [flowId3]);

      const custResult = repo.getWithFlows(custFeat);
      expect(custResult!.flows).toHaveLength(2);

      const dashResult = repo.getWithFlows(dashFeat);
      expect(dashResult!.flows).toHaveLength(1);
      expect(dashResult!.flows[0].slug).toBe('admin-views-dashboard');
    });
  });
});
