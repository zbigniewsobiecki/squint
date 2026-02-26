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
export function deduplicateByInteractionOverlap(flows: FlowSuggestion[], threshold = 0.5): FlowSuggestion[] {
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

      // Don't dedup flows that represent different user journeys
      // (different specific actionType+targetEntity combos)
      if (a.actionType && a.targetEntity && b.actionType && b.targetEntity) {
        const aKey = `${a.actionType}:${a.targetEntity}`;
        const bKey = `${b.actionType}:${b.targetEntity}`;
        if (aKey !== bKey) continue;
      }

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
 * Deduplicate flows that have the exact same set of interaction IDs.
 * When two flows share identical interaction sets, the lower-quality one is removed.
 */
export function deduplicateByInteractionSet(flows: FlowSuggestion[]): FlowSuggestion[] {
  const seen = new Map<string, number>(); // hash -> index of best flow

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    if (flow.interactionIds.length === 0) continue;

    const hash = [...flow.interactionIds].sort((a, b) => a - b).join(',');
    const existingIdx = seen.get(hash);

    if (existingIdx === undefined) {
      seen.set(hash, i);
    } else {
      // Keep the higher-quality flow
      const existing = flows[existingIdx];
      const dropIdx = pickFlowToDrop(existing, flow, existingIdx, i);
      if (dropIdx === existingIdx) {
        seen.set(hash, i);
      }
      // The dropped one will be filtered out below
    }
  }

  const keepIndices = new Set(seen.values());
  // Keep flows with no interactions (never entered into seen) and all winners from seen
  return flows.filter((f, i) => f.interactionIds.length === 0 || keepIndices.has(i));
}

/**
 * Given two overlapping flows, decide which to drop.
 * Prefer keeping: specific over catch-all > higher tier > more definitionSteps > fewer interactionIds (more focused) > earlier in array.
 */
export function pickFlowToDrop(a: FlowSuggestion, b: FlowSuggestion, idxA: number, idxB: number): number {
  // Specific flows (with actionType+targetEntity) beat catch-all flows (without)
  const aSpecific = !!(a.actionType && a.targetEntity);
  const bSpecific = !!(b.actionType && b.targetEntity);
  if (aSpecific !== bSpecific) return aSpecific ? idxB : idxA;

  // Higher tier wins
  if (a.tier !== b.tier) return a.tier > b.tier ? idxB : idxA;

  // More definition steps wins
  if (a.definitionSteps.length !== b.definitionSteps.length) {
    return a.definitionSteps.length > b.definitionSteps.length ? idxB : idxA;
  }

  // Fewer interaction IDs wins (more focused flow is better than catch-all)
  if (a.interactionIds.length !== b.interactionIds.length) {
    return a.interactionIds.length < b.interactionIds.length ? idxB : idxA;
  }

  // Earlier in array wins (drop the later one)
  return idxB;
}
