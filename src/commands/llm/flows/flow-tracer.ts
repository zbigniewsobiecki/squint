/**
 * FlowTracer - Definition-level call graph traversal.
 * Traces composite tier-1 flows from entry point definitions through the call graph,
 * mapping interactions to atomic subflow references.
 */

import type { FlowStakeholder, InteractionDefinitionLink, InteractionWithPaths } from '../../../db/schema.js';
import type {
  ActionType,
  EntryPointModuleInfo,
  FlowSuggestion,
  FlowTracingContext,
  InferredFlowStep,
  TracedDefinitionStep,
} from './types.js';

export class FlowTracer {
  private readonly maxDepth = 15;

  constructor(private readonly context: FlowTracingContext) {}

  /**
   * Trace composite tier-1 flows from entry point modules.
   * Maps definition-derived interactions to atomic subflow references.
   */
  traceFlowsFromEntryPoints(
    entryPointModules: EntryPointModuleInfo[],
    atomicFlows: FlowSuggestion[]
  ): FlowSuggestion[] {
    // Build interaction-to-atomic-flow lookup
    const interactionToAtomic = new Map<number, FlowSuggestion>();
    for (const atomic of atomicFlows) {
      for (const iId of atomic.interactionIds) {
        if (!interactionToAtomic.has(iId)) {
          interactionToAtomic.set(iId, atomic);
        }
      }
    }

    const flowSuggestions: FlowSuggestion[] = [];

    for (const entryPointModule of entryPointModules) {
      for (const member of entryPointModule.memberDefinitions) {
        let traceStartDefId = member.id;
        let initialStep: TracedDefinitionStep | null = null;

        // If the LLM specified a trace-from hook, resolve it to a definition ID
        if (member.traceFromDefinition) {
          const callees = this.context.definitionCallGraph.get(member.id) ?? [];
          for (const calleeId of callees) {
            const calleeName = this.context.defIdToName.get(calleeId);
            if (calleeName === member.traceFromDefinition) {
              const fromModule = this.context.defToModule.get(member.id);
              const toModule = this.context.defToModule.get(calleeId);
              if (fromModule && toModule && fromModule.moduleId !== toModule.moduleId) {
                initialStep = {
                  fromDefinitionId: member.id,
                  toDefinitionId: calleeId,
                  fromModuleId: fromModule.moduleId,
                  toModuleId: toModule.moduleId,
                };
              }
              traceStartDefId = calleeId;
              break;
            }
          }
        }

        // View actions always trace from the page definition itself.
        // The full component render tree (JSX children, hooks) must be followed.
        // traceFromDefinition is only meaningful for mutation actions.
        if (member.actionType === 'view') {
          traceStartDefId = member.id;
          initialStep = null;
        }

        const { definitionSteps, inferredSteps } = this.traceDefinitionFlow(traceStartDefId, entryPointModule.moduleId);
        if (initialStep) {
          definitionSteps.unshift(initialStep);
        }
        const derivedInteractionIds = this.deriveInteractionIds(definitionSteps);

        // Map interactions to subflow references
        const subflowSlugs: string[] = [];
        const seen = new Set<string>();
        for (const iId of derivedInteractionIds) {
          const atomic = interactionToAtomic.get(iId);
          if (atomic && !seen.has(atomic.slug)) {
            seen.add(atomic.slug);
            subflowSlugs.push(atomic.slug);
          }
        }

        if (definitionSteps.length > 0 || derivedInteractionIds.length > 0) {
          flowSuggestions.push({
            name: this.generateFlowNameFromModule(entryPointModule, member),
            slug: this.generateFlowSlugFromModule(entryPointModule, member),
            entryPointModuleId: entryPointModule.moduleId,
            entryPointId: member.id,
            entryPath: `${entryPointModule.modulePath}.${member.name}`,
            stakeholder: member.stakeholder ?? 'user',
            description: `Flow starting from ${member.name} in ${entryPointModule.modulePath}`,
            interactionIds: derivedInteractionIds,
            definitionSteps,
            inferredSteps,
            actionType: member.actionType,
            targetEntity: member.targetEntity,
            tier: 1,
            subflowSlugs,
          });
        }
      }
    }

    return flowSuggestions;
  }

