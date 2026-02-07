/**
 * Prompt templates for LLM annotation.
 */

import type { DependencyWithMetadata } from '../../../db/database.js';

export interface SymbolContext {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  sourceCode: string;
  dependencies: DependencyWithMetadata[];
}

export interface CoverageInfo {
  aspect: string;
  covered: number;
  total: number;
  percentage: number;
}

/**
 * Aspect descriptions for the system prompt.
 */
const ASPECT_DESCRIPTIONS: Record<string, string> = {
  purpose: 'A concise 1-2 sentence description of what the symbol does and why it exists.',
  domain: 'A JSON array of domain tags (e.g., ["parsing", "validation"]). Use lowercase, hyphenated names.',
  role: 'The architectural role (e.g., "controller", "utility", "model", "service", "factory", "adapter").',
  pure: `"true" only if purely functional (deterministic, no side effects). "false" if it: creates objects with mutable state, returns closures with internal state, uses vi.fn()/mock factories, or performs I/O. Most factory functions are NOT pure.`,
};

/**
 * Build the system prompt for annotation.
 */
export function buildSystemPrompt(aspects: string[]): string {
  const aspectDescs = aspects
    .map(a => `- **${a}**: ${ASPECT_DESCRIPTIONS[a] || 'A descriptive value for this aspect.'}`)
    .join('\n');

  return `You are a code analyst annotating TypeScript/JavaScript code.

## Your Task
For each symbol, analyze its source code and provide:
1. Symbol metadata (the requested aspects)
2. Relationship descriptions for each outgoing dependency listed

## Aspects to Annotate
${aspectDescs}

## Output Format
Respond with **only** a CSV table with this exact format:

\`\`\`csv
type,id,field,value
symbol,42,purpose,"Handles user authentication requests"
symbol,42,domain,"[""auth"",""http""]"
symbol,42,role,"controller"
symbol,42,pure,"false"
relationship,42,15,"delegates authentication logic to service layer"
relationship,42,23,"uses password utility for secure hashing"
symbol,43,purpose,"Business logic for user login"
symbol,43,domain,"[""auth"",""business-logic""]"
relationship,43,8,"queries user data from database model"
\`\`\`

## CSV Columns
- **type**: "symbol" or "relationship"
- **id**: symbol ID (for symbol rows) or from_id (for relationship rows)
- **field**: aspect name (for symbols) or to_id (for relationships)
- **value**: the annotation value

## CSV Rules
- Header row must be exactly: type,id,field,value
- Values containing commas, quotes, or newlines must be double-quoted
- Escape quotes within values by doubling them ("")
- domain values must be valid JSON arrays of strings
- pure values must be exactly "true" or "false"

## Relationship Descriptions
- Explain WHY the source symbol uses the target (1-2 sentences)
- Focus on the semantic purpose, not just "calls" or "uses"
- Example: "validates user credentials before generating session token"

## Guidelines
- Use dependency annotations to understand what a symbol builds upon
- For pure: use "false" unless the function is fully deterministic with no side effects
  - Factory functions that create instances (vi.fn(), mock factories, middleware factories): false
  - Functions returning closures with mutable state: false
  - Database/HTTP/file operations: false
  - Functions that create objects with internal state: false
  - Type definitions, interfaces, enums: true
  - Simple data transformations without mutation: true
- For domain: pick 1-3 relevant domain tags that describe the problem area
- For role: identify the architectural pattern the symbol represents
- If unsure, make your best informed judgment based on the code`;
}

/**
 * Build the user prompt for a batch of symbols.
 */
