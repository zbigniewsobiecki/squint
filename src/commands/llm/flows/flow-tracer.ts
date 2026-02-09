/**
 * FlowTracer - Definition-level call graph traversal.
 * Traces composite tier-1 flows from entry point definitions through the call graph,
 * mapping interactions to atomic subflow references.
 */

import type { InteractionWithPaths } from '../../../db/schema.js';
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
        const { definitionSteps, inferredSteps } = this.traceDefinitionFlow(member.id);
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
            stakeholder: this.inferStakeholderFromModule(entryPointModule),
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
  private traceDefinitionFlow(startDefinitionId: number): {
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

      // When a definition was reached via bridge (inferred interaction),
      // don't follow its regular call-graph edges. The bridge connects the
      // boundary crossing; the target's own call graph is traced by its own
      // entry-point flows. Following it here would expand the entire target
      // subsystem (e.g. an Express app.use() aggregator → all controllers).
      if (isBridged) return;

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
        }

        const nextKnownModule = this.context.defToModule.get(calledDefId) ?? fromModule;
        trace(calledDefId, depth + 1, nextKnownModule);
      }

      // Bridge via inferred interactions at leaf nodes
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
            source: 'llm-inferred',
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
    member: { id: number; name: string; kind: string; actionType: ActionType | null; targetEntity: string | null }
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
    member: { id: number; name: string; kind: string; actionType: ActionType | null; targetEntity: string | null }
  ): string {
    return this.generateFlowNameFromModule(module, member)
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }

  /**
   * Infer stakeholder from entry point module context.
   */
  private inferStakeholderFromModule(
    module: EntryPointModuleInfo
  ): 'user' | 'admin' | 'system' | 'developer' | 'external' {
    const path = module.modulePath.toLowerCase();

    if (path.includes('admin')) return 'admin';
    if (path.includes('api') || path.includes('route')) return 'external';
    if (path.includes('cron') || path.includes('job') || path.includes('worker')) return 'system';
    if (path.includes('cli') || path.includes('command')) return 'developer';

    return 'user';
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
    members: Array<{ definitionId: number }>;
  }>,
  interactions: InteractionWithPaths[]
): FlowTracingContext {
  // Build definition-to-module lookup and reverse module-to-definitions lookup
  const defToModule = new Map<number, { moduleId: number; modulePath: string }>();
  const moduleToDefIds = new Map<number, number[]>();
  for (const mod of allModulesWithMembers) {
    const defIds: number[] = [];
    for (const member of mod.members) {
      defToModule.set(member.definitionId, { moduleId: mod.id, modulePath: mod.fullPath });
      defIds.push(member.definitionId);
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

  // Build lookup for llm-inferred interactions by source module
  const inferredFromModule = new Map<number, InteractionWithPaths[]>();
  for (const interaction of interactions) {
    if (interaction.source === 'llm-inferred') {
      const existing = inferredFromModule.get(interaction.fromModuleId) ?? [];
      existing.push(interaction);
      inferredFromModule.set(interaction.fromModuleId, existing);
    }
  }

  // Build lookup for ALL interactions by source module
  const allInteractionsFromModule = new Map<number, InteractionWithPaths[]>();
  for (const interaction of interactions) {
    const existing = allInteractionsFromModule.get(interaction.fromModuleId) ?? [];
    existing.push(interaction);
    allInteractionsFromModule.set(interaction.fromModuleId, existing);
  }

  return {
    definitionCallGraph,
    defToModule,
    interactionByModulePair,
    inferredFromModule,
    allInteractionsFromModule,
    moduleToDefIds,
  };
}