  /**
   * Trace a flow from a starting definition through the definition-level call graph.
   * At leaf nodes (no outgoing call graph edges), bridges via LLM-inferred interactions.
   */
  private traceDefinitionFlow(
    startDefinitionId: number,
    currentEntryPointModuleId: number
  ): {
    definitionSteps: TracedDefinitionStep[];
    inferredSteps: InferredFlowStep[];
  } {
    const visited = new Set<number>();
    const visitedBridgeModules = new Set<number>();
    const steps: TracedDefinitionStep[] = [];
    const inferredSteps: InferredFlowStep[] = [];

    const trace = (
      defId: number,
      depth: number,
      lastKnownModule: { moduleId: number; modulePath: string } | null,
      isBridged = false
    ): void => {
      if (depth >= this.maxDepth) return;
      if (visited.has(defId)) return;
      visited.add(defId);

      // When a definition was reached via a module-level fallback bridge
      // (imprecise — picks a representative def from the target module),
      // don't follow its call-graph edges. The target subsystem is explored
      // by its own entry-point flows.
      // Definition-level bridges (contract-matched, precise per-function targeting)
      // DO continue into the backend call graph to produce e2e flows.
      if (isBridged) return;

      // Definition-level bridges: precise per-definition targeting.
      // Check BEFORE call graph traversal — if this definition has bridges,
      // they capture the cross-boundary semantics (e.g. vehiclesService → VehiclesController).
      // Don't follow call graph edges further, which would reach a shared leaf
      // (e.g. api/axios) that bridges to a different target (e.g. authController).
      const currentModule = this.context.defToModule.get(defId) ?? lastKnownModule;
      const defBridges = this.context.definitionBridgeMap.get(defId);
      if (defBridges && defBridges.length > 0 && currentModule) {
        for (const bridge of defBridges) {
          steps.push({
            fromDefinitionId: defId,
            toDefinitionId: bridge.toDefinitionId,
            fromModuleId: currentModule.moduleId,
            toModuleId: bridge.toModuleId,
          });

          inferredSteps.push({
            fromModuleId: currentModule.moduleId,
            toModuleId: bridge.toModuleId,
            source: bridge.source,
          });

          // Continue tracing from the bridge target into the backend call graph.
          // Definition-level bridges are precise (specific function targets), so
          // expansion is safe and produces true end-to-end flows.
          // Module-level fallback bridges (line ~248) pass isBridged=true to stop.
          const targetModule = this.context.defToModule.get(bridge.toDefinitionId) ?? null;
          trace(bridge.toDefinitionId, depth + 1, targetModule, false);
        }
        return; // Bridge captures this definition's cross-boundary intent
      }

      const calledDefs = this.context.definitionCallGraph.get(defId) ?? [];
      for (const calledDefId of calledDefs) {
        const fromModule = this.context.defToModule.get(defId) ?? lastKnownModule;
        const toModule = this.context.defToModule.get(calledDefId);

        // Only include cross-module calls
        if (fromModule && toModule && fromModule.moduleId !== toModule.moduleId) {
          steps.push({
            fromDefinitionId: defId,
            toDefinitionId: calledDefId,
            fromModuleId: fromModule.moduleId,
            toModuleId: toModule.moduleId,
          });

          // If the target module is ANOTHER entry point, don't expand it.
          // Its own flows trace its internals. Treat like a bridge boundary.
          if (
            toModule.moduleId !== currentEntryPointModuleId &&
            this.context.entryPointModuleIds.has(toModule.moduleId) &&
            this.context.boundaryTargetModuleIds.has(toModule.moduleId)
          ) {
            continue;
          }
        }

        const nextKnownModule = this.context.defToModule.get(calledDefId) ?? fromModule;
        trace(calledDefId, depth + 1, nextKnownModule);
      }

      // Fallback: module-level bridge at leaf nodes when no definition-level links exist
      if (calledDefs.length === 0) {
        const leafModule = this.context.defToModule.get(defId) ?? lastKnownModule;
        if (!leafModule) return;

        const leafModuleId = leafModule.moduleId;
        if (visitedBridgeModules.has(leafModuleId)) return;
        visitedBridgeModules.add(leafModuleId);

        const inferred = this.context.inferredFromModule.get(leafModuleId);
        if (!inferred) return;

        for (const interaction of inferred) {
          const targetModuleId = interaction.toModuleId;
          const targetDefs = this.context.moduleToDefIds.get(targetModuleId);
          if (!targetDefs || targetDefs.length === 0) continue;

          // Pick representative: first unvisited, fallback first
          const representative = targetDefs.find((d) => !visited.has(d)) ?? targetDefs[0];

          steps.push({
            fromDefinitionId: defId,
            toDefinitionId: representative,
            fromModuleId: leafModuleId,
            toModuleId: targetModuleId,
          });

          inferredSteps.push({
            fromModuleId: leafModuleId,
            toModuleId: targetModuleId,
            source: interaction.source as 'llm-inferred' | 'contract-matched',
          });

          // Continue tracing from the bridge target — marked as bridged
          // so we record the step but don't expand its call graph
          const targetModule = this.context.defToModule.get(representative) ?? null;
          trace(representative, depth + 1, targetModule, true);
        }
      }
    };

    const startModule = this.context.defToModule.get(startDefinitionId) ?? null;
    trace(startDefinitionId, 0, startModule);
    return { definitionSteps: steps, inferredSteps };
  }

