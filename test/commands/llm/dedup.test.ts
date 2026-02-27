import { describe, expect, it } from 'vitest';
import {
  deduplicateByInteractionOverlap,
  deduplicateByInteractionSet,
  pickFlowToDrop,
} from '../../../src/commands/llm/flows/dedup.js';
import type { FlowSuggestion, TracedDefinitionStep } from '../../../src/commands/llm/flows/types.js';

function makeFlow(overrides: Partial<FlowSuggestion> & { interactionIds: number[] }): FlowSuggestion {
  return {
    name: 'test-flow',
    slug: `flow-${Math.random().toString(36).slice(2, 8)}`,
    entryPointModuleId: null,
    entryPointId: null,
    entryPath: '',
    stakeholder: 'user',
    description: '',
    definitionSteps: [],
    actionType: null,
    targetEntity: null,
    tier: 1,
    subflowSlugs: [],
    ...overrides,
  };
}

function makeSteps(count: number): TracedDefinitionStep[] {
  return Array.from({ length: count }, (_, i) => ({
    fromDefinitionId: i,
    toDefinitionId: i + 1,
    fromModuleId: i,
    toModuleId: i + 1,
  }));
}

describe('deduplicateByInteractionOverlap', () => {
  it('drops fully subsumed flow', () => {
    const a = makeFlow({ interactionIds: [1, 2, 3], tier: 1, definitionSteps: [] });
    const b = makeFlow({ interactionIds: [1, 2, 3, 4, 5], tier: 1, definitionSteps: makeSteps(2) });

    const result = deduplicateByInteractionOverlap([a, b]);
    expect(result).toHaveLength(1);
    // B has more definition steps, so A should be dropped
    expect(result[0]).toBe(b);
  });

  it('keeps flows below threshold', () => {
    const a = makeFlow({ interactionIds: [1, 2, 3, 4, 5] });
    const b = makeFlow({ interactionIds: [1, 6, 7, 8, 9] });

    const result = deduplicateByInteractionOverlap([a, b]);
    // 1/5 = 0.2, below 0.5 threshold
    expect(result).toHaveLength(2);
  });

  it('skips comparison across different tiers', () => {
    const a = makeFlow({ interactionIds: [1, 2, 3], tier: 1 });
    const b = makeFlow({ interactionIds: [1, 2, 3], tier: 2 });

    const result = deduplicateByInteractionOverlap([a, b]);
    // Both survive because cross-tier comparisons are skipped
    expect(result).toHaveLength(2);
  });

  it('prefers more definition steps at same tier', () => {
    const a = makeFlow({ interactionIds: [1, 2, 3], tier: 1, definitionSteps: makeSteps(2) });
    const b = makeFlow({ interactionIds: [1, 2, 3], tier: 1, definitionSteps: [] });

    const result = deduplicateByInteractionOverlap([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
  });

  it('skips flows with empty interactionIds', () => {
    const a = makeFlow({ interactionIds: [] });
    const b = makeFlow({ interactionIds: [1, 2, 3] });
    const c = makeFlow({ interactionIds: [] });

    const result = deduplicateByInteractionOverlap([a, b, c]);
    expect(result).toHaveLength(3);
  });

  it('no-op when no overlap', () => {
    const a = makeFlow({ interactionIds: [1, 2, 3] });
    const b = makeFlow({ interactionIds: [4, 5, 6] });
    const c = makeFlow({ interactionIds: [7, 8, 9] });

    const result = deduplicateByInteractionOverlap([a, b, c]);
    expect(result).toHaveLength(3);
  });

  it('keeps flows with different actionType+targetEntity despite high overlap', () => {
    const createCustomer = makeFlow({
      interactionIds: [1, 2, 3, 4, 5],
      actionType: 'create',
      targetEntity: 'customer',
      tier: 1,
    });
    const updateCustomer = makeFlow({
      interactionIds: [1, 2, 3, 4, 6],
      actionType: 'update',
      targetEntity: 'customer',
      tier: 1,
    });
    const deleteCustomer = makeFlow({
      interactionIds: [1, 2, 3, 7],
      actionType: 'delete',
      targetEntity: 'customer',
      tier: 1,
    });

    // 4/4 overlap between create and delete = 1.0, but different actionType
    const result = deduplicateByInteractionOverlap([createCustomer, updateCustomer, deleteCustomer]);
    expect(result).toHaveLength(3);
  });

  it('drops catch-all flow when it overlaps a specific flow', () => {
    const catchAll = makeFlow({
      interactionIds: [1, 2, 3, 4, 5, 6, 7, 8],
      actionType: null,
      targetEntity: null,
      tier: 1,
    });
    const specific = makeFlow({
      interactionIds: [1, 2, 3, 4, 5],
      actionType: 'create',
      targetEntity: 'customer',
      tier: 1,
    });

    // 5/5 = 1.0 overlap ratio, specific flow should survive
    const result = deduplicateByInteractionOverlap([catchAll, specific]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(specific);
  });

  it('prefers more focused flow (fewer interactions) at same tier and steps', () => {
    const broad = makeFlow({ interactionIds: [1, 2, 3, 4, 5, 6, 7, 8] });
    const focused = makeFlow({ interactionIds: [1, 2, 3] });

    // 3/3 = 1.0 overlap, focused (fewer interactions) should win
    const result = deduplicateByInteractionOverlap([broad, focused]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(focused);
  });
});

describe('pickFlowToDrop', () => {
  it('keeps specific flow over catch-all', () => {
    const specific = makeFlow({ interactionIds: [1, 2], actionType: 'create', targetEntity: 'customer' });
    const catchAll = makeFlow({ interactionIds: [1, 2, 3, 4] });

    // specific at idx 0, catchAll at idx 1 → should drop catchAll (idx 1)
    expect(pickFlowToDrop(specific, catchAll, 0, 1)).toBe(1);
    // reversed order → should drop catchAll (idx 0)
    expect(pickFlowToDrop(catchAll, specific, 0, 1)).toBe(0);
  });

  it('keeps fewer interactions (more focused) when all else equal', () => {
    const focused = makeFlow({ interactionIds: [1, 2, 3] });
    const broad = makeFlow({ interactionIds: [1, 2, 3, 4, 5, 6, 7] });

    // focused at idx 0, broad at idx 1 → should drop broad (idx 1)
    expect(pickFlowToDrop(focused, broad, 0, 1)).toBe(1);
  });

  it('prefers higher tier when comparing directly', () => {
    const tier1 = makeFlow({ interactionIds: [1, 2, 3], tier: 1 });
    const tier2 = makeFlow({ interactionIds: [1, 2, 3], tier: 2 });

    // tier2 at idx 1 should survive, tier1 at idx 0 should be dropped
    expect(pickFlowToDrop(tier1, tier2, 0, 1)).toBe(0);
    expect(pickFlowToDrop(tier2, tier1, 0, 1)).toBe(1);
  });
});

describe('deduplicateByInteractionSet', () => {
  it('keeps flows with same IDs but different actionType+targetEntity', () => {
    const viewVehicle = makeFlow({
      interactionIds: [1, 2, 3],
      actionType: 'view',
      targetEntity: 'vehicle',
      tier: 1,
    });
    const createVehicle = makeFlow({
      interactionIds: [1, 2, 3],
      actionType: 'create',
      targetEntity: 'vehicle',
      tier: 1,
    });

    const result = deduplicateByInteractionSet([viewVehicle, createVehicle]);
    expect(result).toHaveLength(2);
  });

  it('keeps tier-2 journey alongside tier-1 flow with same IDs', () => {
    const tier1 = makeFlow({
      interactionIds: [1, 2, 3],
      actionType: 'view',
      targetEntity: 'vehicle',
      tier: 1,
    });
    const tier2 = makeFlow({
      interactionIds: [1, 2, 3],
      actionType: 'view',
      targetEntity: 'vehicle',
      tier: 2,
    });

    const result = deduplicateByInteractionSet([tier1, tier2]);
    expect(result).toHaveLength(2);
  });

  it('still deduplicates true duplicates (same tier+action+entity+IDs)', () => {
    const a = makeFlow({
      interactionIds: [1, 2, 3],
      actionType: 'view',
      targetEntity: 'vehicle',
      tier: 1,
    });
    const b = makeFlow({
      interactionIds: [1, 2, 3],
      actionType: 'view',
      targetEntity: 'vehicle',
      tier: 1,
    });

    const result = deduplicateByInteractionSet([a, b]);
    expect(result).toHaveLength(1);
  });
});

describe('deduplicateByInteractionOverlap — tier guard', () => {
  it('preserves tier-2 journey even when fully overlapping tier-1', () => {
    const tier1 = makeFlow({
      interactionIds: [1, 2, 3],
      tier: 1,
      actionType: 'view',
      targetEntity: 'vehicle',
    });
    const tier2Journey = makeFlow({
      interactionIds: [1, 2, 3, 4, 5],
      tier: 2,
      actionType: null,
      targetEntity: null,
    });

    const result = deduplicateByInteractionOverlap([tier1, tier2Journey]);
    // Both survive because cross-tier comparisons are skipped
    expect(result).toHaveLength(2);
  });
});
