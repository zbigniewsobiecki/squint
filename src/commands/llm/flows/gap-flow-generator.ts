/**
 * GapFlowGenerator - Creates flows for uncovered interactions.
 * Groups uncovered interactions by source module and creates internal flows.
 */

import type { InteractionWithPaths } from '../../../db/schema.js';
import type { FlowSuggestion } from './types.js';

export class GapFlowGenerator {
  /**
   * Create gap flows for interactions not covered by entry point flows.
   */
  createGapFlows(coveredIds: Set<number>, allInteractions: InteractionWithPaths[]): FlowSuggestion[] {
    const uncovered = allInteractions.filter((i) => !coveredIds.has(i.id));
    if (uncovered.length === 0) return [];

    // Group uncovered interactions by source module
    const bySource = new Map<number, InteractionWithPaths[]>();
    for (const i of uncovered) {
      const list = bySource.get(i.fromModuleId) ?? [];
      list.push(i);
      bySource.set(i.fromModuleId, list);
    }

    // Create "internal" flows for each cluster
    const gapFlows: FlowSuggestion[] = [];
    for (const [, interactions] of bySource) {
      const modulePath = interactions[0].fromModulePath;
      const shortName = modulePath.split('.').pop() ?? 'Module';

      // Convert to PascalCase for flow name
      const flowName = `${shortName.charAt(0).toUpperCase() + shortName.slice(1)}InternalFlow`;
      const slug = `${shortName.toLowerCase()}-internal`;

      gapFlows.push({
        name: flowName,
        slug: slug,
        entryPointModuleId: null,
        entryPointId: null,
        entryPath: `Internal: ${modulePath}`,
        stakeholder: 'developer', // Internal, not user-facing
        description: `Internal interactions originating from ${modulePath}`,
        interactionIds: interactions.map((i) => i.id),
        definitionSteps: [], // Gap flows don't have definition-level tracing
        inferredSteps: [], // Gap flows don't have inferred steps
        actionType: null,
        targetEntity: null,
        tier: 0,
        subflowSlugs: [],
      });
    }

    return gapFlows;
  }
}
