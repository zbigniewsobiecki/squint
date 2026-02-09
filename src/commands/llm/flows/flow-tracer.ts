/**
 * FlowTracer - Definition-level call graph traversal.
 * Traces flows from entry point definitions through the call graph.
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
   * Trace flows from all entry point modules.
   */
  traceFlowsFromEntryPoints(entryPointModules: EntryPointModuleInfo[]): FlowSuggestion[] {
    const flowSuggestions: FlowSuggestion[] = [];

    for (const entryPointModule of entryPointModules) {
      for (const member of entryPointModule.memberDefinitions) {
        const definitionSteps = this.traceDefinitionFlow(member.id);

        const { extendedInteractionIds, inferredSteps } = this.extendWithInferredInteractions(definitionSteps);

        if (definitionSteps.length > 0 || inferredSteps.length > 0) {
          const derivedInteractionIds = this.deriveInteractionIds(definitionSteps);
          const allInteractionIds = [...derivedInteractionIds, ...extendedInteractionIds];

          flowSuggestions.push({
            name: this.generateFlowNameFromModule(entryPointModule, member),
            slug: this.generateFlowSlugFromModule(entryPointModule, member),
            entryPointModuleId: entryPointModule.moduleId,
            entryPointId: member.id,
            entryPath: `${entryPointModule.modulePath}.${member.name}`,
            stakeholder: this.inferStakeholderFromModule(entryPointModule),
            description: `Flow starting from ${member.name} in ${entryPointModule.modulePath}`,
            interactionIds: allInteractionIds,
            definitionSteps,
            inferredSteps,
            actionType: member.actionType,
            targetEntity: member.targetEntity,
          });
        }
      }
    }

    return flowSuggestions;
  }

  /**
   * Trace a flow from a starting definition through the definition-level call graph.
   */
  private traceDefinitionFlow(startDefinitionId: number): TracedDefinitionStep[] {
    const visited = new Set<number>();
    const steps: TracedDefinitionStep[] = [];

    const trace = (defId: number, depth: number): void => {
      if (depth >= this.maxDepth) return;
      if (visited.has(defId)) return;
      visited.add(defId);

      const calledDefs = this.context.definitionCallGraph.get(defId) ?? [];
      for (const calledDefId of calledDefs) {
        const fromModule = this.context.defToModule.get(defId);
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

        trace(calledDefId, depth + 1);
      }
    };

    trace(startDefinitionId, 0);
    return steps;
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
   * Extend traced definition steps with module-level interactions.
   * 1. Add inferred interactions from all traced modules
   * 2. Continue tracing AST interactions from modules reached via inference
   * This ensures flows continue through backend layers after crossing the HTTP boundary.
   */
  private extendWithInferredInteractions(definitionSteps: TracedDefinitionStep[]): {
    extendedInteractionIds: number[];
    inferredSteps: InferredFlowStep[];
  } {
    const extendedInteractionIds: number[] = [];
    const inferredSteps: InferredFlowStep[] = [];
    const visitedModules = new Set<number>();
    const addedInteractionIds = new Set<number>();

    // Track interaction IDs already covered by definition steps
    for (const step of definitionSteps) {
      if (step.fromModuleId && step.toModuleId) {
        const key = `${step.fromModuleId}->${step.toModuleId}`;
        const interactionId = this.context.interactionByModulePair.get(key);
        if (interactionId) addedInteractionIds.add(interactionId);
      }
    }

    // Collect ALL modules that appear in the traced definition steps
    const tracedModules = new Set<number>();
    for (const step of definitionSteps) {
      if (step.fromModuleId) tracedModules.add(step.fromModuleId);
      if (step.toModuleId) tracedModules.add(step.toModuleId);
    }

    const queue = [...tracedModules];

    while (queue.length > 0) {
      const moduleId = queue.shift()!;
      if (visitedModules.has(moduleId)) continue;
      visitedModules.add(moduleId);

      // First, add inferred interactions from this module
      const inferredInteractions = this.context.inferredFromModule.get(moduleId) ?? [];
      for (const interaction of inferredInteractions) {
        if (addedInteractionIds.has(interaction.id)) continue;
        addedInteractionIds.add(interaction.id);

        extendedInteractionIds.push(interaction.id);
        inferredSteps.push({
          fromModuleId: interaction.fromModuleId,
          toModuleId: interaction.toModuleId,
          source: 'llm-inferred',
        });

        // Continue tracing from the target module
        if (!visitedModules.has(interaction.toModuleId)) {
          queue.push(interaction.toModuleId);
        }
      }

      // For modules reached via inference (not in original traced modules),
      // also follow their AST interactions to continue the trace
      if (!tracedModules.has(moduleId)) {
        const allInteractions = this.context.allInteractionsFromModule.get(moduleId) ?? [];
        for (const interaction of allInteractions) {
          if (addedInteractionIds.has(interaction.id)) continue;
          addedInteractionIds.add(interaction.id);

          extendedInteractionIds.push(interaction.id);
          // Mark as inferred since we reached this module via inference
          inferredSteps.push({
            fromModuleId: interaction.fromModuleId,
            toModuleId: interaction.toModuleId,
            source: 'llm-inferred',
          });

          if (!visitedModules.has(interaction.toModuleId)) {
            queue.push(interaction.toModuleId);
          }
        }
      }
    }

    return { extendedInteractionIds, inferredSteps };
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
  // Build definition-to-module lookup
  const defToModule = new Map<number, { moduleId: number; modulePath: string }>();
  for (const mod of allModulesWithMembers) {
    for (const member of mod.members) {
      defToModule.set(member.definitionId, { moduleId: mod.id, modulePath: mod.fullPath });
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

  // Build lookup for ALL interactions by source module (for continuing traces)
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
  };
}
