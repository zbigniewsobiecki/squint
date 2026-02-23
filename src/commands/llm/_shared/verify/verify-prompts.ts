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

export function buildModuleAssignmentVerifySystemPrompt(): string {
  return `You are a software architect verifying module assignments in a TypeScript/JavaScript codebase.

## Your Task
For each symbol, check whether its current module assignment is semantically appropriate.
A symbol should be in a module that matches its functional domain and architectural role.

## What to Flag
- **wrong**: A symbol clearly belongs to a different domain than its assigned module.
  Example: A health check controller assigned to a "Customer API" module.
  Example: A logging utility assigned to a "Sales Service" module.
- **suspect**: The assignment is questionable but not clearly wrong.
  Example: A shared validation helper in a single-entity module.
- **correct**: The assignment makes sense given the symbol's code and the module's purpose.

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
definition_id,verdict,reason,suggested_module_path
100,correct,"controller handles customer CRUD operations which matches the Customer API module",
207,wrong,"health check endpoint is infrastructure not customer-specific — belongs in a system/infrastructure module",project.backend.infrastructure
88,suspect,"generic error handler could be in shared utilities instead of a single entity module",
\`\`\`

## Columns
- **definition_id**: numeric ID of the definition
- **verdict**: "correct", "wrong", or "suspect"
- **reason**: brief explanation
- **suggested_module_path**: (optional) better module path if verdict is wrong/suspect — leave empty if correct

## Guidelines
- Focus on domain coherence: does the symbol's purpose match the module's domain?
- Consider file path as supporting evidence but rely primarily on the source code
- Infrastructure/cross-cutting concerns (health checks, logging, config, error handling) should NOT be in entity-specific modules
- Entity-specific code (customer controllers, vehicle services) should be in entity-matching modules
- Only flag clear mismatches — when in doubt, mark as "correct"`;
}

export function buildModuleAssignmentVerifyUserPrompt(
  items: Array<{
    defId: number;
    defName: string;
    defKind: string;
    filePath: string;
    sourceCode: string;
    moduleName: string;
    modulePath: string;
  }>,
  modules: Array<{ fullPath: string; name: string; description: string | null }>
): string {
  const parts: string[] = [];

  parts.push('## Available Modules');
  parts.push('');
  for (const mod of modules.slice(0, 50)) {
    const desc = mod.description ? ` - ${mod.description}` : '';
    parts.push(`- ${mod.fullPath}: ${mod.name}${desc}`);
  }
  parts.push('');

  parts.push(`## Assignments to Verify (${items.length})`);
  parts.push('');

  for (const item of items) {
    parts.push(`### #${item.defId}: ${item.defName} (${item.defKind})`);
    parts.push(`File: ${item.filePath}`);
    parts.push(`Assigned to: ${item.modulePath} (${item.moduleName})`);
    parts.push('');
    parts.push('Source Code:');
    parts.push('```typescript');
    parts.push(item.sourceCode);
    parts.push('```');
    parts.push('');
  }

  parts.push('Verify each assignment. Output CSV with one row per definition.');

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
