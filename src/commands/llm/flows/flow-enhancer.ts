/**
 * FlowEnhancer - LLM metadata enhancement for flows.
 * Enriches flow suggestions with better names and descriptions using LLM.
 */

import type { Command } from '@oclif/core';
import { LLMist } from 'llmist';
import type { InteractionWithPaths } from '../../../db/schema.js';
import { parseCSVLine } from '../_shared/csv-utils.js';
import { type LlmLogOptions, logLlmRequest, logLlmResponse } from '../_shared/llm-utils.js';
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
    const interactionMap = new Map(interactions.map((i) => [i.id, i]));

    const systemPrompt = this.buildEnhancementSystemPrompt();
    const userPrompt = this.buildEnhancementUserPrompt(flows, interactionMap);

    const logOptions: LlmLogOptions = {
      showRequests: llmOptions.showLlmRequests,
      showResponses: llmOptions.showLlmResponses,
      isJson: this.isJson,
    };

    logLlmRequest(this.command, 'enhanceFlowsWithLLM', systemPrompt, userPrompt, logOptions);

    const response = await LLMist.complete(userPrompt, {
      model,
      systemPrompt,
      temperature: 0,
    });

    logLlmResponse(this.command, 'enhanceFlowsWithLLM', response, logOptions);

    return this.parseEnhancedFlowsCSV(response, flows);
  }

  private buildEnhancementSystemPrompt(): string {
    return `You are creating user story names for code flows.

## REQUIRED Name Format
"[stakeholder] [verb]s [entity]"

Rules:
- Stakeholder MUST come first (user, admin, salesperson, system, developer)
- Verb MUST match the action type:
  - view → views, lists, browses
  - create → creates, adds, registers
  - update → updates, edits, modifies
  - delete → deletes, removes
  - process → processes, logs into, authenticates
- Entity MUST be singular and specific (customer, vehicle, sale)
- All lowercase sentence format

## Examples

GOOD:
- "user views customer list"
- "admin creates new vehicle"
- "salesperson updates sale details"
- "user deletes draft order"
- "user logs into system"

BAD (DO NOT produce):
- "CustomerFlow" ❌ (wrong format)
- "Vehicle Management" ❌ (too vague)
- "views customers" ❌ (missing stakeholder)
- "User Creates Customer" ❌ (wrong case)

## Output
\`\`\`csv
entry_point,name,description
handleCustomerCreate,"admin creates new customer","Validates and persists customer record"
VehicleList,"user views vehicle inventory","Displays available vehicles with filters"
handleDelete,"user deletes customer","Removes customer after confirmation"
\`\`\``;
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
        const entityLine = f.targetEntity ? `Entity: ${f.targetEntity}` : 'Entity: unknown';

        return `${i + 1}. ${actionLine}, ${entityLine}, Actor: ${actor}\n   Entry: ${f.entryPath}\n   Steps: ${steps}${defStepInfo}`;
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
    const results: FlowSuggestion[] = [];

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('entry_point'));

    for (let i = 0; i < originalFlows.length; i++) {
      const original = originalFlows[i];

      if (i < lines.length) {
        const fields = parseCSVLine(lines[i]);
        if (fields.length >= 3) {
          const newName = fields[1].trim().replace(/"/g, '');
          const newSlug = newName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

          results.push({
            ...original,
            name: newName || original.name,
            slug: newSlug || original.slug,
            description: fields[2].trim().replace(/"/g, '') || original.description,
          });
          continue;
        }
      }

      results.push(original);
    }

    return results;
  }
}
