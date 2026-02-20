/**
 * FlowEnhancer - LLM metadata enhancement for flows.
 * Enriches flow suggestions with better names and descriptions using LLM.
 */

import type { Command } from '@oclif/core';
import type { InteractionWithPaths } from '../../../db/schema.js';
import { parseRow } from '../_shared/csv-utils.js';
import { type LlmLogOptions, completeWithLogging, logLlmRequest, logLlmResponse } from '../_shared/llm-utils.js';
import type { FlowSuggestion, LlmOptions } from './types.js';

export class FlowEnhancer {
  constructor(
    private readonly command: Command,
    private readonly isJson: boolean
  ) {}

  /**
   * Enhance flows with LLM-generated metadata.
   */
  async enhanceFlowsWithLLM(
    flows: FlowSuggestion[],
    interactions: InteractionWithPaths[],
    model: string,
    llmOptions: LlmOptions
  ): Promise<FlowSuggestion[]> {
    // Separate tier-0 (atomic) flows — they keep deterministic names
    const atomicFlows = flows.filter((f) => f.tier === 0);
    const compositeFlows = flows.filter((f) => f.tier !== 0);

    // If no composite flows to enhance, return all as-is
    if (compositeFlows.length === 0) return flows;

    const interactionMap = new Map(interactions.map((i) => [i.id, i]));

    const systemPrompt = this.buildEnhancementSystemPrompt();
    const userPrompt = this.buildEnhancementUserPrompt(compositeFlows, interactionMap);

    const logOptions: LlmLogOptions = {
      showRequests: llmOptions.showLlmRequests,
      showResponses: llmOptions.showLlmResponses,
      isJson: this.isJson,
    };

    logLlmRequest(this.command, 'enhanceFlowsWithLLM', systemPrompt, userPrompt, logOptions);

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      command: this.command,
      isJson: this.isJson,
    });

    logLlmResponse(this.command, 'enhanceFlowsWithLLM', response, logOptions);

    const enhanced = this.parseEnhancedFlowsCSV(response, compositeFlows);
    return [...atomicFlows, ...enhanced];
  }

  private buildEnhancementSystemPrompt(): string {
    return `You are creating user story names for code flows.

## REQUIRED Name Format
"[stakeholder] [verb]s [entity]"

Rules:
- Stakeholder MUST come first (user, admin, system, developer, external)
- Verb MUST match the action type:
  - view → views, lists, browses
  - create → creates, adds, registers
  - update → updates, edits, modifies
  - delete → deletes, removes
  - process → processes, logs into, authenticates
- Entity MUST be derived from the actual code — use the target_entity from the flow data
- All lowercase sentence format

## Examples

GOOD:
- "user views item list"
- "admin creates new record"
- "user updates account details"
- "user deletes draft entry"
- "user logs into system"

BAD (DO NOT produce):
- "ItemFlow" ❌ (wrong format)
- "Record Management" ❌ (too vague)
- "views items" ❌ (missing stakeholder)
- "User Creates Record" ❌ (wrong case)

## Output
\`\`\`csv
entry_point,name,description
handleItemCreate::create,"admin creates new item","Validates and persists item record"
ListView::view,"user views item list","Displays available items with filters"
handleRemove::delete,"user deletes record","Removes record after confirmation"
\`\`\`

IMPORTANT: The entry_point column MUST match the entry point value from the input exactly (including the ::actionType suffix). This is used to match responses back to flows.`;
  }

  private buildEnhancementUserPrompt(
    flows: FlowSuggestion[],
    interactionMap: Map<number, InteractionWithPaths>
  ): string {
    const flowDescriptions = flows
      .map((f, i) => {
        const steps = f.interactionIds
          .map((id) => {
            const interaction = interactionMap.get(id);
            return interaction ? `${interaction.fromModulePath} → ${interaction.toModulePath}` : '?';
          })
          .join(' → ');

        const actor = this.stakeholderToActor(f.stakeholder).toLowerCase();

        const defStepInfo =
          f.definitionSteps.length > 0
            ? `\n   Definition path: ${f.definitionSteps.map((s) => `def#${s.fromDefinitionId}→def#${s.toDefinitionId}`).join(' → ')}`
            : '';

        const actionLine = f.actionType ? `Action: ${f.actionType}` : 'Action: unknown';
        const entityLine = f.targetEntity ? `Entity: ${f.targetEntity}` : 'Entity: (derive from code context)';

        return `${i + 1}. ${actionLine}, ${entityLine}, Actor: ${actor}\n   Entry: ${f.entryPath}::${f.actionType || 'unknown'}\n   Steps: ${steps}${defStepInfo}`;
      })
      .join('\n\n');

    return `## Flows to Enhance (${flows.length})

${flowDescriptions}

Provide enhanced names and descriptions for each flow in CSV format.
IMPORTANT: Follow the exact format "[stakeholder] [verb]s [entity]" - all lowercase.`;
  }

  private stakeholderToActor(stakeholder: string): string {
    switch (stakeholder) {
      case 'admin':
        return 'Admin';
      case 'user':
        return 'User';
      case 'system':
        return 'System';
      case 'developer':
        return 'Developer';
      case 'external':
        return 'External service';
      default:
        return 'User';
    }
  }

  private parseEnhancedFlowsCSV(response: string, originalFlows: FlowSuggestion[]): FlowSuggestion[] {
    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('entry_point'));

    // Build a lookup from entry_point value → parsed enhancement
    const enhancementByKey = new Map<string, { name: string; description: string }>();
    for (const line of lines) {
      const fields = parseRow(line);
      if (!fields || fields.length < 3) continue;

      const entryPoint = fields[0].trim().replace(/"/g, '');
      const name = fields[1].trim().replace(/"/g, '');
      const description = fields[2].trim().replace(/"/g, '');

      if (entryPoint && name) {
        enhancementByKey.set(entryPoint, { name, description });
      }
    }

    const validStakeholders: Record<string, FlowSuggestion['stakeholder']> = {
      user: 'user',
      admin: 'admin',
      system: 'system',
      developer: 'developer',
      external: 'external',
    };

    // Match each original flow to its enhancement by entry_point key
    return originalFlows.map((original) => {
      // Try matching by entryPath::actionType (the compound key we emit in the user prompt)
      const key = `${original.entryPath}::${original.actionType || 'unknown'}`;
      const enhancement = enhancementByKey.get(key);
      if (!enhancement) return original;

      const newName = enhancement.name;
      const newSlug = newName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const firstWord = newName.split(' ')[0]?.toLowerCase();
      const derivedStakeholder = validStakeholders[firstWord] ?? null;

      return {
        ...original,
        name: newName || original.name,
        slug: newSlug || original.slug,
        description: enhancement.description || original.description,
        ...(derivedStakeholder ? { stakeholder: derivedStakeholder } : {}),
      };
    });
  }
}
