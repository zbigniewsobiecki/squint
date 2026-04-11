import type { Command } from '@oclif/core';
import type { IndexDatabase } from '../../../db/database-facade.js';
import type { EnrichedModuleCallEdge } from '../../../db/schema.js';
import { parseRow } from '../../llm/_shared/csv-utils.js';
import { completeWithLogging } from '../../llm/_shared/llm-utils.js';

export interface InteractionSuggestion {
  fromModuleId: number;
  toModuleId: number;
  fromModulePath: string;
  toModulePath: string;
  semantic: string;
  pattern: 'utility' | 'business' | 'test-internal';
  symbols: string[];
  weight: number;
}

/**
 * Generate semantic descriptions for module edges using LLM.
 */
export async function generateAstSemantics(
  edges: EnrichedModuleCallEdge[],
  model: string,
  db: IndexDatabase,
  command: Command,
  isJson: boolean,
  batchIdx: number,
  totalBatches: number
): Promise<InteractionSuggestion[]> {
  const systemPrompt = `You are a software architect analyzing module-level dependencies.

For each module-to-module interaction, provide a semantic description of what the interaction does.

Output format - respond with ONLY a CSV table:

\`\`\`csv
from_module,to_module,semantic
project.controllers,project.services.auth,"Controllers delegate authentication logic to the auth service for credential validation"
\`\`\`

Guidelines:
- Describe WHY the source module calls the target module
- For UTILITY patterns: use generic descriptions like "Uses logging utilities", "Accesses database layer"
- For BUSINESS patterns: be specific about the business action (e.g., "Processes incoming requests", "Validates user credentials")
- Keep descriptions concise (under 80 chars)
- Focus on the business purpose, not implementation details
- **Describe the architectural USE, not the literal import statement.** If the only static evidence is an import, infer how the imported symbol is used: "guards endpoints with middleware", "delegates to the service", "validates with the schema". Never write "imports X" or "uses an import statement".`;

  // Build module lookup for descriptions
  const allModules = db.modules.getAll();
  const moduleMap = new Map(allModules.map((m) => [m.id, m]));

  // PR1/4: For each target module, look up the called symbols' `purpose`
  // annotations from the symbols stage so the LLM has architectural context
  // (not just bare names + import locations). Without these, the LLM was
  // describing edges as "imports X" instead of "guards endpoints with X".
  // Cache per-module to avoid duplicate queries when multiple edges point at
  // the same target module within a single batch.
  const PURPOSE_CHAR_BUDGET = 120;
  const purposeCache = new Map<number, Map<string, string>>();
  const purposesForTargetModule = (toModuleId: number): Map<string, string> => {
    const cached = purposeCache.get(toModuleId);
    if (cached) return cached;

    const members = db.modules.getSymbols(toModuleId);
    const defIds = members.map((m) => m.id);
    const purposes = db.metadata.getValuesByKey(defIds, 'purpose');
    const byName = new Map<string, string>();
    for (const m of members) {
      const purpose = purposes.get(m.id);
      if (purpose) {
        const truncated =
          purpose.length > PURPOSE_CHAR_BUDGET ? `${purpose.slice(0, PURPOSE_CHAR_BUDGET - 1)}…` : purpose;
        byName.set(m.name, truncated);
      }
    }
    purposeCache.set(toModuleId, byName);
    return byName;
  };

  // Build edge descriptions with symbol details and module context
  const edgeDescriptions = edges
    .map((e, i) => {
      const purposesByName = purposesForTargetModule(e.toModuleId);
      const symbolList = e.calledSymbols
        .map((s) => {
          const purpose = purposesByName.get(s.name);
          const purposeSuffix = purpose ? ` — purpose: "${purpose}"` : '';
          return `${s.name} (${s.kind}, ${s.callCount} calls)${purposeSuffix}`;
        })
        .join(', ');
      const patternInfo = `[${e.edgePattern.toUpperCase()}]`;
      const fromMod = moduleMap.get(e.fromModuleId);
      const toMod = moduleMap.get(e.toModuleId);
      const fromDesc = fromMod ? `${fromMod.name}${fromMod.description ? ` - ${fromMod.description}` : ''}` : '';
      const toDesc = toMod ? `${toMod.name}${toMod.description ? ` - ${toMod.description}` : ''}` : '';

      let desc = `${i + 1}. ${patternInfo} ${e.fromModulePath} → ${e.toModulePath} (${e.weight} calls)`;
      if (fromDesc) desc += `\n   From: "${fromDesc}"`;
      if (toDesc) desc += `\n   To: "${toDesc}"`;
      desc += `\n   Symbols: ${symbolList}`;
      return desc;
    })
    .join('\n');

  const userPrompt = `## Module Interactions to Describe (${edges.length})

${edgeDescriptions}

Generate semantic descriptions for each interaction in CSV format.`;

  const response = await completeWithLogging({
    model,
    systemPrompt,
    userPrompt,
    temperature: 0,
    maxTokens: 4096,
    command,
    isJson,
    iteration: { current: batchIdx, max: totalBatches },
  });

  return parseInteractionCSV(response, edges);
}

/**
 * Parse LLM CSV response into interaction suggestions.
 */
function parseInteractionCSV(response: string, edges: EnrichedModuleCallEdge[]): InteractionSuggestion[] {
  const results: InteractionSuggestion[] = [];

  // Find CSV block
  const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
  const csvContent = csvMatch ? csvMatch[1] : response;

  const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('from_module'));

  for (const line of lines) {
    const fields = parseRow(line);
    if (!fields || fields.length < 3) continue;

    const [fromPath, toPath, semantic] = fields;

    // Find matching edge
    const edge =
      edges.find((e) => e.fromModulePath === fromPath && e.toModulePath === toPath) ||
      edges.find((e) => e.fromModulePath.endsWith(fromPath) && e.toModulePath.endsWith(toPath));

    if (edge) {
      results.push({
        fromModuleId: edge.fromModuleId,
        toModuleId: edge.toModuleId,
        fromModulePath: edge.fromModulePath,
        toModulePath: edge.toModulePath,
        semantic: semantic.trim().replace(/"/g, ''),
        pattern: edge.edgePattern,
        symbols: edge.calledSymbols.map((s) => s.name),
        weight: edge.weight,
      });
    }
  }

  // Add defaults for any edges not covered
  for (const edge of edges) {
    if (!results.find((r) => r.fromModuleId === edge.fromModuleId && r.toModuleId === edge.toModuleId)) {
      results.push(createDefaultInteraction(edge));
    }
  }

  return results;
}

/**
 * Create a default interaction from an edge when LLM fails.
 */
export function createDefaultInteraction(edge: EnrichedModuleCallEdge): InteractionSuggestion {
  const fromLast = edge.fromModulePath.split('.').pop() ?? 'source';
  const toLast = edge.toModulePath.split('.').pop() ?? 'target';

  return {
    fromModuleId: edge.fromModuleId,
    toModuleId: edge.toModuleId,
    fromModulePath: edge.fromModulePath,
    toModulePath: edge.toModulePath,
    semantic: `${fromLast} uses ${toLast}`,
    pattern: edge.edgePattern,
    symbols: edge.calledSymbols.map((s) => s.name),
    weight: edge.weight,
  };
}
