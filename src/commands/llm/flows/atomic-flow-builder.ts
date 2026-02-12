/**
 * AtomicFlowBuilder - Deterministic tier-0 flow builder.
 * Builds short atomic flows (1-3 interactions) from the interaction graph alone.
 * No LLM calls — purely structural.
 */

import type { InteractionWithPaths, Module } from '../../../db/schema.js';
import { isRuntimeInteraction } from '../../../db/schema.js';
import { groupModulesByEntity } from '../_shared/entity-utils.js';
import type { FlowSuggestion } from './types.js';

/**
 * Build a map from module ID to entity name using groupModulesByEntity.
 */
function buildModuleEntityMap(modules: Module[], moduleEntityOverrides?: Map<number, string>): Map<number, string> {
  const entityGroups = groupModulesByEntity(modules, moduleEntityOverrides);
  const map = new Map<number, string>();
  for (const [entity, mods] of entityGroups) {
    for (const mod of mods) {
      map.set(mod.id, entity);
    }
  }
  return map;
}

export class AtomicFlowBuilder {
  /**
   * Build tier-0 atomic flows from interactions and modules.
   * Each atomic flow has 1-3 interactions covering a small entity-scoped chain.
   */
  buildAtomicFlows(
    interactions: InteractionWithPaths[],
    modules: Module[],
    moduleEntityOverrides?: Map<number, string>
  ): FlowSuggestion[] {
    // Filter to runtime interactions only (excludes ast-import and test-internal)
    const relevant = interactions.filter(isRuntimeInteraction);
    if (relevant.length === 0) return [];

    const moduleEntityMap = buildModuleEntityMap(modules, moduleEntityOverrides);
    const moduleById = new Map(modules.map((m) => [m.id, m]));

    // Group interactions by entity pair
    const groups = this.groupByEntityPair(relevant, moduleEntityMap);

    // For each group, chain consecutive interactions and split into atomic flows
    const atomicFlows: FlowSuggestion[] = [];
    const usedSlugs = new Set<string>();

    for (const [groupKey, groupInteractions] of groups) {
      const chains = this.findChains(groupInteractions);
      for (const chain of chains) {
        const segments = this.splitChain(chain, 3);
        for (const segment of segments) {
          const flow = this.buildFlowFromSegment(segment, groupKey, moduleById, moduleEntityMap, usedSlugs);
          if (flow) {
            atomicFlows.push(flow);
          }
        }
      }
    }

    return atomicFlows;
  }

  /**
   * Group interactions by entity pair.
   * Key = sorted(fromEntity, toEntity) for bidirectional grouping.
   * Interactions between _generic modules get their own group per module pair.
   */
  private groupByEntityPair(
    interactions: InteractionWithPaths[],
    moduleEntityMap: Map<number, string>
  ): Map<string, InteractionWithPaths[]> {
    const groups = new Map<string, InteractionWithPaths[]>();

    for (const interaction of interactions) {
      const fromEntity = moduleEntityMap.get(interaction.fromModuleId) ?? '_generic';
      const toEntity = moduleEntityMap.get(interaction.toModuleId) ?? '_generic';

      let key: string;
      if (fromEntity === '_generic' && toEntity === '_generic') {
        // Both generic: group by specific module pair
        const ids = [interaction.fromModuleId, interaction.toModuleId].sort((a, b) => a - b);
        key = `_generic:${ids[0]}-${ids[1]}`;
      } else if (fromEntity === '_generic' || toEntity === '_generic') {
        // One generic, one entity: group under the entity
        const entity = fromEntity === '_generic' ? toEntity : fromEntity;
        key = `${entity}:_generic`;
      } else {
        // Both have entities: sort for bidirectional grouping
        const sorted = [fromEntity, toEntity].sort();
        key = `${sorted[0]}:${sorted[1]}`;
      }

      const list = groups.get(key) ?? [];
      list.push(interaction);
      groups.set(key, list);
    }

    return groups;
  }

