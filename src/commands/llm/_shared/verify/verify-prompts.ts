/**
 * Prompt templates for LLM-based verification of annotations and relationships.
 */

export function buildAnnotationVerifySystemPrompt(): string {
  return `You are a code analyst verifying the accuracy of existing annotations on TypeScript/JavaScript symbols.

## Your Task
For each symbol, compare its source code against the provided annotations and report whether each annotation is correct.

## Checks
- **purpose**: Does the description accurately capture what the code does and why?
- **domain**: Are the domain tags relevant to the code's problem area?
- **pure**: Is the purity annotation correct? ("true" only if fully deterministic with no side effects)

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
definition_id,check,verdict,reason
100,purpose,correct,"accurately describes the authentication handler"
100,domain,wrong,"code handles HTTP routing not database access"
100,pure,correct,"correctly marked as impure due to HTTP calls"
207,purpose,suspect,"description is vague and misses the validation logic"
\`\`\`

## Columns
- **definition_id**: numeric ID of the definition
- **check**: the aspect being verified (purpose, domain, pure)
- **verdict**: "correct", "wrong", or "suspect"
- **reason**: brief explanation of the verdict

## Guidelines
- "correct" — annotation accurately reflects the code
- "wrong" — annotation is clearly incorrect or misleading
- "suspect" — annotation is questionable, vague, or partially incorrect
- Check purpose descriptions against what the code actually does, not what it might do
- Check domain tags against the actual problem area the code addresses
- Check pure annotations strictly: any I/O, mutation, or non-determinism means impure`;
}

export function buildRelationshipVerifySystemPrompt(): string {
  return `You are a code analyst verifying the accuracy of existing relationship annotations between TypeScript/JavaScript symbols.

## Your Task
For each annotated relationship (from → to), verify:
1. The source symbol actually references/uses the target symbol in its code
2. The semantic description accurately captures how/why the source uses the target
3. The relationship type (uses/extends/implements) is correct

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
from_id,to_id,verdict,reason
100,207,correct,"source clearly calls the validation function as described"
100,53,wrong,"source does not reference this symbol anywhere in its code"
88,42,suspect,"relationship exists but description is misleading"
\`\`\`

## Columns
- **from_id**: numeric ID of the source definition
- **to_id**: numeric ID of the target definition
- **verdict**: "correct", "wrong", or "suspect"
- **reason**: brief explanation

## Guidelines
- "correct" — relationship exists and description is accurate
- "wrong" — relationship doesn't exist in code, or description is clearly incorrect
- "suspect" — relationship is questionable or description is vague/misleading`;
}

export function buildAnnotationVerifyUserPrompt(
  symbols: Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    endLine: number;
    sourceCode: string;
    annotations: Record<string, string>;
  }>,
  aspects: string[]
): string {
  const parts: string[] = [];

  parts.push(`## Symbols to Verify (${symbols.length})`);
  parts.push('');

  for (const symbol of symbols) {
    parts.push(`### #${symbol.id}: ${symbol.name} (${symbol.kind})`);
    const lineRange = symbol.line === symbol.endLine ? `${symbol.line}` : `${symbol.line}-${symbol.endLine}`;
    parts.push(`File: ${symbol.filePath}:${lineRange}`);
    parts.push('');

    parts.push('Current annotations:');
    for (const aspect of aspects) {
      const value = symbol.annotations[aspect];
      if (value) {
        parts.push(`- ${aspect}: ${value}`);
      }
    }
    parts.push('');

    parts.push('Source Code:');
    parts.push('```typescript');
    parts.push(symbol.sourceCode);
    parts.push('```');
    parts.push('');
  }

  parts.push(`Verify each annotation (${aspects.join(', ')}) for each symbol. Output CSV with one row per check.`);

  return parts.join('\n');
}

export function buildRelationshipVerifyUserPrompt(
  groups: Array<{
    fromId: number;
    fromName: string;
    fromKind: string;
    filePath: string;
    sourceCode: string;
    relationships: Array<{
      toId: number;
      toName: string;
      toKind: string;
      semantic: string;
      relationshipType: string;
    }>;
  }>
): string {
  const parts: string[] = [];

  parts.push(`## Relationships to Verify (${groups.length} source symbols)`);
  parts.push('');

  for (const group of groups) {
    parts.push(`### Source: #${group.fromId} ${group.fromName} (${group.fromKind})`);
    parts.push(`File: ${group.filePath}`);
    parts.push('');

    parts.push('Annotated relationships:');
    for (const rel of group.relationships) {
      parts.push(`- [${rel.relationshipType}] → ${rel.toName} (#${rel.toId}): "${rel.semantic}"`);
    }
    parts.push('');

    parts.push('Source Code:');
    parts.push('```typescript');
    parts.push(group.sourceCode);
    parts.push('```');
    parts.push('');
  }

  parts.push('Verify each relationship. Output CSV with one row per relationship.');

  return parts.join('\n');
}
