/**
 * GapFlowGenerator - Creates flows for uncovered interactions.
 * Groups uncovered interactions by source module and creates internal flows.
 */

import type { InteractionWithPaths } from '../../../db/schema.js';
import type { FlowSuggestion } from './types.js';

export class GapFlowGenerator {
  /**
   * Create gap flows for interactions not covered by entry point flows.
   * Only considers runtime interactions (ast-import already filtered upstream).
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
    const usedSlugs = new Set<string>();

    for (const [, interactions] of bySource) {
      const fromPath = interactions[0].fromModulePath;
      const fromShort = fromPath.split('.').pop() ?? 'module';

      // Build a descriptive name from the from→to modules
      const targetNames = [...new Set(interactions.map((i) => i.toModulePath.split('.').pop() ?? '?'))];
      const targetSummary = targetNames.slice(0, 3).join(', ');
      const suffix = targetNames.length > 3 ? ` (+${targetNames.length - 3} more)` : '';

      const flowName = `${fromShort} calls ${targetSummary}${suffix}`;
      let slug = flowName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      // Deduplicate slugs
      if (usedSlugs.has(slug)) {
        let counter = 2;
        while (usedSlugs.has(`${slug}-${counter}`)) counter++;
        slug = `${slug}-${counter}`;
      }
      usedSlugs.add(slug);

      gapFlows.push({
        name: flowName,
        slug,
        entryPointModuleId: null,
        entryPointId: null,
        entryPath: `Internal: ${fromPath}`,
        stakeholder: 'system',
        description: `Internal interactions from ${fromShort} to ${targetSummary}${suffix}`,
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
