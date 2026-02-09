import { describe, expect, it } from 'vitest';
import { AtomicFlowBuilder } from '../../../src/commands/llm/flows/atomic-flow-builder.js';
import type { InteractionWithPaths, Module } from '../../../src/db/schema.js';

function makeInteraction(
  overrides: Partial<InteractionWithPaths> & { id: number; fromModuleId: number; toModuleId: number }
): InteractionWithPaths {
  return {
    direction: 'uni',
    weight: 1,
    pattern: null,
    symbols: null,
    semantic: null,
    source: 'ast',
    createdAt: '2024-01-01',
    fromModulePath: `module-${overrides.fromModuleId}`,
    toModulePath: `module-${overrides.toModuleId}`,
    ...overrides,
  };
}

function makeModule(overrides: Partial<Module> & { id: number; fullPath: string }): Module {
  return {
    parentId: null,
    slug: overrides.fullPath.split('.').pop() ?? '',
    name: overrides.fullPath.split('.').pop() ?? '',
    description: null,
    depth: 1,
    colorIndex: 0,
    isTest: false,
    createdAt: '2024-01-01',
    ...overrides,
  };
}

describe('AtomicFlowBuilder', () => {
  const builder = new AtomicFlowBuilder();

  describe('buildAtomicFlows', () => {
    it('returns empty for no interactions', () => {
      const result = builder.buildAtomicFlows([], []);
      expect(result).toEqual([]);
    });

    it('filters out test-internal interactions', () => {
      const interactions = [makeInteraction({ id: 1, fromModuleId: 1, toModuleId: 2, pattern: 'test-internal' })];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.tests' }),
        makeModule({ id: 2, fullPath: 'project.utils' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      expect(result).toEqual([]);
    });

    it('creates atomic flows from simple interactions', () => {
      const interactions = [makeInteraction({ id: 1, fromModuleId: 1, toModuleId: 2 })];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.frontend.hooks' }),
        makeModule({ id: 2, fullPath: 'project.backend.api' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].tier).toBe(0);
      expect(result[0].subflowSlugs).toEqual([]);
      expect(result[0].interactionIds).toEqual([1]);
    });

    it('groups interactions by entity pair', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          fromModulePath: 'project.customer.hooks',
          toModulePath: 'project.customer.api',
        }),
        makeInteraction({
          id: 2,
          fromModuleId: 2,
          toModuleId: 3,
          fromModulePath: 'project.customer.api',
          toModulePath: 'project.customer.service',
        }),
        makeInteraction({
          id: 3,
          fromModuleId: 4,
          toModuleId: 5,
          fromModulePath: 'project.vehicle.hooks',
          toModulePath: 'project.vehicle.api',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.customer.hooks' }),
        makeModule({ id: 2, fullPath: 'project.customer.api' }),
        makeModule({ id: 3, fullPath: 'project.customer.service' }),
        makeModule({ id: 4, fullPath: 'project.vehicle.hooks' }),
        makeModule({ id: 5, fullPath: 'project.vehicle.api' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      // Should have at least 2 flows: customer chain + vehicle interaction
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('chains consecutive interactions (A→B, B→C becomes one chain)', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          fromModulePath: 'project.customer.hooks',
          toModulePath: 'project.customer.api',
        }),
        makeInteraction({
          id: 2,
          fromModuleId: 2,
          toModuleId: 3,
          fromModulePath: 'project.customer.api',
          toModulePath: 'project.customer.service',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.customer.hooks' }),
        makeModule({ id: 2, fullPath: 'project.customer.api' }),
        makeModule({ id: 3, fullPath: 'project.customer.service' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      // 2 interactions chained → should be in one atomic flow (≤3 interactions)
      expect(result).toHaveLength(1);
      expect(result[0].interactionIds).toEqual([1, 2]);
    });

    it('splits chains longer than 3 interactions', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          fromModulePath: 'project.customer.a',
          toModulePath: 'project.customer.b',
        }),
        makeInteraction({
          id: 2,
          fromModuleId: 2,
          toModuleId: 3,
          fromModulePath: 'project.customer.b',
          toModulePath: 'project.customer.c',
        }),
        makeInteraction({
          id: 3,
          fromModuleId: 3,
          toModuleId: 4,
          fromModulePath: 'project.customer.c',
          toModulePath: 'project.customer.d',
        }),
        makeInteraction({
          id: 4,
          fromModuleId: 4,
          toModuleId: 5,
          fromModulePath: 'project.customer.d',
          toModulePath: 'project.customer.e',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.customer.a' }),
        makeModule({ id: 2, fullPath: 'project.customer.b' }),
        makeModule({ id: 3, fullPath: 'project.customer.c' }),
        makeModule({ id: 4, fullPath: 'project.customer.d' }),
        makeModule({ id: 5, fullPath: 'project.customer.e' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      // 4 interactions → split into 2 segments (3 + 1)
      expect(result.length).toBe(2);
      expect(result[0].interactionIds).toEqual([1, 2, 3]);
      expect(result[1].interactionIds).toEqual([4]);
    });

    it('names flows from semantic annotations', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          semantic: 'fetches customer data from the API',
          fromModulePath: 'project.customer.hooks',
          toModulePath: 'project.customer.api',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.customer.hooks' }),
        makeModule({ id: 2, fullPath: 'project.customer.api' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      expect(result[0].name).toBe('fetches customer data from the api');
    });

    it('names flows from module paths when no semantic', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          fromModulePath: 'project.customer.hooks',
          toModulePath: 'project.customer.api',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.customer.hooks' }),
        makeModule({ id: 2, fullPath: 'project.customer.api' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      expect(result[0].name).toContain('hooks');
      expect(result[0].name).toContain('api');
    });

    it('handles generic modules (no entity match)', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          fromModulePath: 'project.shared.utils',
          toModulePath: 'project.shared.logger',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.shared.utils' }),
        makeModule({ id: 2, fullPath: 'project.shared.logger' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      expect(result).toHaveLength(1);
      expect(result[0].tier).toBe(0);
    });

    it('covers all interactions exactly once', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          fromModulePath: 'project.customer.hooks',
          toModulePath: 'project.customer.api',
        }),
        makeInteraction({
          id: 2,
          fromModuleId: 2,
          toModuleId: 3,
          fromModulePath: 'project.customer.api',
          toModulePath: 'project.customer.service',
        }),
        makeInteraction({
          id: 3,
          fromModuleId: 4,
          toModuleId: 5,
          fromModulePath: 'project.vehicle.hooks',
          toModulePath: 'project.vehicle.api',
        }),
        makeInteraction({
          id: 4,
          fromModuleId: 6,
          toModuleId: 7,
          fromModulePath: 'project.utils',
          toModulePath: 'project.logger',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.customer.hooks' }),
        makeModule({ id: 2, fullPath: 'project.customer.api' }),
        makeModule({ id: 3, fullPath: 'project.customer.service' }),
        makeModule({ id: 4, fullPath: 'project.vehicle.hooks' }),
        makeModule({ id: 5, fullPath: 'project.vehicle.api' }),
        makeModule({ id: 6, fullPath: 'project.utils' }),
        makeModule({ id: 7, fullPath: 'project.logger' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);

      // All interaction IDs should appear exactly once across all flows
      const allIds = result.flatMap((f) => f.interactionIds);
      expect(new Set(allIds).size).toBe(allIds.length);
      expect(allIds.sort()).toEqual([1, 2, 3, 4]);
    });

    it('sets stakeholder based on module path', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          fromModulePath: 'project.admin.panel',
          toModulePath: 'project.admin.api',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.admin.panel' }),
        makeModule({ id: 2, fullPath: 'project.admin.api' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      expect(result[0].stakeholder).toBe('admin');
    });

    it('produces unique slugs', () => {
      const interactions = [
        makeInteraction({
          id: 1,
          fromModuleId: 1,
          toModuleId: 2,
          fromModulePath: 'project.a',
          toModulePath: 'project.b',
        }),
        makeInteraction({
          id: 2,
          fromModuleId: 3,
          toModuleId: 4,
          fromModulePath: 'project.a2',
          toModulePath: 'project.b2',
        }),
      ];
      const modules = [
        makeModule({ id: 1, fullPath: 'project.a' }),
        makeModule({ id: 2, fullPath: 'project.b' }),
        makeModule({ id: 3, fullPath: 'project.a2' }),
        makeModule({ id: 4, fullPath: 'project.b2' }),
      ];
      const result = builder.buildAtomicFlows(interactions, modules);
      const slugs = result.map((f) => f.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });
  });
});
