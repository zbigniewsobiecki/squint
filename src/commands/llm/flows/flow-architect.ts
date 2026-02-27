/**
 * FlowArchitect - LLM-first flow design, validation, and definition enrichment.
 *
 * Replaces the bottom-up graph traversal pipeline (FlowTracer, FlowEnhancer,
 * FlowValidator, AtomicFlowBuilder, GapFlowGenerator) with a top-down approach:
 *
 * 1. designFlows()   – Single LLM call designs all flows from the full picture
 * 2. validateFlows()  – Deterministic validation against interaction graph
 * 3. enrichWithDefinitionSteps() – Linear walk through definition call graph
 */

import type { Command } from '@oclif/core';
import type { InteractionDefinitionLink } from '../../../db/schema.js';
import { extractCsvContent, parseRow, splitCsvLines } from '../_shared/csv-utils.js';
import {
  type LlmLogOptions,
  completeWithLogging,
  logLlmRequest,
  logLlmResponse,
  logVerbose,
} from '../_shared/llm-utils.js';
import type {
  ActionType,
  DefinitionEnrichmentContext,
  EntryPointModuleInfo,
  FlowSuggestion,
  InteractionSummary,
  LlmOptions,
  TracedDefinitionStep,
} from './types.js';

export interface DesignedFlow {
  slug: string;
  name: string;
  description: string;
  actionType: ActionType;
  targetEntity: string;
  stakeholder: string;
  entryModulePath: string;
  steps: Array<{ fromPath: string; toPath: string }>;
}

export interface ValidationResult {
  validFlows: FlowSuggestion[];
  failedCount: number;
  failureReasons: string[];
}

export class FlowArchitect {
  constructor(
    private readonly command: Command,
    private readonly isJson: boolean,
    private readonly verbose: boolean
  ) {}

