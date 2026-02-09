import { describe, expect, it } from 'vitest';
import { deduplicateByInteractionOverlap } from '../../../src/commands/llm/flows/dedup.js';
import type { FlowSuggestion } from '../../../src/commands/llm/flows/types.js';
import type { TracedDefinitionStep } from '../../../src/commands/llm/flows/types.js';

function makeFlow(
  overrides: Partial<FlowSuggestion> & { interactionIds: number[] }
): FlowSuggestion {
  return {
    name: 'test-flow',
    slug: `flow-${Math.random().toString(36).slice(2, 8)}`,
    entryPointModuleId: null,
    entryPointId: null,
    entryPath: '',
    stakeholder: 'user',
    description: '',
    definitionSteps: [],
    inferredSteps: [],
    actionType: null,
    targetEntity: null,
    tier: 0,
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
    const a = makeFlow({ interactionIds: [1, 2, 3], tier: 0 });
    const b = makeFlow({ interactionIds: [1, 2, 3, 4, 5], tier: 1 });

    const result = deduplicateByInteractionOverlap([a, b]);
    expect(result).toHaveLength(1);
    // B has higher tier, so A should be dropped
    expect(result[0]).toBe(b);
  });

  it('keeps flows below threshold', () => {
    const a = makeFlow({ interactionIds: [1, 2, 3, 4, 5] });
    const b = makeFlow({ interactionIds: [1, 6, 7, 8, 9] });

    const result = deduplicateByInteractionOverlap([a, b]);
    // 1/5 = 0.2, below 0.7 threshold
    expect(result).toHaveLength(2);
  });

  it('prefers higher tier', () => {
    const a = makeFlow({ interactionIds: [1, 2, 3], tier: 1 });
    const b = makeFlow({ interactionIds: [1, 2, 3], tier: 0 });

    const result = deduplicateByInteractionOverlap([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
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
});