  /**
   * Derive unique interaction IDs from definition-level steps.
   */
  private deriveInteractionIds(definitionSteps: TracedDefinitionStep[]): number[] {
    const seenIds = new Set<number>();
    const result: number[] = [];

    for (const step of definitionSteps) {
      if (step.fromModuleId && step.toModuleId) {
        const key = `${step.fromModuleId}->${step.toModuleId}`;
        const interactionId = this.context.interactionByModulePair.get(key);
        if (interactionId && !seenIds.has(interactionId)) {
          seenIds.add(interactionId);
          result.push(interactionId);
        }
      }
    }

    return result;
  }

  /**
   * Generate a flow name from an entry point module and member.
   */
  private generateFlowNameFromModule(
    _module: EntryPointModuleInfo,
    member: {
      id: number;
      name: string;
      kind: string;
      actionType: ActionType | null;
      targetEntity: string | null;
      stakeholder: FlowStakeholder | null;
    }
  ): string {
    if (member.actionType && member.targetEntity) {
      const actionVerb = this.actionTypeToVerb(member.actionType);
      const entity = member.targetEntity.charAt(0).toUpperCase() + member.targetEntity.slice(1);
      return `${actionVerb}${entity}Flow`;
    }

    let name = member.name;
    name = name.replace(/^handle/, '');
    name = name.replace(/Handler$/, '');
    name = name.replace(/Controller$/, '');
    name = name.replace(/^on/, '');

    if (member.actionType) {
      const actionVerb = this.actionTypeToVerb(member.actionType);
      name = `${actionVerb}${name}`;
    }

    if (!name.endsWith('Flow')) {
      name = `${name}Flow`;
    }

    return name;
  }

  private actionTypeToVerb(actionType: ActionType): string {
    switch (actionType) {
      case 'view':
        return 'View';
      case 'create':
        return 'Create';
      case 'update':
        return 'Update';
      case 'delete':
        return 'Delete';
      case 'process':
        return 'Process';
      default:
        return '';
    }
  }

  /**
   * Generate a slug from an entry point module and member.
   */
  private generateFlowSlugFromModule(
    module: EntryPointModuleInfo,
    member: {
      id: number;
      name: string;
      kind: string;
      actionType: ActionType | null;
      targetEntity: string | null;
      stakeholder: FlowStakeholder | null;
    }
  ): string {
    return this.generateFlowNameFromModule(module, member)
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }
}