export function buildUserPrompt(
  symbols: SymbolContext[],
  aspects: string[],
  coverage: CoverageInfo[],
): string {
  const parts: string[] = [];

  // Coverage section
  if (coverage.length > 0) {
    parts.push('## Current Coverage');
    for (const c of coverage) {
      parts.push(`${c.aspect}: ${c.covered}/${c.total} (${c.percentage.toFixed(1)}%)`);
    }
    parts.push('');
  }

  // Symbols section
  parts.push(`## Symbols to Annotate (${symbols.length})`);
  parts.push('');

  for (const symbol of symbols) {
    parts.push(`### #${symbol.id}: ${symbol.name} (${symbol.kind})`);

    // File location
    const lineRange = symbol.line === symbol.endLine
      ? `${symbol.line}`
      : `${symbol.line}-${symbol.endLine}`;
    parts.push(`File: ${symbol.filePath}:${lineRange}`);
    parts.push('');

    // Dependencies with their annotations
    if (symbol.dependencies.length === 0) {
      parts.push('Dependencies: none');
    } else {
      parts.push('Dependencies (with their annotations):');
      for (const dep of symbol.dependencies) {
        const annotation = dep.aspectValue
          ? `"${dep.aspectValue}"`
          : '(not yet annotated)';
        parts.push(`- ${dep.name} (${dep.kind}): ${annotation}`);
      }
    }
    parts.push('');

    // Source code
    parts.push('Source Code:');
    parts.push('```typescript');
    parts.push(symbol.sourceCode);
    parts.push('```');
    parts.push('');
  }

  // Request
  parts.push(`Respond with CSV annotations for: ${aspects.join(', ')}`);

  return parts.join('\n');
}

/**
 * Build user prompt with enhanced dependency context (multiple aspects).
 */
export function buildUserPromptEnhanced(
  symbols: SymbolContextEnhanced[],
  aspects: string[],
  coverage: CoverageInfo[],
): string {
  const parts: string[] = [];

  // Coverage section
  if (coverage.length > 0) {
    parts.push('## Current Coverage');
    for (const c of coverage) {
      parts.push(`${c.aspect}: ${c.covered}/${c.total} (${c.percentage.toFixed(1)}%)`);
    }
    parts.push('');
  }

  // Symbols section
  parts.push(`## Symbols to Annotate (${symbols.length})`);
  parts.push('');

  for (const symbol of symbols) {
    parts.push(`### #${symbol.id}: ${symbol.name} (${symbol.kind})`);

    // File location
    const lineRange = symbol.line === symbol.endLine
      ? `${symbol.line}`
      : `${symbol.line}-${symbol.endLine}`;
    parts.push(`File: ${symbol.filePath}:${lineRange}`);
    parts.push('');

    // Dependencies with all their annotations (already annotated)
    if (symbol.dependencies.length === 0) {
      parts.push('Dependencies (already annotated): none');
    } else {
      parts.push('Dependencies (already annotated):');
      for (const dep of symbol.dependencies) {
        const annotations: string[] = [];
        if (dep.purpose) {
          annotations.push(`"${dep.purpose}"`);
        }
        if (dep.domains && dep.domains.length > 0) {
          annotations.push(`domains: ${JSON.stringify(dep.domains)}`);
        }
        if (dep.role) {
          annotations.push(`role: "${dep.role}"`);
        }
        if (dep.pure !== null) {
          annotations.push(`pure: ${dep.pure}`);
        }

        const annotationStr = annotations.length > 0
          ? annotations.join(' ')
          : '(not yet annotated)';
        parts.push(`- ${dep.name} (#${dep.id}): ${annotationStr}`);
      }
    }
    parts.push('');

    // Relationships to annotate
    if (symbol.relationshipsToAnnotate.length > 0) {
      parts.push('Relationships to annotate:');
      for (const rel of symbol.relationshipsToAnnotate) {
        parts.push(`- → ${rel.toName} (#${rel.toId}) at line ${rel.usageLine}`);
      }
      parts.push('');
    }

    // Source code
    parts.push('Source Code:');
    parts.push('```typescript');
    parts.push(symbol.sourceCode);
    parts.push('```');
    parts.push('');
  }

  // Request
  parts.push(`Annotate aspects: ${aspects.join(', ')}`);
  parts.push('Include relationship annotations for all listed dependencies.');

  return parts.join('\n');
}

export interface DependencyContextEnhanced {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  purpose: string | null;
  domains: string[] | null;
  role: string | null;
  pure: boolean | null;
}

/**
 * Relationship to annotate (outgoing edge from symbol to dependency).
 */
export interface RelationshipToAnnotate {
  toId: number;
  toName: string;
  toKind: string;
  usageLine: number;
}

export interface SymbolContextEnhanced {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  sourceCode: string;
  dependencies: DependencyContextEnhanced[];
  relationshipsToAnnotate: RelationshipToAnnotate[];
}
