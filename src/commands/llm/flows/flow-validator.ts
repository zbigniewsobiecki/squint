/**
 * FlowValidator - Reviews generated flows for completeness and identifies missing user stories.
 * Uses LLM to find gaps in flow coverage and creates corrective flows.
 */

import type { Command } from '@oclif/core';
import type { IndexDatabase } from '../../../db/database.js';
import type { InteractionWithPaths, Module } from '../../../db/schema.js';
import { parseRow } from '../_shared/csv-utils.js';
import { groupModulesByEntity } from '../_shared/entity-utils.js';
import {
  type LlmLogOptions,
  completeWithLogging,
  logLlmRequest,
  logLlmResponse,
  logVerbose,
} from '../_shared/llm-utils.js';
import type { EntryPointModuleInfo, FlowSuggestion, LlmOptions } from './types.js';

interface CoverageGateFailure {
  gate: string;
  actual: number;
  threshold: number;
  details: string;
}

export class FlowValidator {
  constructor(
    private readonly db: IndexDatabase,
    private readonly command: Command,
    private readonly isJson: boolean,
    private readonly verbose: boolean
  ) {}

  /**
   * Validate existing flows for completeness and generate flows for missing user stories.
   */
  async validateAndFillGaps(
    existingFlows: FlowSuggestion[],
    interactions: InteractionWithPaths[],
    model: string,
    llmOptions: LlmOptions,
    gateFailures?: CoverageGateFailure[],
    entryPointModules?: EntryPointModuleInfo[],
    atomicFlows?: FlowSuggestion[]
  ): Promise<FlowSuggestion[]> {
    const modules = this.db.modules.getAll();
    const moduleByPath = new Map(modules.map((m) => [m.fullPath, m]));

    const coveredInteractionIds = new Set(existingFlows.flatMap((f) => f.interactionIds));

    const systemPrompt = this.buildValidationSystemPrompt();
    const userPrompt = this.buildValidationUserPrompt(
      existingFlows,
      interactions,
      modules,
      coveredInteractionIds,
      gateFailures,
      entryPointModules,
      atomicFlows
    );

    const logOptions: LlmLogOptions = {
      showRequests: llmOptions.showLlmRequests,
      showResponses: llmOptions.showLlmResponses,
      isJson: this.isJson,
    };

    logLlmRequest(this.command, 'validateAndFillGaps', systemPrompt, userPrompt, logOptions);

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      command: this.command,
      isJson: this.isJson,
    });

    logLlmResponse(this.command, 'validateAndFillGaps', response, logOptions);

    return this.parseValidatorResponse(response, interactions, moduleByPath);
  }

  private buildValidationSystemPrompt(): string {
    return `You are reviewing auto-detected user journey flows for completeness.

## What You Have
1. A list of detected flows with their entry points and steps
2. The full module interaction graph
3. Module descriptions
4. Entry point definitions showing what operations actually exist in code

## Your Task
Identify MISSING user stories — important user-facing workflows that should exist
but don't appear in the detected flows.

What to look for:
- UNCOVERED interactions in the graph that should be part of a user story
- Cross-entity side effects visible in the interaction graph (e.g., a create flow also touching notification or logging modules)
- Compositions of existing atomic flows into higher-level user stories

What NOT to do:
- Do NOT infer operations that are not visible in the interaction graph
- Do NOT propose admin CRUD flows unless admin-specific entry points are listed above
- Do NOT create flows from type/interface-only modules
- Do NOT duplicate flows that already exist — check the existing flows list carefully

## CRITICAL CONSTRAINTS
- [AST] interactions are statically verified from source code — reliable
- [INFERRED] interactions are LLM-estimated — may not exist in actual code
- The "Entry Point Definitions" section shows what operations ACTUALLY exist
- Do NOT propose flows for operations not listed in Entry Point Definitions
- Prefer building flows from [AST] interactions when possible

## Output Format
\`\`\`csv
flow_name,stakeholder,action_type,target_entity,interaction_chain,description
"user views dashboard","user","view","dashboard","project.frontend.screens→project.frontend.hooks→project.backend.api","Fetches stats for KPI display"
"admin creates account","admin","create","account","project.frontend.screens→project.backend.api.controllers","Admin provisions new account"
\`\`\`

For interaction_chain: list the module path segments in order, separated by →.
Only report flows that are genuinely MISSING — do not duplicate existing flows.
Only report flows where the module interactions to support them actually EXIST in the graph.`;
  }

  private buildValidationUserPrompt(
    existingFlows: FlowSuggestion[],
    interactions: InteractionWithPaths[],
    modules: Module[],
    coveredInteractionIds: Set<number>,
    gateFailures?: CoverageGateFailure[],
    entryPointModules?: EntryPointModuleInfo[],
    atomicFlows?: FlowSuggestion[]
  ): string {
    const parts: string[] = [];

    // Existing flows summary
    parts.push(`## Existing Flows (${existingFlows.length})`);
    for (const f of existingFlows) {
      const stepCount = f.interactionIds.length;
      const isGap = f.entryPointModuleId === null;
      parts.push(
        `- ${f.name} [${f.stakeholder}/${f.actionType ?? 'unknown'}/${f.targetEntity ?? 'unknown'}] (${stepCount} steps${isGap ? ', gap/internal' : ''})`
      );
    }
    parts.push('');

    // Modules grouped by domain
    parts.push('## Modules by Domain');
    const entityGroups = groupModulesByEntity(modules);
    for (const [entity, mods] of entityGroups) {
      if (entity === '_generic') {
        parts.push('### Generic/Shared');
      } else {
        parts.push(`### ${entity}`);
      }
      for (const m of mods) {
        parts.push(`- ${m.fullPath}: ${m.name}${m.description ? ` - ${m.description}` : ''}`);
      }
      parts.push('');
    }

    // Entry point definitions section
    if (entryPointModules && entryPointModules.length > 0) {
      parts.push('## Entry Point Definitions (operations that exist in code)');
      parts.push('ONLY create flows for operations listed below. Do NOT invent operations.');
      parts.push('');
      for (const ep of entryPointModules) {
        const defs = ep.memberDefinitions
          .map((d) => {
            const action = d.actionType ?? 'unclassified';
            const entity = d.targetEntity ?? '?';
            return `  - ${d.name} [${action}/${entity}]`;
          })
          .join('\n');
        parts.push(`### ${ep.modulePath}`);
        parts.push(defs);
        parts.push('');
      }
    }

    // Available atomic flows
    if (atomicFlows && atomicFlows.length > 0) {
      parts.push('## Available Atomic Flows');
      parts.push('You can compose flows by referencing these atomic building blocks:');
      for (const af of atomicFlows) {
        const interactionCount = af.interactionIds.length;
        parts.push(
          `- ${af.slug} (${interactionCount} interaction${interactionCount !== 1 ? 's' : ''}): ${af.description}`
        );
      }
      parts.push('');
    }

    // Interaction graph summary with coverage annotations
    const uncoveredInteractions = interactions.filter((i) => !coveredInteractionIds.has(i.id));
    const coveredCount = interactions.length - uncoveredInteractions.length;
    parts.push(
      `## Interactions (${interactions.length} total, ${coveredCount} covered, ${uncoveredInteractions.length} uncovered)`
    );
    for (const i of interactions) {
      const coverTag = coveredInteractionIds.has(i.id) ? '[COVERED]' : '[UNCOVERED]';
      const srcTag = i.source === 'llm-inferred' ? '[INFERRED]' : '[AST]';
      parts.push(
        `- ${coverTag} ${srcTag} ${i.fromModulePath} → ${i.toModulePath}${i.semantic ? `: ${i.semantic}` : ''}`
      );
    }
    parts.push('');

    // Priority section: uncovered interactions only
    if (uncoveredInteractions.length > 0) {
      parts.push('## Uncovered Interactions — PRIORITY');
      parts.push('These interactions are NOT yet covered by any flow. Create flows that include them:');
      for (const i of uncoveredInteractions) {
        const srcTag = i.source === 'llm-inferred' ? '[INFERRED]' : '[AST]';
        parts.push(`- ${srcTag} ${i.fromModulePath} → ${i.toModulePath}${i.semantic ? `: ${i.semantic}` : ''}`);
      }
      parts.push('');
    }

    // Gate failure context for retries
    if (gateFailures && gateFailures.length > 0) {
      parts.push('## Previous Attempt Results');
      parts.push('The following coverage gaps remain:');
      for (const f of gateFailures) {
        parts.push(`- ${f.gate}: ${f.details}`);
      }
      parts.push('');
      parts.push('Focus on creating flows that address these specific gaps.');
      parts.push('');
    }

    parts.push('Identify MISSING user stories. Only report flows supported by existing interactions.');

    return parts.join('\n');
  }

  private parseValidatorResponse(
    response: string,
    interactions: InteractionWithPaths[],
    moduleByPath: Map<string, Module>
  ): FlowSuggestion[] {
    const results: FlowSuggestion[] = [];

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('flow_name'));

    // Build interaction lookup by module pair
    const interactionByPair = new Map<string, InteractionWithPaths>();
    for (const i of interactions) {
      interactionByPair.set(`${i.fromModuleId}->${i.toModuleId}`, i);
    }

    for (const line of lines) {
      const fields = parseRow(line);
      if (!fields || fields.length < 6) continue;

      const [flowName, stakeholder, actionType, targetEntity, interactionChain, description] = fields;

      // Parse interaction chain (module paths separated by →)
      const chainPaths = interactionChain
        .split('→')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      if (chainPaths.length < 2) continue;

      // Resolve module paths and find matching interactions
      const resolvedModules: Module[] = [];
      for (const path of chainPaths) {
        // Try exact match first, then prefix match
        const mod = moduleByPath.get(path) ?? this.findModuleByPrefix(path, moduleByPath);
        if (mod) {
          resolvedModules.push(mod);
        }
      }

      if (resolvedModules.length < 2) continue;

      // Find interaction IDs for consecutive module pairs
      const interactionIds: number[] = [];
      for (let i = 0; i < resolvedModules.length - 1; i++) {
        const from = resolvedModules[i];
        const to = resolvedModules[i + 1];
        const interaction = interactionByPair.get(`${from.id}->${to.id}`);
        if (interaction) {
          interactionIds.push(interaction.id);
        }
      }

      if (interactionIds.length === 0) continue;

      const validStakeholders = ['user', 'admin', 'system', 'developer', 'external'] as const;
      const parsedStakeholder = validStakeholders.includes(
        stakeholder.trim().toLowerCase() as (typeof validStakeholders)[number]
      )
        ? (stakeholder.trim().toLowerCase() as (typeof validStakeholders)[number])
        : 'user';

      const validActions = ['view', 'create', 'update', 'delete', 'process'] as const;
      const parsedAction = validActions.includes(actionType.trim().toLowerCase() as (typeof validActions)[number])
        ? (actionType.trim().toLowerCase() as (typeof validActions)[number])
        : null;

      const cleanName = flowName.replace(/"/g, '').trim();
      const slug = cleanName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      results.push({
        name: cleanName,
        slug,
        entryPointModuleId: resolvedModules[0].id,
        entryPointId: null,
        entryPath: resolvedModules[0].fullPath,
        stakeholder: parsedStakeholder,
        description: description.replace(/"/g, '').trim(),
        interactionIds,
        definitionSteps: [],
        inferredSteps: [],
        actionType: parsedAction,
        targetEntity: targetEntity.replace(/"/g, '').trim() || null,
        tier: 1,
        subflowSlugs: [],
      });
    }

    logVerbose(this.command, `  Validator identified ${results.length} missing flows`, this.verbose, this.isJson);

    return results;
  }

  private findModuleByPrefix(path: string, moduleByPath: Map<string, Module>): Module | undefined {
    // Try to find a module whose path ends with the given path segment
    for (const [fullPath, mod] of moduleByPath) {
      if (fullPath.endsWith(path) || fullPath.endsWith(`.${path}`)) {
        return mod;
      }
    }
    return undefined;
  }
}
