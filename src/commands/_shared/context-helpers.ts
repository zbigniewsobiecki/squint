import type { IndexDatabase } from '../../db/database-facade.js';
import type { Flow, Module } from '../../db/schema.js';

/**
 * Format a module result from getDefinitionModule() into a simple reference object.
 * Returns null if no module is assigned.
 */
export function formatModuleRef(
  moduleResult: { module: Module } | null
): { id: number; name: string; fullPath: string } | null {
  if (!moduleResult) return null;
  return { id: moduleResult.module.id, name: moduleResult.module.name, fullPath: moduleResult.module.fullPath };
}

/**
 * Collect and deduplicate features across multiple flows.
 * Returns sorted by name.
 */
export function collectFeaturesForFlows(
  flows: Array<{ id: number }>,
  db: IndexDatabase
): Array<{ id: number; name: string; slug: string }> {
  const featureMap = new Map<number, { id: number; name: string; slug: string }>();
  for (const f of flows) {
    const flowFeatures = db.features.getFeaturesForFlow(f.id);
    for (const feat of flowFeatures) {
      featureMap.set(feat.id, { id: feat.id, name: feat.name, slug: feat.slug });
    }
  }
  return Array.from(featureMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a set of module IDs into enriched module reference objects.
 * Returns sorted by fullPath.
 */
export function resolveModuleIds(
  moduleIds: Set<number>,
  db: IndexDatabase
): Array<{ id: number; name: string; fullPath: string }> {
  const result: Array<{ id: number; name: string; fullPath: string }> = [];
  for (const moduleId of moduleIds) {
    const mod = db.modules.getById(moduleId);
    if (mod) {
      result.push({ id: mod.id, name: mod.name, fullPath: mod.fullPath });
    }
  }
  return result.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

/**
 * Collect unique module IDs from flow steps.
 */
export function collectModuleIdsFromSteps(
  steps: Array<{ interaction: { fromModuleId: number; toModuleId: number } }>
): Set<number> {
  const moduleIds = new Set<number>();
  for (const step of steps) {
    moduleIds.add(step.interaction.fromModuleId);
    moduleIds.add(step.interaction.toModuleId);
  }
  return moduleIds;
}

/**
 * Collect unique flows from a list of interaction IDs (deduplicated).
 * Returns sorted by name.
 */
export function collectFlowsForInteractions(interactionIds: number[], db: IndexDatabase): Flow[] {
  const flowMap = new Map<number, Flow>();
  for (const interactionId of interactionIds) {
    const interactionFlows = db.flows.getFlowsWithInteraction(interactionId);
    for (const f of interactionFlows) {
      flowMap.set(f.id, f);
    }
  }
  return Array.from(flowMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
