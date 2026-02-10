/**
 * FeatureGrouper - Groups flows into product-level features using LLM.
 * Reads persisted flows + module tree, sends to LLM for grouping, validates result.
 */

import type { Command } from '@oclif/core';
import type { Flow, Module } from '../../../db/schema.js';
import { extractCsvContent, parseRow, splitCsvLines } from '../_shared/csv-utils.js';
import { type LlmLogOptions, completeWithLogging, logLlmRequest, logLlmResponse } from '../_shared/llm-utils.js';
import type { LlmOptions } from '../flows/types.js';
import type { FeatureSuggestion } from './types.js';

export class FeatureGrouper {
  constructor(
    private readonly command: Command,
    private readonly isJson: boolean
  ) {}

  /**
   * Group flows into product-level features using LLM.
   */
  async groupFlowsIntoFeatures(
    flows: Flow[],
    modules: Module[],
    model: string,
    llmOptions: LlmOptions
  ): Promise<FeatureSuggestion[]> {
    const flowSlugs = new Set(flows.map((f) => f.slug));

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(flows, modules);

    const logOptions: LlmLogOptions = {
      showRequests: llmOptions.showLlmRequests,
      showResponses: llmOptions.showLlmResponses,
      isJson: this.isJson,
    };

    logLlmRequest(this.command, 'groupFlowsIntoFeatures', systemPrompt, userPrompt, logOptions);

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      command: this.command,
      isJson: this.isJson,
    });

    logLlmResponse(this.command, 'groupFlowsIntoFeatures', response, logOptions);

    const result = FeatureGrouper.parseFeatureCSV(response, flowSlugs);

    if (result.errors.length > 0) {
      // Retry once with error feedback
      const retryUserPrompt = this.buildRetryPrompt(userPrompt, result.errors);
      logLlmRequest(this.command, 'groupFlowsIntoFeatures (retry)', systemPrompt, retryUserPrompt, logOptions);

      const retryResponse = await completeWithLogging({
        model,
        systemPrompt,
        userPrompt: retryUserPrompt,
        temperature: 0,
        command: this.command,
        isJson: this.isJson,
      });

      logLlmResponse(this.command, 'groupFlowsIntoFeatures (retry)', retryResponse, logOptions);

      const retryResult = FeatureGrouper.parseFeatureCSV(retryResponse, flowSlugs);
      if (retryResult.errors.length > 0) {
        throw new Error(`Feature grouping validation failed after retry: ${retryResult.errors.join('; ')}`);
      }
      return retryResult.features;
    }

    return result.features;
  }

  private buildSystemPrompt(): string {
    return `You are a product analyst grouping code flows into product-level features.

## Task
Given a list of user journey flows and a module tree, group the flows into product-level features.

## Rules
- Each flow belongs to EXACTLY ONE feature
- Every flow must be assigned — no orphans
- Feature names should be product-level (e.g., "Customer Management", "Authentication & Security")
- Group by product capability, not just entity
- Atomic (tier-0) flows should be assigned to the feature they support, or grouped into an "Internal Infrastructure" feature if they don't clearly belong elsewhere
- Aim for 4-8 features for a typical application
- Feature slugs should be kebab-case (e.g., "customer-management")

## Output Format
Respond with ONLY a CSV (no markdown fences, no explanation).

Header row:
feature_slug,feature_name,feature_description,flow_slugs

Rules:
- feature_slug: kebab-case identifier
- feature_name: Human-readable name in quotes
- feature_description: Brief description in quotes
- flow_slugs: pipe-delimited list of flow slugs in quotes (e.g., "flow-a|flow-b|flow-c")
- Every flow slug from the input must appear in exactly one row`;
  }

  buildUserPrompt(flows: Flow[], modules: Module[]): string {
    const flowLines = flows
      .map((f) => {
        const parts = [
          `slug=${f.slug}`,
          `name="${f.name}"`,
          f.actionType ? `action=${f.actionType}` : null,
          f.targetEntity ? `entity=${f.targetEntity}` : null,
          f.stakeholder ? `stakeholder=${f.stakeholder}` : null,
          `tier=${f.tier}`,
          f.description ? `desc="${f.description}"` : null,
        ].filter(Boolean);
        return parts.join(', ');
      })
      .join('\n');

    const moduleTree = this.buildModuleTreeText(modules);

    return `## Flows (${flows.length} total)

${flowLines}

## Module Tree

${moduleTree}

Group these flows into product-level features. Output CSV only.`;
  }

  private buildModuleTreeText(modules: Module[]): string {
    const sorted = [...modules].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    return sorted.map((m) => `${'  '.repeat(m.depth)}${m.slug} (${m.fullPath})`).join('\n');
  }

  private buildRetryPrompt(originalPrompt: string, errors: string[]): string {
    return `${originalPrompt}

## PREVIOUS ATTEMPT FAILED - Please fix these errors:
${errors.map((e) => `- ${e}`).join('\n')}

Output the corrected CSV only.`;
  }

  /**
   * Parse LLM CSV response into FeatureSuggestion[].
   * Validates that every flow slug is assigned to exactly one feature.
   */
  static parseFeatureCSV(
    response: string,
    validFlowSlugs: Set<string>
  ): { features: FeatureSuggestion[]; errors: string[] } {
    const errors: string[] = [];
    const features: FeatureSuggestion[] = [];
    const assignedSlugs = new Set<string>();

    const csv = extractCsvContent(response);
    const lines = splitCsvLines(csv);

    if (lines.length === 0) {
      errors.push('Empty CSV content');
      return { features, errors };
    }

    // Skip header row
    const startIdx = lines[0].toLowerCase().includes('feature_slug') ? 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseRow(line);
      if (!cols || cols.length < 4) {
        errors.push(`Line ${i + 1}: Expected 4 columns, got ${cols?.length ?? 0}`);
        continue;
      }

      const slug = cols[0].trim();
      const name = cols[1].trim();
      const description = cols[2].trim();
      const flowSlugsRaw = cols[3].trim();

      if (!slug || !name) {
        errors.push(`Line ${i + 1}: Missing feature slug or name`);
        continue;
      }

      const flowSlugs = flowSlugsRaw
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);

      if (flowSlugs.length === 0) {
        errors.push(`Feature "${name}": No flow slugs assigned`);
        continue;
      }

      // Check for hallucinated flow slugs
      const hallucinated = flowSlugs.filter((s) => !validFlowSlugs.has(s));
      if (hallucinated.length > 0) {
        errors.push(`Feature "${name}": Unknown flow slugs: ${hallucinated.join(', ')}`);
        continue;
      }

      // Check for duplicate assignments
      const duplicates = flowSlugs.filter((s) => assignedSlugs.has(s));
      if (duplicates.length > 0) {
        errors.push(`Feature "${name}": Flow slugs already assigned to another feature: ${duplicates.join(', ')}`);
        continue;
      }

      for (const s of flowSlugs) {
        assignedSlugs.add(s);
      }

      features.push({ name, slug, description, flowSlugs });
    }

    // Check for orphaned flows
    const orphaned = [...validFlowSlugs].filter((s) => !assignedSlugs.has(s));
    if (orphaned.length > 0) {
      errors.push(`Orphaned flows not assigned to any feature: ${orphaned.join(', ')}`);
    }

    return { features, errors };
  }
}
