import { describe, expect, it } from 'vitest';
import { FeatureGrouper } from '../../../src/commands/llm/features/feature-grouper.js';
import type { Flow, Module } from '../../../src/db/schema.js';

const VALID_SLUGS = new Set([
  'user-views-customer',
  'user-creates-customer',
  'user-updates-customer',
  'user-deletes-customer',
  'user-views-vehicle',
  'user-creates-vehicle',
  'admin-views-dashboard',
  'internal-db-connection',
]);

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 1,
    name: 'User Views Customer',
    slug: 'user-views-customer',
    entryPointModuleId: null,
    entryPointId: null,
    entryPath: null,
    stakeholder: 'user',
    description: 'View customer details',
    actionType: 'view',
    targetEntity: 'customer',
    tier: 1,
    createdAt: '2024-01-01',
    ...overrides,
  };
}

function makeModule(overrides: Partial<Module> = {}): Module {
  return {
    id: 1,
    parentId: null,
    slug: 'project',
    fullPath: 'project',
    name: 'Project',
    description: null,
    depth: 0,
    colorIndex: 0,
    isTest: false,
    createdAt: '2024-01-01',
    ...overrides,
  };
}

function createGrouper() {
  const mockCommand = { log: () => {}, warn: () => {} } as any;
  return new FeatureGrouper(mockCommand, false);
}