  /**
   * Find connected chains within a group of interactions.
   * A chain is a sequence where one interaction's toModuleId matches the next's fromModuleId.
   */
  private findChains(interactions: InteractionWithPaths[]): InteractionWithPaths[][] {
    if (interactions.length === 0) return [];

    // Build adjacency: fromModuleId -> interactions originating from it
    const fromIndex = new Map<number, InteractionWithPaths[]>();
    for (const i of interactions) {
      const list = fromIndex.get(i.fromModuleId) ?? [];
      list.push(i);
      fromIndex.set(i.fromModuleId, list);
    }

    const used = new Set<number>(); // interaction IDs already in a chain
    const chains: InteractionWithPaths[][] = [];

    // Find chain starting points: interactions whose fromModule isn't a toModule of another in the group
    const toModules = new Set(interactions.map((i) => i.toModuleId));
    const startInteractions = interactions.filter((i) => !toModules.has(i.fromModuleId));

    // If no clear starts (cycle), just start from the first unused
    const starts = startInteractions.length > 0 ? startInteractions : [interactions[0]];

    for (const start of starts) {
      if (used.has(start.id)) continue;

      const chain: InteractionWithPaths[] = [start];
      used.add(start.id);

      // Follow the chain forward
      let currentToModule = start.toModuleId;
      while (true) {
        const nexts = fromIndex.get(currentToModule) ?? [];
        const next = nexts.find((n) => !used.has(n.id));
        if (!next) break;
        chain.push(next);
        used.add(next.id);
        currentToModule = next.toModuleId;
      }

      chains.push(chain);
    }

    // Pick up any remaining interactions not in a chain
    for (const i of interactions) {
      if (!used.has(i.id)) {
        chains.push([i]);
        used.add(i.id);
      }
    }

    return chains;
  }

  /**
   * Split a chain longer than maxLen into overlapping segments.
   * Each segment has at most maxLen interactions.
   */
  private splitChain(chain: InteractionWithPaths[], maxLen: number): InteractionWithPaths[][] {
    if (chain.length <= maxLen) return [chain];

    const segments: InteractionWithPaths[][] = [];
    for (let i = 0; i < chain.length; i += maxLen) {
      segments.push(chain.slice(i, i + maxLen));
    }
    return segments;
  }

  /**
   * Build a FlowSuggestion from a segment of interactions.
   */
  private buildFlowFromSegment(
    segment: InteractionWithPaths[],
    _groupKey: string,
    moduleById: Map<number, Module>,
    moduleEntityMap: Map<number, string>,
    usedSlugs: Set<string>
  ): FlowSuggestion | null {
    if (segment.length === 0) return null;

    const name = this.generateAtomicName(segment, moduleById, moduleEntityMap);
    let slug = name
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

    const firstInteraction = segment[0];
    const fromModule = moduleById.get(firstInteraction.fromModuleId);
    const fromEntity = moduleEntityMap.get(firstInteraction.fromModuleId) ?? '_generic';

    return {
      name,
      slug,
      entryPointModuleId: firstInteraction.fromModuleId,
      entryPointId: null,
      entryPath: fromModule?.fullPath ?? '',
      stakeholder: 'system',
      description: this.generateAtomicDescription(segment),
      interactionIds: segment.map((i) => i.id),
      definitionSteps: [],
      inferredSteps: [],
      actionType: null,
      targetEntity: fromEntity !== '_generic' ? fromEntity.toLowerCase() : null,
      tier: 0,
      subflowSlugs: [],
    };
  }

  /**
   * Generate a name for an atomic flow from its interactions.
   */
  private generateAtomicName(
    segment: InteractionWithPaths[],
    moduleById: Map<number, Module>,
    moduleEntityMap: Map<number, string>
  ): string {
    // Try using semantic annotation from the first interaction
    const firstSemantic = segment[0].semantic;
    if (firstSemantic && firstSemantic.length > 5) {
      // Clean up and use as name
      const clean = firstSemantic
        .replace(/^(the |this )/i, '')
        .replace(/[.!]$/, '')
        .toLowerCase()
        .slice(0, 60);
      return clean;
    }

    // Fall back to module names: "hooks → api"
    const fromMod = moduleById.get(segment[0].fromModuleId);
    const toMod = moduleById.get(segment[segment.length - 1].toModuleId);
    const fromName = this.shortModuleName(fromMod);
    const toName = this.shortModuleName(toMod);

    // Add entity prefix if available
    const fromEntity = moduleEntityMap.get(segment[0].fromModuleId) ?? '_generic';
    const toEntity = moduleEntityMap.get(segment[segment.length - 1].toModuleId) ?? '_generic';
    const entity =
      fromEntity !== '_generic' ? fromEntity.toLowerCase() : toEntity !== '_generic' ? toEntity.toLowerCase() : null;

    if (entity) {
      return `${entity} ${fromName} calls ${toName}`;
    }

    return `${fromName} calls ${toName}`;
  }

  /**
   * Generate a description for an atomic flow.
   */
  private generateAtomicDescription(segment: InteractionWithPaths[]): string {
    const parts = segment.map((i) => {
      const from = i.fromModulePath.split('.').pop() ?? '?';
      const to = i.toModulePath.split('.').pop() ?? '?';
      return `${from} → ${to}${i.semantic ? ` (${i.semantic})` : ''}`;
    });
    return parts.join(', ');
  }

  /**
   * Get short module name from module.
   */
  private shortModuleName(mod: Module | undefined): string {
    if (!mod) return '?';
    return mod.fullPath.split('.').pop() ?? mod.name;
  }
}
