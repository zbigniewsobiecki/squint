/**
 * Interaction-overlap deduplication for flows.
 * Removes lower-quality flows when their interaction sets significantly overlap.
 */

import type { FlowSuggestion } from './types.js';

/**
 * Remove flows whose interaction sets overlap above the given threshold.
 * When two flows overlap, the lower-quality one (per `pickFlowToDrop`) is removed.
 *
 * Overlap ratio = |intersection| / min(|A|, |B|)
 */
export function deduplicateByInteractionOverlap(flows: FlowSuggestion[], threshold = 0.7): FlowSuggestion[] {
  const dropped = new Set<number>(); // indices into `flows`

  for (let i = 0; i < flows.length; i++) {
    if (dropped.has(i)) continue;
    const a = flows[i];
    if (a.interactionIds.length === 0) continue;
    const setA = new Set(a.interactionIds);

    for (let j = i + 1; j < flows.length; j++) {
      if (dropped.has(j)) continue;
      const b = flows[j];
      if (b.interactionIds.length === 0) continue;
      const setB = new Set(b.interactionIds);

      let intersectionSize = 0;
      const smaller = setA.size <= setB.size ? setA : setB;
      const larger = setA.size <= setB.size ? setB : setA;
      for (const id of smaller) {
        if (larger.has(id)) intersectionSize++;
      }

      const minSize = Math.min(setA.size, setB.size);
      const overlapRatio = intersectionSize / minSize;

      if (overlapRatio > threshold) {
        const dropIndex = pickFlowToDrop(a, b, i, j);
        dropped.add(dropIndex);
      }
    }
  }

  return flows.filter((_, idx) => !dropped.has(idx));
}

/**
 * Given two overlapping flows, decide which to drop.
 * Prefer keeping: higher tier > more definitionSteps > more interactionIds > earlier in array.
 */
export function pickFlowToDrop(a: FlowSuggestion, b: FlowSuggestion, idxA: number, idxB: number): number {
  // Higher tier wins
  if (a.tier !== b.tier) return a.tier > b.tier ? idxB : idxA;

  // More definition steps wins
  if (a.definitionSteps.length !== b.definitionSteps.length) {
    return a.definitionSteps.length > b.definitionSteps.length ? idxB : idxA;
  }

  // More interaction IDs wins
  if (a.interactionIds.length !== b.interactionIds.length) {
    return a.interactionIds.length > b.interactionIds.length ? idxB : idxA;
  }

  // Earlier in array wins (drop the later one)
  return idxB;
}
