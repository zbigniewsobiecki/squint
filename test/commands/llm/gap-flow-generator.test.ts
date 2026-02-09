import { describe, expect, it } from 'vitest';
import { GapFlowGenerator } from '../../../src/commands/llm/flows/gap-flow-generator.js';
import type { InteractionWithPaths } from '../../../src/db/schema.js';

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

describe('GapFlowGenerator', () => {
  describe('createGapFlows', () => {
    it('returns empty when all interactions are covered', () => {
      const gen = new GapFlowGenerator();
      const interactions = [makeInteraction({ id: 1, fromModuleId: 1, toModuleId: 2 })];
      const covered = new Set([1]);
      const gaps = gen.createGapFlows(covered, interactions);
      expect(gaps).toEqual([]);
    });

    it('returns empty when no interactions exist', () => {
      const gen = new GapFlowGenerator();
      const gaps = gen.createGapFlows(new Set(), []);
      expect(gaps).toEqual([]);
    });

    it('creates gap flows for uncovered interactions grouped by source module', () => {
      const gen = new GapFlowGenerator();
      const interactions = [
        makeInteraction({ id: 1, fromModuleId: 10, toModuleId: 20, fromModulePath: 'project.services' }),
        makeInteraction({ id: 2, fromModuleId: 10, toModuleId: 30, fromModulePath: 'project.services' }),
        makeInteraction({ id: 3, fromModuleId: 20, toModuleId: 30, fromModulePath: 'project.api' }),
      ];

      const gaps = gen.createGapFlows(new Set(), interactions);
      expect(gaps).toHaveLength(2);
    });

    it('sets correct properties on gap flows', () => {
      const gen = new GapFlowGenerator();
      const interactions = [
        makeInteraction({ id: 1, fromModuleId: 10, toModuleId: 20, fromModulePath: 'project.services' }),
      ];

      const gaps = gen.createGapFlows(new Set(), interactions);
      expect(gaps).toHaveLength(1);

      const flow = gaps[0];
      expect(flow.entryPointModuleId).toBeNull();
      expect(flow.entryPointId).toBeNull();
      expect(flow.stakeholder).toBe('developer');
      expect(flow.definitionSteps).toEqual([]);
      expect(flow.inferredSteps).toEqual([]);
      expect(flow.actionType).toBeNull();
      expect(flow.targetEntity).toBeNull();
      expect(flow.tier).toBe(0);
      expect(flow.subflowSlugs).toEqual([]);
      expect(flow.interactionIds).toEqual([1]);
    });

    it('generates name and slug from module path', () => {
      const gen = new GapFlowGenerator();
      const interactions = [
        makeInteraction({ id: 1, fromModuleId: 10, toModuleId: 20, fromModulePath: 'project.services' }),
      ];

      const gaps = gen.createGapFlows(new Set(), interactions);
      expect(gaps[0].name).toBe('ServicesInternalFlow');
      expect(gaps[0].slug).toBe('services-internal');
    });

    it('excludes covered interactions from gap flows', () => {
      const gen = new GapFlowGenerator();
      const interactions = [
        makeInteraction({ id: 1, fromModuleId: 10, toModuleId: 20, fromModulePath: 'project.a' }),
        makeInteraction({ id: 2, fromModuleId: 10, toModuleId: 30, fromModulePath: 'project.a' }),
      ];

      const gaps = gen.createGapFlows(new Set([1]), interactions);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].interactionIds).toEqual([2]);
    });

    it('includes description with module path', () => {
      const gen = new GapFlowGenerator();
      const interactions = [
        makeInteraction({ id: 1, fromModuleId: 10, toModuleId: 20, fromModulePath: 'project.utils' }),
      ];

      const gaps = gen.createGapFlows(new Set(), interactions);
      expect(gaps[0].description).toContain('project.utils');
      expect(gaps[0].entryPath).toContain('project.utils');
    });
  });
});