/**
 * Build the flow tracing context from database data.
 */
export function buildFlowTracingContext(
  definitionCallGraph: Map<number, number[]>,
  allModulesWithMembers: Array<{
    id: number;
    fullPath: string;
    members: Array<{ definitionId: number; name: string }>;
  }>,
  interactions: InteractionWithPaths[],
  entryPointModuleIds?: Set<number>,
  definitionLinks?: Array<InteractionDefinitionLink & { toModuleId: number; source: string }>
): FlowTracingContext {
  // Build definition-to-module lookup, reverse module-to-definitions lookup, and defId-to-name lookup
  const defToModule = new Map<number, { moduleId: number; modulePath: string }>();
  const moduleToDefIds = new Map<number, number[]>();
  const defIdToName = new Map<number, string>();
  for (const mod of allModulesWithMembers) {
    const defIds: number[] = [];
    for (const member of mod.members) {
      defToModule.set(member.definitionId, { moduleId: mod.id, modulePath: mod.fullPath });
      defIds.push(member.definitionId);
      defIdToName.set(member.definitionId, member.name);
    }
    if (defIds.length > 0) {
      moduleToDefIds.set(mod.id, defIds);
    }
  }

  // Build interaction lookup for module pairs
  const interactionByModulePair = new Map<string, number>();
  for (const interaction of interactions) {
    const key = `${interaction.fromModuleId}->${interaction.toModuleId}`;
    interactionByModulePair.set(key, interaction.id);
  }

  // Build lookup for bridgeable interactions (llm-inferred and contract-matched) by source module
  const inferredFromModule = new Map<number, InteractionWithPaths[]>();
  for (const interaction of interactions) {
    if (interaction.source === 'llm-inferred' || interaction.source === 'contract-matched') {
      const existing = inferredFromModule.get(interaction.fromModuleId) ?? [];
      existing.push(interaction);
      inferredFromModule.set(interaction.fromModuleId, existing);
    }
  }

  // Build set of modules that are targets of protocol-boundary interactions
  const boundaryTargetModuleIds = new Set<number>();
  for (const interaction of interactions) {
    if (interaction.source === 'llm-inferred' || interaction.source === 'contract-matched') {
      boundaryTargetModuleIds.add(interaction.toModuleId);
    }
  }

  // Build lookup for ALL interactions by source module
  const allInteractionsFromModule = new Map<number, InteractionWithPaths[]>();
  for (const interaction of interactions) {
    const existing = allInteractionsFromModule.get(interaction.fromModuleId) ?? [];
    existing.push(interaction);
    allInteractionsFromModule.set(interaction.fromModuleId, existing);
  }

  // Build definition-level bridge map from definition links
  const definitionBridgeMap = new Map<
    number,
    Array<{
      interactionId: number;
      toDefinitionId: number;
      toModuleId: number;
      source: 'llm-inferred' | 'contract-matched';
    }>
  >();
  if (definitionLinks) {
    for (const link of definitionLinks) {
      if (link.source === 'llm-inferred' || link.source === 'contract-matched') {
        const existing = definitionBridgeMap.get(link.fromDefinitionId) ?? [];
        existing.push({
          interactionId: link.interactionId,
          toDefinitionId: link.toDefinitionId,
          toModuleId: link.toModuleId,
          source: link.source as 'llm-inferred' | 'contract-matched',
        });
        definitionBridgeMap.set(link.fromDefinitionId, existing);
      }
    }
  }

  return {
    definitionCallGraph,
    defToModule,
    interactionByModulePair,
    inferredFromModule,
    allInteractionsFromModule,
    moduleToDefIds,
    defIdToName,
    entryPointModuleIds: entryPointModuleIds ?? new Set(),
    boundaryTargetModuleIds,
    definitionBridgeMap,
  };
}
