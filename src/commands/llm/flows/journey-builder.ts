/**
 * JourneyBuilder - Creates tier 2 (journey) flows by composing related tier 1 flows.
 *
 * Grouping strategies:
 * 1. Entity CRUD journeys: tier 1 flows sharing the same targetEntity
 * 2. Page journeys: tier 1 flows sharing the same entryPointModuleId
 *
 * Each journey must have 2+ constituent tier 1 flows.
 */

import type { FlowSuggestion } from './types.js';

function toSlug(name: string): string {
  const lower = name.toLowerCase();
  let result = '';
  for (const char of lower) {
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      result += char;
    } else if (result.length > 0 && !result.endsWith('-')) {
      result += '-';
    }
  }
  while (result.startsWith('-')) result = result.slice(1);
  while (result.endsWith('-')) result = result.slice(0, -1);
  return result || 'unnamed-journey';
}

interface JourneyGroup {
  key: string;
  name: string;
  description: string;
  flows: FlowSuggestion[];
}

export class JourneyBuilder {
  /**
   * Build tier 2 journey flows from tier 1 composite flows.
   */
  buildJourneys(tier1Flows: FlowSuggestion[]): FlowSuggestion[] {
    if (tier1Flows.length < 2) return [];

    const groups: JourneyGroup[] = [];
    const usedFlowSlugs = new Set<string>();

    // Strategy 1: Entity CRUD journeys — group by targetEntity
    const entityGroups = this.groupByEntity(tier1Flows);
    for (const group of entityGroups) {
      groups.push(group);
      for (const f of group.flows) usedFlowSlugs.add(f.slug);
    }

    // Strategy 2: Page journeys — group by entryPointModuleId (only flows not already in entity journeys)
    const remaining = tier1Flows.filter((f) => !usedFlowSlugs.has(f.slug));
    const pageGroups = this.groupByEntryPoint(remaining);
    groups.push(...pageGroups);

    // Convert groups to FlowSuggestions
    const journeyFlows: FlowSuggestion[] = [];
    const usedSlugs = new Set<string>();

    for (const group of groups) {
      const flow = this.buildJourneyFlow(group, usedSlugs);
      if (flow) journeyFlows.push(flow);
    }

    return journeyFlows;
  }

  private normalizeEntity(entity: string): string {
    const lower = entity.toLowerCase();
    if (lower.endsWith('-list')) return lower.slice(0, -5);
    if (lower.endsWith('-detail')) return lower.slice(0, -7);
    return lower;
  }

  private groupByEntity(flows: FlowSuggestion[]): JourneyGroup[] {
    const byEntity = new Map<string, FlowSuggestion[]>();

    for (const flow of flows) {
      if (!flow.targetEntity) continue;
      const entity = this.normalizeEntity(flow.targetEntity);
      const list = byEntity.get(entity) ?? [];
      list.push(flow);
      byEntity.set(entity, list);
    }

    const groups: JourneyGroup[] = [];
    for (const [entity, entityFlows] of byEntity) {
      if (entityFlows.length < 2) continue;

      // Derive action summary
      const actions = [...new Set(entityFlows.map((f) => f.actionType).filter(Boolean))];
      const actionSummary = actions.length > 0 ? actions.join('/') : 'management';

      groups.push({
        key: `entity:${entity}`,
        name: `${entity} ${actionSummary} journey`,
        description: `Complete ${entity} lifecycle: ${actions.join(', ') || 'various operations'}`,
        flows: entityFlows,
      });
    }

    return groups;
  }

  private groupByEntryPoint(flows: FlowSuggestion[]): JourneyGroup[] {
    const byModule = new Map<number, FlowSuggestion[]>();

    for (const flow of flows) {
      if (flow.entryPointModuleId === null) continue;
      const list = byModule.get(flow.entryPointModuleId) ?? [];
      list.push(flow);
      byModule.set(flow.entryPointModuleId, list);
    }

    const groups: JourneyGroup[] = [];
    for (const [, moduleFlows] of byModule) {
      if (moduleFlows.length < 2) continue;

      // Use the entry path from the first flow for naming
      const entryPath = moduleFlows[0].entryPath;
      const shortName = entryPath.split('.').pop() ?? entryPath.split('/').pop() ?? 'page';

      groups.push({
        key: `page:${moduleFlows[0].entryPointModuleId}`,
        name: `${shortName} page journey`,
        description: `User actions on ${shortName}: ${moduleFlows.map((f) => f.actionType ?? f.name).join(', ')}`,
        flows: moduleFlows,
      });
    }

    return groups;
  }

  private buildJourneyFlow(group: JourneyGroup, usedSlugs: Set<string>): FlowSuggestion | null {
    let slug = toSlug(group.name);

    if (usedSlugs.has(slug)) {
      let counter = 2;
      while (usedSlugs.has(`${slug}-${counter}`)) counter++;
      slug = `${slug}-${counter}`;
    }
    usedSlugs.add(slug);

    // Deduplicate constituent flows by slug (a flow may appear in multiple grouping paths)
    const seenSlugs = new Set<string>();
    const uniqueFlows: FlowSuggestion[] = [];
    for (const f of group.flows) {
      if (!seenSlugs.has(f.slug)) {
        seenSlugs.add(f.slug);
        uniqueFlows.push(f);
      }
    }

    // Aggregate interaction IDs from constituent flows (deduplicated)
    const allInteractionIds = [...new Set(uniqueFlows.flatMap((f) => f.interactionIds))];

    // Collect definition steps from all constituent flows
    const allDefinitionSteps = uniqueFlows.flatMap((f) => f.definitionSteps);

    // Use the first flow's entry point info
    const primaryFlow = uniqueFlows[0];

    // Derive stakeholder from constituent flows (most common)
    const stakeholderCounts = new Map<string, number>();
    for (const f of uniqueFlows) {
      stakeholderCounts.set(f.stakeholder, (stakeholderCounts.get(f.stakeholder) ?? 0) + 1);
    }
    let bestStakeholder = primaryFlow.stakeholder;
    let bestCount = 0;
    for (const [s, c] of stakeholderCounts) {
      if (c > bestCount) {
        bestStakeholder = s as FlowSuggestion['stakeholder'];
        bestCount = c;
      }
    }

    return {
      name: group.name,
      slug,
      entryPointModuleId: primaryFlow.entryPointModuleId,
      entryPointId: primaryFlow.entryPointId,
      entryPath: primaryFlow.entryPath,
      stakeholder: bestStakeholder,
      description: group.description,
      interactionIds: allInteractionIds,
      definitionSteps: allDefinitionSteps,
      actionType: null, // Journeys encompass multiple action types
      targetEntity: primaryFlow.targetEntity ? this.normalizeEntity(primaryFlow.targetEntity) : null,
      tier: 2,
      subflowSlugs: uniqueFlows.map((f) => f.slug),
    };
  }
}