  /**
   * Design all flows in a single LLM call.
   * The LLM sees the full picture: modules, entry points, and interactions.
   */
  async designFlows(
    model: string,
    modules: Array<{ id: number; fullPath: string; description: string | null }>,
    entryPoints: EntryPointModuleInfo[],
    interactions: InteractionSummary[],
    llmOptions: LlmOptions,
    retryFeedback?: string[]
  ): Promise<DesignedFlow[]> {
    const systemPrompt = this.buildDesignSystemPrompt();
    const userPrompt = this.buildDesignUserPrompt(modules, entryPoints, interactions, retryFeedback);

    const logOptions: LlmLogOptions = {
      showRequests: llmOptions.showLlmRequests,
      showResponses: llmOptions.showLlmResponses,
      isJson: this.isJson,
    };

    logLlmRequest(this.command, 'designFlows', systemPrompt, userPrompt, logOptions);

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      command: this.command,
      isJson: this.isJson,
    });

    logLlmResponse(this.command, 'designFlows', response, logOptions);

    const { flows, errors } = FlowArchitect.parseFlowCSV(response);

    if (errors.length > 0) {
      logVerbose(this.command, `  CSV parse errors: ${errors.join('; ')}`, this.verbose, this.isJson);
    }

    if (flows.length === 0 && errors.length > 0) {
      throw new Error(
        `LLM response produced 0 flows with ${errors.length} parse errors: ${errors.slice(0, 3).join('; ')}`
      );
    }

    return flows;
  }

  /**
   * Validate designed flows against actual interactions in the DB.
   * For each consecutive module pair in a flow, look up the interaction.
   * Drop invalid steps; drop flows with 0 valid interaction IDs.
   */
  validateFlows(
    designedFlows: DesignedFlow[],
    interactionByModulePair: Map<string, number>,
    modulePathToId: Map<string, number>,
    entryPoints: EntryPointModuleInfo[]
  ): ValidationResult {
    const validFlows: FlowSuggestion[] = [];
    let failedCount = 0;
    const failureReasons: string[] = [];

    // Fuzzy resolve: try exact match first, then strip trailing segments
    // (handles LLM appending definition/class names to module paths)
    const resolveModuleId = (path: string): number | undefined => {
      const exact = modulePathToId.get(path);
      if (exact !== undefined) return exact;
      // Strip last segment and retry (e.g. "project.frontend.pages.Dashboard" → "project.frontend.pages")
      const dotIdx = path.lastIndexOf('.');
      if (dotIdx > 0) {
        return modulePathToId.get(path.slice(0, dotIdx));
      }
      return undefined;
    };

    for (const flow of designedFlows) {
      // Resolve entry module path to ID
      const entryModuleId = resolveModuleId(flow.entryModulePath);
      if (entryModuleId === undefined) {
        failedCount++;
        failureReasons.push(`Unknown entry module: ${flow.entryModulePath}`);
        continue;
      }

      // Validate each step
      const validInteractionIds: number[] = [];
      for (const step of flow.steps) {
        const fromId = resolveModuleId(step.fromPath);
        const toId = resolveModuleId(step.toPath);
        if (fromId === undefined || toId === undefined) {
          failureReasons.push(`Unknown module in step: ${step.fromPath} → ${step.toPath}`);
          continue;
        }
        const key = `${fromId}->${toId}`;
        const interactionId = interactionByModulePair.get(key);
        if (interactionId !== undefined) {
          validInteractionIds.push(interactionId);
        } else {
          failureReasons.push(`No interaction: ${step.fromPath} → ${step.toPath}`);
        }
      }

      // Drop flows with 0 valid interactions
      if (validInteractionIds.length === 0) {
        failedCount++;
        continue;
      }

      // Find matching entry point definition by actionType + targetEntity (same logic as resolveEntryPointIds)
      const ep = entryPoints.find((e) => e.moduleId === entryModuleId);

      const validActionTypes: ActionType[] = ['view', 'create', 'update', 'delete', 'process'];
      const actionType = validActionTypes.includes(flow.actionType) ? flow.actionType : null;

      let entryPointId: number | null = null;
      if (ep) {
        const exactMatch = ep.memberDefinitions.find(
          (d) => d.actionType === actionType && d.targetEntity === flow.targetEntity
        );
        const fallbackMatch = exactMatch ?? ep.memberDefinitions.find((d) => d.actionType === actionType);
        entryPointId = (fallbackMatch ?? exactMatch)?.id ?? null;
      }

      const validStakeholders = ['user', 'admin', 'system', 'developer', 'external'] as const;
      const stakeholder = validStakeholders.includes(flow.stakeholder as (typeof validStakeholders)[number])
        ? (flow.stakeholder as (typeof validStakeholders)[number])
        : 'user';

      validFlows.push({
        name: flow.name,
        slug: flow.slug,
        entryPointModuleId: entryModuleId,
        entryPointId,
        entryPath: flow.entryModulePath,
        stakeholder,
        description: flow.description,
        interactionIds: validInteractionIds,
        definitionSteps: [],
        actionType,
        targetEntity: flow.targetEntity || null,
        tier: 1,
        subflowSlugs: [],
      });
    }

    return { validFlows, failedCount, failureReasons };
  }

  /**
   * Enrich a flow with definition-level steps via a linear walk.
   * Walks the flow's module chain and finds definition bridges/call graph edges.
   */
  enrichWithDefinitionSteps(
    flow: FlowSuggestion,
    ctx: DefinitionEnrichmentContext,
    entryDefinitionId: number | null,
    interactionByModulePair?: Map<string, number>
  ): TracedDefinitionStep[] {
    const steps: TracedDefinitionStep[] = [];

    // Get current definitions at the entry module
    let currentDefs: number[] = entryDefinitionId
      ? [entryDefinitionId]
      : (ctx.moduleToDefIds.get(flow.entryPointModuleId!) ?? []);

    if (currentDefs.length === 0) return steps;

    // Build the set of module IDs on the flow's interaction chain for constraining the walk.
    // When interactionByModulePair is not provided, leave empty to allow unconstrained walk.
    const flowModuleIds = new Set<number>();
    if (interactionByModulePair) {
      if (flow.entryPointModuleId !== null) flowModuleIds.add(flow.entryPointModuleId);
      for (const key of interactionByModulePair.keys()) {
        const [fromStr, toStr] = key.split('->');
        const fromId = Number(fromStr);
        const toId = Number(toStr);
        // Only include modules from interactions that belong to this flow
        if (flow.interactionIds.includes(interactionByModulePair.get(key)!)) {
          flowModuleIds.add(fromId);
          flowModuleIds.add(toId);
        }
      }
    }

    // Walk max 7 steps (one per flow step)
    const maxSteps = 7;
    for (let step = 0; step < maxSteps; step++) {
      if (currentDefs.length === 0) break;

      let advanced = false;

      // Strategy 1: Check definitionBridgeMap for bridges from currentDefs
      for (const defId of currentDefs) {
        const bridges = ctx.definitionBridgeMap.get(defId);
        if (!bridges) continue;

        for (const bridge of bridges) {
          // Only follow bridges to modules in the flow's interaction chain
          if (flowModuleIds.size > 0 && !flowModuleIds.has(bridge.toModuleId)) continue;

          steps.push({
            fromDefinitionId: defId,
            toDefinitionId: bridge.toDefinitionId,
            fromModuleId: ctx.defToModule.get(defId)?.moduleId ?? null,
            toModuleId: bridge.toModuleId,
          });
          currentDefs = [bridge.toDefinitionId];
          advanced = true;
          break;
        }
        if (advanced) break;
      }
      if (advanced) continue;

      // Strategy 2: Check call graph for edges from currentDefs to defs in other modules
      const nextDefs: number[] = [];
      for (const defId of currentDefs) {
        const callees = ctx.definitionCallGraph.get(defId) ?? [];
        const currentModule = ctx.defToModule.get(defId);
        for (const calleeId of callees) {
          const calleeModule = ctx.defToModule.get(calleeId);
          if (
            calleeModule &&
            currentModule &&
            calleeModule.moduleId !== currentModule.moduleId &&
            (flowModuleIds.size === 0 || flowModuleIds.has(calleeModule.moduleId))
          ) {
            steps.push({
              fromDefinitionId: defId,
              toDefinitionId: calleeId,
              fromModuleId: currentModule.moduleId,
              toModuleId: calleeModule.moduleId,
            });
            nextDefs.push(calleeId);
          }
        }
      }

      if (nextDefs.length > 0) {
        currentDefs = nextDefs;
        continue;
      }

      // No more paths found
      break;
    }

    return steps;
  }

  /**
   * Build the definition enrichment context from database data.
   */
  static buildDefinitionContext(
    callGraph: Map<number, number[]>,
    allDefinitionLinks: Array<InteractionDefinitionLink & { toModuleId: number; source: string }>,
    moduleMembers: Array<{
      id: number;
      fullPath: string;
      members: Array<{ definitionId: number; name: string }>;
    }>
  ): DefinitionEnrichmentContext {
    const defToModule = new Map<number, { moduleId: number; modulePath: string }>();
    const moduleToDefIds = new Map<number, number[]>();

    for (const mod of moduleMembers) {
      const defIds: number[] = [];
      for (const member of mod.members) {
        defToModule.set(member.definitionId, { moduleId: mod.id, modulePath: mod.fullPath });
        defIds.push(member.definitionId);
      }
      if (defIds.length > 0) {
        moduleToDefIds.set(mod.id, defIds);
      }
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
    for (const link of allDefinitionLinks) {
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

    return {
      definitionCallGraph: callGraph,
      defToModule,
      moduleToDefIds,
      definitionBridgeMap,
    };
  }

  /**
   * Parse the LLM's CSV response into DesignedFlow objects.
   */
  static parseFlowCSV(response: string): { flows: DesignedFlow[]; errors: string[] } {
    const errors: string[] = [];
    const flows: DesignedFlow[] = [];

    const csv = extractCsvContent(response);
    const lines = splitCsvLines(csv);

    if (lines.length === 0) {
      errors.push('Empty CSV response');
      return { flows, errors };
    }

    // Skip header row
    const startIndex = lines[0].toLowerCase().startsWith('flow_slug') ? 1 : 0;

    const validActionTypes = new Set<string>(['view', 'create', 'update', 'delete', 'process']);

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const fields = parseRow(line);
      if (!fields || fields.length < 8) {
        errors.push(`Line ${i + 1}: Expected 8 columns, got ${fields?.length ?? 0}`);
        continue;
      }

      const [slug, name, description, actionType, targetEntity, stakeholder, entryModulePath, stepsRaw] = fields.map(
        (f) => f.trim()
      );

      if (!validActionTypes.has(actionType)) {
        errors.push(`Line ${i + 1}: Invalid action_type "${actionType}"`);
        continue;
      }

      // Parse pipe-delimited steps: "a>b|b>c|c>d"
      const steps: Array<{ fromPath: string; toPath: string }> = [];
      const stepParts = stepsRaw.split('|').filter((s) => s.trim());
      for (const part of stepParts) {
        const sepIdx = part.indexOf('>');
        if (sepIdx === -1) {
          errors.push(`Line ${i + 1}: Invalid step format "${part}" (expected "from>to")`);
          continue;
        }
        const fromPath = part.slice(0, sepIdx).trim();
        const toPath = part.slice(sepIdx + 1).trim();
        if (fromPath && toPath) {
          steps.push({ fromPath, toPath });
        }
      }

      flows.push({
        slug,
        name,
        description,
        actionType: actionType as ActionType,
        targetEntity,
        stakeholder,
        entryModulePath,
        steps,
      });
    }

    return { flows, errors };
  }

  /**
   * Resolve entryPointId on flows by matching against entry point definitions.
   * Matches by actionType + targetEntity, falls back to first actionType match.
   */
  static resolveEntryPointIds(flows: FlowSuggestion[], entryPoints: EntryPointModuleInfo[]): void {
    const epByModule = new Map<number, EntryPointModuleInfo>();
    for (const ep of entryPoints) {
      epByModule.set(ep.moduleId, ep);
    }

    for (const flow of flows) {
      if (flow.entryPointModuleId === null) continue;
      const ep = epByModule.get(flow.entryPointModuleId);
      if (!ep) continue;

      // Try exact match: actionType + targetEntity
      let match = ep.memberDefinitions.find(
        (d) => d.actionType === flow.actionType && d.targetEntity === flow.targetEntity
      );

      // Fall back to first actionType match
      if (!match) {
        match = ep.memberDefinitions.find((d) => d.actionType === flow.actionType);
      }

      if (match) {
        flow.entryPointId = match.id;
      }
    }
  }

  // ─── Private: LLM Prompt Construction ─────────────────────────

  private buildDesignSystemPrompt(): string {
    return `You are designing user journey flows for a codebase. You see the complete picture: all modules, their entry points, and the interaction graph between them.

## Task
Design focused, entity-scoped flows that trace real user actions through the codebase. Each flow represents ONE user action (view, create, update, delete, or process).

## Rules
1. Each flow = ONE user action on ONE entity
2. Names: "[stakeholder] [verb]s [entity phrase]" (all lowercase, natural language)
   - view → "user views vehicle list"
   - create → "admin creates new customer"
   - update → "user updates account settings"
   - delete → "user deletes draft entry"
   - process → "user logs into system"
3. 2-12 steps per flow; most should be 5-8. Include both the main data-flow chain and cross-cutting edges (middleware, utils, components).
4. Steps form a tree rooted at the entry module. Each step's "from" must be a module that already appeared (as from or to) in a prior step, or the entry module itself. Steps do NOT need to form a strict linear chain — branches are allowed.
5. Every entry point definition with an action_type MUST produce at least one flow
6. No cross-entity tracing — a sale flow should NOT include customer-only modules
7. Each step from>to MUST exactly match one edge from the Valid Interaction Edges list. Do NOT invent edges or use transitive paths.
8. Cross-process interactions (CROSS-PROCESS) MUST appear in flows when relevant
9. Slugs: lowercase, hyphens only (e.g., "user-views-vehicle-list")
10. Include cross-cutting edges: if a module in the flow also connects to middleware, utils, or components, include those edges as additional steps. Maximize coverage of the interaction graph.

## Output Format
\`\`\`csv
flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
\`\`\`

Steps column: pipe-delimited \`from>to\` pairs using module full paths from the Module Tree.

Example (paths are illustrative only — use REAL paths from the Module Tree):
\`\`\`csv
flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
user-views-vehicle-list,user views vehicle list,Displays paginated vehicle inventory,view,vehicle,user,project.frontend.pages,project.frontend.pages>project.frontend.hooks.vehicles|project.frontend.hooks.vehicles>project.frontend.services.api|project.frontend.services.api>project.backend.api.vehicles
admin-creates-customer,admin creates new customer,Validates and persists customer record,create,customer,admin,project.frontend.pages,project.frontend.pages>project.frontend.hooks.customers|project.frontend.hooks.customers>project.frontend.services.api|project.frontend.services.api>project.backend.api.customers|project.backend.api.customers>project.backend.services.customers
\`\`\`

CRITICAL: Every path (entry_module_path and in steps) MUST be an exact path from the Module Tree above. Do NOT append class names, component names, or definition names to paths.`;
  }

  private buildDesignUserPrompt(
    modules: Array<{ id: number; fullPath: string; description: string | null }>,
    entryPoints: EntryPointModuleInfo[],
    interactions: InteractionSummary[],
    retryFeedback?: string[]
  ): string {
    const parts: string[] = [];

    // Module tree
    parts.push(`## Module Tree (${modules.length} modules)`);
    parts.push('id | path | description');
    parts.push('---|------|------------');
    for (const m of modules) {
      parts.push(`${m.id} | ${m.fullPath} | ${m.description ?? ''}`);
    }
    parts.push('');

    // Entry points grouped by module
    parts.push(`## Entry Points (${entryPoints.length} modules)`);
    for (const ep of entryPoints) {
      parts.push(`### ${ep.modulePath} (module ${ep.moduleId})`);
      for (const def of ep.memberDefinitions) {
        const action = def.actionType ?? 'unclassified';
        const entity = def.targetEntity ?? '?';
        const stakeholder = def.stakeholder ?? 'user';
        const traceFrom = def.traceFromDefinition ? ` [trace from: ${def.traceFromDefinition}]` : '';
        parts.push(`  - ${def.name} (${def.kind}): ${action}/${entity} [${stakeholder}]${traceFrom}`);
      }
      parts.push('');
    }

    // Interaction graph as flat edge table (same from>to syntax as output steps)
    parts.push(`## Valid Interaction Edges (${interactions.length} edges)`);
    parts.push("Each step's from>to MUST exactly match one row below.");
    for (const edge of interactions) {
      const sourceTag = edge.source === 'contract-matched' ? 'CROSS-PROCESS' : 'AST';
      const desc = edge.semantic ? ` "${edge.semantic}"` : '';
      parts.push(`${edge.fromModulePath} > ${edge.toModulePath} (${sourceTag}, w:${edge.weight})${desc}`);
    }
    parts.push('');

    // Retry feedback
    if (retryFeedback && retryFeedback.length > 0) {
      parts.push('## Previous Attempt Errors');
      parts.push(
        'IMPORTANT: Every step from>to must exactly match one edge from the Valid Interaction Edges list above.'
      );
      parts.push('The following issues were found in the previous attempt. Fix them:');
      for (const reason of retryFeedback) {
        parts.push(`- ${reason}`);
      }
      parts.push('');
    }

    parts.push(
      'Design flows for ALL entry points with action types. Every entry point definition with an action_type must produce at least one flow.'
    );

    return parts.join('\n');
  }
}