describe('FeatureGrouper', () => {
  // ============================================
  // parseFeatureCSV — core parsing
  // ============================================
  describe('parseFeatureCSV', () => {
    it('parses valid CSV into FeatureSuggestion[]', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
customer-management,"Customer Management","CRUD operations for customer records","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer"
vehicle-management,"Vehicle Management","CRUD operations for vehicles","user-views-vehicle|user-creates-vehicle"
dashboard,"Dashboard & Reporting","Dashboard views","admin-views-dashboard"
infrastructure,"Internal Infrastructure","Internal plumbing","internal-db-connection"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors).toHaveLength(0);
      expect(result.features).toHaveLength(4);

      expect(result.features[0]).toEqual({
        slug: 'customer-management',
        name: 'Customer Management',
        description: 'CRUD operations for customer records',
        flowSlugs: ['user-views-customer', 'user-creates-customer', 'user-updates-customer', 'user-deletes-customer'],
      });

      expect(result.features[1].slug).toBe('vehicle-management');
      expect(result.features[1].flowSlugs).toHaveLength(2);

      expect(result.features[2].slug).toBe('dashboard');
      expect(result.features[2].flowSlugs).toEqual(['admin-views-dashboard']);

      expect(result.features[3].slug).toBe('infrastructure');
      expect(result.orphanedSlugs).toHaveLength(0);
    });

    it('handles pipe-delimited flow_slugs correctly', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
all-in-one,"All Features","Everything","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors).toHaveLength(0);
      expect(result.features).toHaveLength(1);
      expect(result.features[0].flowSlugs).toHaveLength(8);
    });

    it('handles single flow slug (no pipes)', () => {
      const slugs = new Set(['only-flow']);
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
solo,"Solo Feature","Single","only-flow"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, slugs);
      expect(result.errors).toHaveLength(0);
      expect(result.features[0].flowSlugs).toEqual(['only-flow']);
    });

    it('handles CSV with code fences', () => {
      const csv =
        '```csv\nfeature_slug,feature_name,feature_description,flow_slugs\nall,"All","Everything","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"\n```';

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors).toHaveLength(0);
      expect(result.features).toHaveLength(1);
    });

    it('handles CSV with bare code fences (no csv language tag)', () => {
      const csv =
        '```\nfeature_slug,feature_name,feature_description,flow_slugs\nall,"All","Everything","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"\n```';

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors).toHaveLength(0);
      expect(result.features).toHaveLength(1);
    });

    it('handles CSV without header row', () => {
      const csv = `all,"All","Everything","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors).toHaveLength(0);
      expect(result.features).toHaveLength(1);
      expect(result.features[0].slug).toBe('all');
    });

    it('skips blank lines in CSV', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs

customer-management,"Customer Management","CRUD","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer"

rest,"Rest","Everything else","user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"
`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);
      expect(result.errors).toHaveLength(0);
      expect(result.features).toHaveLength(2);
    });

    it('trims whitespace from slug, name, description, and flow slugs', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
  all  ,"  All Features  ","  Everything  "," user-views-customer | user-creates-customer | user-updates-customer | user-deletes-customer | user-views-vehicle | user-creates-vehicle | admin-views-dashboard | internal-db-connection "`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors).toHaveLength(0);
      expect(result.features[0].slug).toBe('all');
      expect(result.features[0].name).toBe('All Features');
      expect(result.features[0].description).toBe('Everything');
      expect(result.features[0].flowSlugs).toHaveLength(8);
      expect(result.features[0].flowSlugs[0]).toBe('user-views-customer');
    });
  });

  // ============================================
  // parseFeatureCSV — validation errors
  // ============================================
  describe('parseFeatureCSV validation', () => {
    it('filters hallucinated flow slugs but keeps feature with valid ones', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
customer-management,"Customer Management","CRUD","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-teleports-customer"
rest,"Rest","Everything else","user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      // Feature is kept with valid slugs only
      expect(result.features).toHaveLength(2);
      expect(result.features[0].flowSlugs).not.toContain('user-teleports-customer');
      expect(result.features[0].flowSlugs).toHaveLength(4);
      // Error notes the filtering
      expect(result.errors.some((e) => e.includes('Filtered 1 unknown flow slugs'))).toBe(true);
    });

    it('skips feature when all slugs are hallucinated', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
bad,"Bad","Bogus","fake-flow-a|fake-flow-b"
good,"Good","Real","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      // "bad" feature skipped (no valid slugs), "good" feature kept
      expect(result.features).toHaveLength(1);
      expect(result.features[0].slug).toBe('good');
      expect(result.errors.some((e) => e.includes('No valid flow slugs after filtering'))).toBe(true);
    });

    it('returns orphaned flows in orphanedSlugs (not as errors)', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
customer-management,"Customer Management","CRUD","user-views-customer|user-creates-customer"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      // Orphans are returned as orphanedSlugs, not errors
      expect(result.orphanedSlugs).toContain('user-updates-customer');
      expect(result.orphanedSlugs).toContain('user-deletes-customer');
      expect(result.orphanedSlugs).toContain('user-views-vehicle');
      expect(result.errors.some((e) => e.includes('Orphaned'))).toBe(false);
    });

    it('detects duplicate flow assignments across features', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
feature-a,"Feature A","A","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer"
feature-b,"Feature B","B","user-views-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('already assigned') && e.includes('user-views-customer'))).toBe(true);
    });

    it('returns error for empty CSV', () => {
      const result = FeatureGrouper.parseFeatureCSV('', VALID_SLUGS);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Empty CSV');
      expect(result.features).toHaveLength(0);
    });

    it('returns error for whitespace-only CSV', () => {
      const result = FeatureGrouper.parseFeatureCSV('   \n  \n  ', VALID_SLUGS);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.features).toHaveLength(0);
    });

    it('skips rows with insufficient columns', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
good,"Good Feature","Good description","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"
bad,"Missing columns"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.features).toHaveLength(1);
      expect(result.features[0].slug).toBe('good');
      expect(result.errors.some((e) => e.includes('Expected 4 columns'))).toBe(true);
    });

    it('errors when feature has empty slug', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
,"No Slug","desc","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors.some((e) => e.includes('Missing feature slug or name'))).toBe(true);
    });

    it('errors when feature has empty name', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
some-slug,,"desc","user-views-customer|user-creates-customer|user-updates-customer|user-deletes-customer|user-views-vehicle|user-creates-vehicle|admin-views-dashboard|internal-db-connection"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, VALID_SLUGS);

      expect(result.errors.some((e) => e.includes('Missing feature slug or name'))).toBe(true);
    });

    it('errors when feature has no flow slugs (empty pipe field)', () => {
      const slugs = new Set(['flow-a']);
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
empty,"Empty Feature","desc",""`;

      const result = FeatureGrouper.parseFeatureCSV(csv, slugs);

      expect(result.errors.some((e) => e.includes('No flow slugs assigned'))).toBe(true);
    });

    it('succeeds with exact 1:1 flow-to-feature assignment', () => {
      const slugs = new Set(['flow-a', 'flow-b']);
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
feat-a,"Feature A","A","flow-a"
feat-b,"Feature B","B","flow-b"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, slugs);

      expect(result.errors).toHaveLength(0);
      expect(result.features).toHaveLength(2);
    });

    it('handles zero valid flow slugs (empty set)', () => {
      const csv = `feature_slug,feature_name,feature_description,flow_slugs
feat,"Feature","desc","flow-a"`;

      const result = FeatureGrouper.parseFeatureCSV(csv, new Set());

      expect(result.errors.some((e) => e.includes('No valid flow slugs after filtering'))).toBe(true);
      expect(result.features).toHaveLength(0);
    });
  });

  // ============================================
  // buildUserPrompt
  // ============================================
  describe('buildUserPrompt', () => {
    it('includes flow metadata and module tree', () => {
      const grouper = createGrouper();

      const flows = [makeFlow()];
      const modules = [makeModule()];

      const prompt = grouper.buildUserPrompt(flows, modules);

      expect(prompt).toContain('user-views-customer');
      expect(prompt).toContain('action=view');
      expect(prompt).toContain('entity=customer');
      expect(prompt).toContain('stakeholder=user');
      expect(prompt).toContain('tier=1');
      expect(prompt).toContain('project');
      expect(prompt).toContain('## Flows (1 total, grouped by base entity)');
      expect(prompt).toContain('## Module Tree');
    });

    it('omits null optional fields', () => {
      const grouper = createGrouper();

      const flows = [
        makeFlow({
          actionType: null,
          targetEntity: null,
          stakeholder: null,
          description: null,
        }),
      ];
      const modules = [makeModule()];

      const prompt = grouper.buildUserPrompt(flows, modules);

      expect(prompt).not.toContain('action=');
      expect(prompt).not.toContain('entity=');
      expect(prompt).not.toContain('stakeholder=');
      expect(prompt).not.toContain('desc=');
      // slug and tier are always present
      expect(prompt).toContain('slug=user-views-customer');
      expect(prompt).toContain('tier=1');
    });

    it('shows correct flow count', () => {
      const grouper = createGrouper();

      const flows = [
        makeFlow({ id: 1, slug: 'flow-a' }),
        makeFlow({ id: 2, slug: 'flow-b' }),
        makeFlow({ id: 3, slug: 'flow-c' }),
      ];

      const prompt = grouper.buildUserPrompt(flows, []);

      expect(prompt).toContain('## Flows (3 total, grouped by base entity)');
    });

    it('renders module tree with depth-based indentation', () => {
      const grouper = createGrouper();

      const modules = [
        makeModule({ id: 1, slug: 'project', fullPath: 'project', depth: 0 }),
        makeModule({ id: 2, slug: 'auth', fullPath: 'project.auth', depth: 1 }),
        makeModule({ id: 3, slug: 'login', fullPath: 'project.auth.login', depth: 2 }),
        makeModule({ id: 4, slug: 'api', fullPath: 'project.api', depth: 1 }),
      ];

      const prompt = grouper.buildUserPrompt([], modules);

      // Check indentation: depth-0 no indent, depth-1 two spaces, depth-2 four spaces
      expect(prompt).toContain('project (project)');
      expect(prompt).toContain('  auth (project.auth)');
      expect(prompt).toContain('    login (project.auth.login)');
      expect(prompt).toContain('  api (project.api)');
    });

    it('sorts modules by fullPath', () => {
      const grouper = createGrouper();

      const modules = [
        makeModule({ id: 3, slug: 'zebra', fullPath: 'project.zebra', depth: 1 }),
        makeModule({ id: 1, slug: 'project', fullPath: 'project', depth: 0 }),
        makeModule({ id: 2, slug: 'alpha', fullPath: 'project.alpha', depth: 1 }),
      ];

      const prompt = grouper.buildUserPrompt([], modules);

      const lines = prompt.split('\n');
      const moduleLines = lines.filter((l) => l.includes('(project'));
      expect(moduleLines[0]).toContain('project (project)');
      expect(moduleLines[1]).toContain('alpha (project.alpha)');
      expect(moduleLines[2]).toContain('zebra (project.zebra)');
    });

    it('includes different tiers', () => {
      const grouper = createGrouper();

      const flows = [
        makeFlow({ id: 1, slug: 'atomic-flow', tier: 0, name: 'Internal Connection' }),
        makeFlow({ id: 2, slug: 'composite-flow', tier: 1, name: 'User Creates Customer' }),
      ];

      const prompt = grouper.buildUserPrompt(flows, []);

      expect(prompt).toContain('tier=0');
      expect(prompt).toContain('tier=1');
    });

    it('includes flow description in prompt', () => {
      const grouper = createGrouper();

      const flows = [makeFlow({ description: 'Handles the full customer creation workflow' })];

      const prompt = grouper.buildUserPrompt(flows, []);

      expect(prompt).toContain('desc="Handles the full customer creation workflow"');
    });

    it('handles empty modules list', () => {
      const grouper = createGrouper();

      const prompt = grouper.buildUserPrompt([makeFlow()], []);

      expect(prompt).toContain('## Module Tree');
      // Should not crash, just have empty tree
      expect(prompt).toContain('## Flows (1 total, grouped by base entity)');
    });

    it('handles empty flows list', () => {
      const grouper = createGrouper();

      const prompt = grouper.buildUserPrompt([], [makeModule()]);

      expect(prompt).toContain('## Flows (0 total, grouped by base entity)');
      expect(prompt).toContain('## Module Tree');
    });

    it('includes entryModule when flow has entryPointModuleId', () => {
      const grouper = createGrouper();

      const flows = [makeFlow({ entryPointModuleId: 2 })];
      const modules = [
        makeModule({ id: 1 }),
        makeModule({ id: 2, slug: 'frontend', fullPath: 'project.frontend', depth: 1, parentId: 1 }),
      ];

      const prompt = grouper.buildUserPrompt(flows, modules);

      expect(prompt).toContain('entryModule=project.frontend');
    });

    it('omits entryModule when flow has no entryPointModuleId', () => {
      const grouper = createGrouper();

      const flows = [makeFlow({ entryPointModuleId: null })];
      const modules = [makeModule()];

      const prompt = grouper.buildUserPrompt(flows, modules);

      expect(prompt).not.toContain('entryModule=');
    });

    it('groups flows by normalized base entity', () => {
      const grouper = createGrouper();

      const flows = [
        makeFlow({ id: 1, slug: 'view-vehicle', targetEntity: 'vehicle', actionType: 'view' }),
        makeFlow({ id: 2, slug: 'view-vehicle-list', targetEntity: 'vehicle-list', actionType: 'view' }),
        makeFlow({ id: 3, slug: 'view-vehicle-detail', targetEntity: 'vehicle-detail', actionType: 'view' }),
      ];

      const prompt = grouper.buildUserPrompt(flows, []);

      // All three should be under the same "vehicle" entity section
      expect(prompt).toContain('### Entity: vehicle');
      // Should NOT have separate sections for vehicle-list or vehicle-detail
      expect(prompt).not.toContain('### Entity: vehicle-list');
      expect(prompt).not.toContain('### Entity: vehicle-detail');
    });

    it('uses Other Flows header for flows with null targetEntity', () => {
      const grouper = createGrouper();

      const flows = [makeFlow({ targetEntity: null })];

      const prompt = grouper.buildUserPrompt(flows, []);

      expect(prompt).toContain('### Other Flows');
      expect(prompt).not.toContain('### Entity: unknown');
    });
  });
});
