import { describe, expect, it } from 'vitest';
import { JourneyBuilder } from '../../../src/commands/llm/flows/journey-builder.js';
import type { FlowSuggestion } from '../../../src/commands/llm/flows/types.js';

function makeFlow(overrides: Partial<FlowSuggestion> = {}): FlowSuggestion {
  return {
    name: 'Test Flow',
    slug: 'test-flow',
    entryPointModuleId: 1,
    entryPointId: 10,
    entryPath: 'project.frontend.Home',
    stakeholder: 'user',
    description: 'Test description',
    interactionIds: [100],
    definitionSteps: [],
    inferredSteps: [],
    actionType: 'view',
    targetEntity: null,
    tier: 1,
    subflowSlugs: [],
    ...overrides,
  };
}

describe('JourneyBuilder', () => {
  const builder = new JourneyBuilder();

  describe('buildJourneys', () => {
    it('returns empty array when fewer than 2 tier-1 flows', () => {
      expect(builder.buildJourneys([])).toEqual([]);
      expect(builder.buildJourneys([makeFlow()])).toEqual([]);
    });

    it('returns empty when no flows share a grouping key', () => {
      const flows = [
        makeFlow({ slug: 'flow-a', targetEntity: null, entryPointModuleId: 1 }),
        makeFlow({ slug: 'flow-b', targetEntity: null, entryPointModuleId: 2 }),
      ];

      const result = builder.buildJourneys(flows);

      expect(result).toEqual([]);
    });

    describe('entity CRUD journeys', () => {
      it('groups flows with same targetEntity into a journey', () => {
        const flows = [
          makeFlow({
            slug: 'view-vehicle',
            name: 'View Vehicle',
            targetEntity: 'vehicle',
            actionType: 'view',
            entryPointModuleId: 1,
          }),
          makeFlow({
            slug: 'create-vehicle',
            name: 'Create Vehicle',
            targetEntity: 'vehicle',
            actionType: 'create',
            entryPointModuleId: 2,
          }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toHaveLength(1);
        expect(result[0].tier).toBe(2);
        expect(result[0].targetEntity).toBe('vehicle');
        expect(result[0].name).toContain('vehicle');
        expect(result[0].subflowSlugs).toContain('view-vehicle');
        expect(result[0].subflowSlugs).toContain('create-vehicle');
      });

      it('includes action types in journey name', () => {
        const flows = [
          makeFlow({ slug: 'view-item', targetEntity: 'item', actionType: 'view' }),
          makeFlow({ slug: 'create-item', targetEntity: 'item', actionType: 'create' }),
          makeFlow({ slug: 'delete-item', targetEntity: 'item', actionType: 'delete' }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toHaveLength(1);
        expect(result[0].name).toContain('item');
      });

      it('does not group when only one flow has a given targetEntity', () => {
        const flows = [
          makeFlow({ slug: 'view-vehicle', targetEntity: 'vehicle', entryPointModuleId: 1 }),
          makeFlow({ slug: 'create-user', targetEntity: 'user', entryPointModuleId: 2 }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toEqual([]);
      });

      it('groups are case-insensitive on targetEntity', () => {
        const flows = [
          makeFlow({ slug: 'view-vehicle', targetEntity: 'Vehicle' }),
          makeFlow({ slug: 'create-vehicle', targetEntity: 'vehicle' }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toHaveLength(1);
      });

      it('groups flows with -list and -detail suffixes into one journey', () => {
        const flows = [
          makeFlow({
            slug: 'view-vehicle-list',
            name: 'View Vehicle List',
            targetEntity: 'vehicle-list',
            actionType: 'view',
            entryPointModuleId: 1,
          }),
          makeFlow({
            slug: 'view-vehicle-detail',
            name: 'View Vehicle Detail',
            targetEntity: 'vehicle-detail',
            actionType: 'view',
            entryPointModuleId: 2,
          }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toHaveLength(1);
        expect(result[0].targetEntity).toBe('vehicle');
        expect(result[0].name).toContain('vehicle');
        expect(result[0].name).not.toContain('-list');
        expect(result[0].name).not.toContain('-detail');
        expect(result[0].subflowSlugs).toContain('view-vehicle-list');
        expect(result[0].subflowSlugs).toContain('view-vehicle-detail');
      });

      it('normalizes entity in journey targetEntity output', () => {
        const flows = [
          makeFlow({ slug: 'a', targetEntity: 'vehicle-list', actionType: 'view' }),
          makeFlow({ slug: 'b', targetEntity: 'vehicle-detail', actionType: 'update' }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toHaveLength(1);
        expect(result[0].targetEntity).toBe('vehicle');
      });

      it('plain entity values without suffix still group correctly', () => {
        const flows = [
          makeFlow({ slug: 'a', targetEntity: 'customer', actionType: 'view' }),
          makeFlow({ slug: 'b', targetEntity: 'customer', actionType: 'create' }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toHaveLength(1);
        expect(result[0].targetEntity).toBe('customer');
      });
    });

    describe('page journeys', () => {
      it('groups flows with same entryPointModuleId into a page journey', () => {
        const flows = [
          makeFlow({ slug: 'flow-a', entryPointModuleId: 42, targetEntity: null, actionType: 'view' }),
          makeFlow({ slug: 'flow-b', entryPointModuleId: 42, targetEntity: null, actionType: 'create' }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toHaveLength(1);
        expect(result[0].tier).toBe(2);
        expect(result[0].name).toContain('page journey');
      });

      it('does not create page journey for flows already in entity journeys', () => {
        // Both flows share targetEntity AND entryPointModuleId
        const flows = [
          makeFlow({ slug: 'view-item', entryPointModuleId: 42, targetEntity: 'item', actionType: 'view' }),
          makeFlow({ slug: 'create-item', entryPointModuleId: 42, targetEntity: 'item', actionType: 'create' }),
        ];

        const result = builder.buildJourneys(flows);

        // Should produce only 1 journey (entity), not 2 (entity + page)
        expect(result).toHaveLength(1);
        expect(result[0].name).toContain('item');
      });

      it('skips flows with null entryPointModuleId for page grouping', () => {
        const flows = [
          makeFlow({ slug: 'flow-a', entryPointModuleId: null, targetEntity: null }),
          makeFlow({ slug: 'flow-b', entryPointModuleId: null, targetEntity: null }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result).toEqual([]);
      });
    });

    describe('journey flow properties', () => {
      it('sets tier to 2', () => {
        const flows = [
          makeFlow({ slug: 'a', targetEntity: 'item', actionType: 'view', interactionIds: [1] }),
          makeFlow({ slug: 'b', targetEntity: 'item', actionType: 'create', interactionIds: [2] }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result[0].tier).toBe(2);
      });

      it('sets actionType to null (journeys encompass multiple actions)', () => {
        const flows = [
          makeFlow({ slug: 'a', targetEntity: 'item', actionType: 'view' }),
          makeFlow({ slug: 'b', targetEntity: 'item', actionType: 'create' }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result[0].actionType).toBeNull();
      });

      it('aggregates interactionIds from constituent flows (deduplicated)', () => {
        const flows = [
          makeFlow({ slug: 'a', targetEntity: 'item', interactionIds: [1, 2, 3] }),
          makeFlow({ slug: 'b', targetEntity: 'item', interactionIds: [3, 4, 5] }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result[0].interactionIds).toEqual([1, 2, 3, 4, 5]);
      });

      it('derives stakeholder from most common across constituent flows', () => {
        const flows = [
          makeFlow({ slug: 'a', targetEntity: 'item', stakeholder: 'admin' }),
          makeFlow({ slug: 'b', targetEntity: 'item', stakeholder: 'user' }),
          makeFlow({ slug: 'c', targetEntity: 'item', stakeholder: 'user' }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result[0].stakeholder).toBe('user');
      });

      it('generates a valid slug from journey name', () => {
        const flows = [
          makeFlow({ slug: 'a', targetEntity: 'item', actionType: 'view' }),
          makeFlow({ slug: 'b', targetEntity: 'item', actionType: 'create' }),
        ];

        const result = builder.buildJourneys(flows);

        expect(result[0].slug).toMatch(/^[a-z0-9-]+$/);
        expect(result[0].slug).not.toMatch(/^-|-$/);
      });

      it('deduplicates slugs with counter suffix', () => {
        // Create two groups that would produce the same journey name/slug
        const flows = [
          makeFlow({ slug: 'a', targetEntity: 'item', actionType: 'view', entryPointModuleId: 1 }),
          makeFlow({ slug: 'b', targetEntity: 'item', actionType: 'create', entryPointModuleId: 2 }),
          // A page group from remaining flows that might collide
          makeFlow({ slug: 'c', targetEntity: null, entryPointModuleId: 99, actionType: 'view' }),
          makeFlow({ slug: 'd', targetEntity: null, entryPointModuleId: 99, actionType: 'update' }),
        ];

        const result = builder.buildJourneys(flows);

        const slugs = result.map((r) => r.slug);
        const uniqueSlugs = new Set(slugs);
        expect(uniqueSlugs.size).toBe(slugs.length);
      });
    });
  });
});
