/**
 * Prompt templates for LLM annotation.
 */

export interface CoverageInfo {
  aspect: string;
  covered: number;
  total: number;
  percentage: number;
}

/**
 * Supported language identifiers for prompt parameterization.
 */
export type SupportedLanguage = 'typescript' | 'javascript' | 'ruby';

/**
 * Human-readable language label for use in prompts.
 */
function getLanguageLabel(language: SupportedLanguage): string {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return 'TypeScript/JavaScript';
    case 'ruby':
      return 'Ruby/Rails';
  }
}

/**
 * Aspect descriptions for the system prompt — TypeScript/JavaScript defaults.
 */
const ASPECT_DESCRIPTIONS: Record<string, string> = {
  purpose: 'A concise 1-2 sentence description of what the symbol does and why it exists.',
  domain: `A JSON array of 1-3 domain tags (e.g., ["parsing", "validation"]). Use lowercase, hyphenated names.
  - Derive domains from the symbol's actual functionality AND its file location/package
  - Use consistent naming: always plural OR singular (not both), no abbreviations (use "authentication" not "auth")
  - Avoid overly generic tags like "utility", "types", "configuration" unless the symbol is truly generic
  - Each symbol's domains should reflect ITS OWN context — do not copy domains from other symbols in this batch
  - A well-scoped project typically has 15-40 total domains. Prefer broad, reusable domain names over narrow, symbol-specific ones`,
  role: 'The architectural role (e.g., "controller", "utility", "model", "service", "factory", "adapter").',
  pure: `"true" only if purely functional (deterministic, no side effects). "false" if it: creates objects with mutable state, returns closures with internal state, uses vi.fn()/mock factories, or performs I/O. Most factory functions are NOT pure.
  - Functions returning \`new CustomClass(...)\` create new mutable instance identities each call → impure
  - Exception: constructing immutable value objects like Error subclasses (with only readonly/constructor fields) can be pure`,
  contracts: `JSON array of boundary communication contracts this definition participates in.
Each entry: {"protocol":"...", "role":"...", "key":"...", "normalizedKey":"...", "details":"..."}.

protocol: Any communication mechanism — free-form string (e.g., "http", "ws", "grpc", "queue", "pubsub", "event", "email", "file", "ipc", "cli", or any other).
role: One of: server/client, producer/consumer, emitter/listener, publisher/subscriber, sender/receiver, writer/reader.
key: The literal identifier as it appears in code (e.g., "/api/vehicles/:id", "vehicle:updated", "order-processing").
normalizedKey: A canonical form identical on both sides of the same channel.
  Strip variable segments, normalize casing, produce the same string a matching counterpart would.
  Examples: "GET /api/vehicles/:id" → "GET /api/vehicles/{param}", "VehicleService.GetVehicle" → "VehicleService/GetVehicle".
Return "null" if no external communication contracts.`,
};

/**
 * Ruby/Rails-specific overrides for aspect descriptions.
 */
const RUBY_ASPECT_DESCRIPTIONS: Record<string, string> = {
  role: 'The architectural role (e.g., "model", "controller", "serializer", "mailer", "job", "concern", "service", "utility", "factory", "adapter").',
  pure: `"true" only if purely functional (deterministic, no side effects). "false" if it: mutates instance variables (@ivar), interacts with ActiveRecord or the database, performs I/O, or relies on external state. Most Ruby methods are NOT pure.
  - Methods that set \`@ivar\` or call \`save\`/\`update\`/\`destroy\` → impure
  - Methods with \`render\`, \`redirect_to\`, or HTTP concerns → impure
  - Methods calling ActiveRecord finders (e.g., \`Model.find\`, \`Model.where\`) → impure
  - Exception: pure data transformations on plain Ruby objects with no side effects can be pure`,
};

/**
 * Get the aspect description for a given language, falling back to the TypeScript default.
 */
function getAspectDescription(aspect: string, language: SupportedLanguage): string {
  if (language === 'ruby') {
    return RUBY_ASPECT_DESCRIPTIONS[aspect] ?? ASPECT_DESCRIPTIONS[aspect] ?? 'A descriptive value for this aspect.';
  }
  return ASPECT_DESCRIPTIONS[aspect] ?? 'A descriptive value for this aspect.';
}

/**
 * Build language-specific pure function guidelines for the system prompt.
 */
function buildPureGuidelines(language: SupportedLanguage): string {
  if (language === 'ruby') {
    return `- For pure: use "false" unless the method is fully deterministic with no side effects
  - Methods that mutate instance variables (\`@ivar =\`, \`self.attr =\`): false
  - Methods calling ActiveRecord (finders, \`save\`, \`update\`, \`destroy\`, \`create\`): false
  - Methods with HTTP/IO concerns (\`render\`, \`redirect_to\`, file ops): false
  - Methods that call \`Time.now\`, \`Date.today\`, or \`rand\`: false
  - Simple data transformations on plain Ruby objects with no mutation: true
  - Common pure:false patterns — DO NOT mark these as pure:
    - \`@variable =\` anywhere in the method body → mutates instance state
    - Any ActiveRecord finder or persistence call → database I/O
    - \`render\` or \`redirect_to\` → HTTP side effect
    - \`Time.now\` or \`Date.today\` → non-deterministic
    - \`rand\` or \`SecureRandom.*\` → non-deterministic
    - \`File.*\` or IO operations → filesystem I/O`;
  }

  return `- For pure: use "false" unless the function is fully deterministic with no side effects
  - Factory functions that create instances (vi.fn(), mock factories, middleware factories): false
  - Functions returning closures with mutable state: false
  - Database/HTTP/file operations: false
  - Functions that create objects with internal state: false
    - Type definitions, interfaces, enums: true
  - Simple data transformations without mutation: true
  - Common pure:false patterns — DO NOT mark these as pure:
    - \`new Date()\` anywhere in the function body → non-deterministic
    - \`vi.fn()\` or \`jest.fn()\` → creates stateful mock
    - \`process.env.*\` or \`import.meta.env.*\` → reads external state
    - \`await anything\` → I/O side effect
    - \`localStorage.*\` or \`sessionStorage.*\` → browser storage I/O
    - \`useXxx()\` hooks → React stateful hooks
    - \`Math.random()\` → non-deterministic
    - Functions that return objects containing \`new Date()\` fields
    - Functions returning \`new CustomClass(...)\` — creates mutable instance identity`;
}

/**
 * Build the system prompt for annotation.
 */
export function buildSystemPrompt(aspects: string[], language: SupportedLanguage = 'typescript'): string {
  const aspectDescs = aspects.map((a) => `- **${a}**: ${getAspectDescription(a, language)}`).join('\n');

  const languageLabel = getLanguageLabel(language);

  const pureGuidelines = buildPureGuidelines(language);

  return `You are a code analyst annotating ${languageLabel} code.

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
symbol,100,purpose,"Handles user authentication requests"
symbol,100,domain,"[""auth"",""http""]"
symbol,100,role,"controller"
symbol,100,pure,"false"
relationship,100,207,"delegates authentication logic to service layer"
relationship,100,53,"uses password utility for secure hashing"
symbol,207,purpose,"Business logic for user login"
symbol,207,domain,"[""auth"",""business-logic""]"
relationship,207,88,"queries user data from database model"
relationship,207,12,"validates input against schema constraints"
\`\`\`

## CSV Columns
- **type**: "symbol" or "relationship"
- **id**: symbol ID (for symbol rows) or from_id (for relationship rows)
- **field**: **numeric to_id** (for relationship rows). Use the ID shown as \`(#N)\` in the dependency list, never the symbol name.
- **value**: the annotation value

## Relationship Rules
- The field column in relationship rows must be a **numeric ID** — e.g. for \`execAsync (#15)\`, write \`relationship,42,15,"..."\` not \`relationship,42,execAsync,"..."\`
- Only output relationship rows for pairs listed under "Relationships to annotate" — do not annotate context-only dependencies
- If you cannot determine an annotation for a relationship, **omit the row entirely** — never use "null" as an ID or value

## CSV Rules
- Header row must be exactly: type,id,field,value
- Values containing commas, quotes, or newlines must be double-quoted
- Escape quotes within values by doubling them ("")
- domain values must be valid JSON arrays of strings
- pure values must be exactly "true" or "false"

## Relationship Descriptions

The description depends on the relationship type:

**For 'uses' relationships (most common):**
- Explain WHY the source symbol uses the target (1-2 sentences)
- Focus on the semantic purpose, not just "calls" or "uses"
- Example: "validates user credentials before generating session token"

**For 'extends' relationships (class/interface inheritance):**
- Explain WHY this class inherits from the parent
- What behavior is extended or specialized?
- Example: "specializes base logger with JSON formatting for production monitoring"

**For 'implements' relationships (interface implementation):**
- Explain WHAT contract this class fulfills by implementing the interface
- Example: "provides database-backed storage conforming to the Repository pattern"

## Guidelines
- Use dependency annotations to understand what a symbol builds upon
${pureGuidelines}
- For domain: pick 1-3 relevant domain tags that describe the problem area
- For role: identify the architectural pattern the symbol represents
- If unsure, make your best informed judgment based on the code`;
}

/**
 * Build user prompt with enhanced dependency context (multiple aspects).
 */
export function buildUserPromptEnhanced(
  symbols: SymbolContextEnhanced[],
  aspects: string[],
  coverage: CoverageInfo[],
  language: SupportedLanguage = 'typescript',
  existingDomains?: string[]
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

  // Existing domains guidance (for domain taxonomy consistency)
  if (existingDomains && existingDomains.length > 0 && aspects.includes('domain')) {
    parts.push('## Existing Domain Tags');
    parts.push(
      'Prefer reusing these existing domain tags when applicable. Only introduce a new domain if none of these fit.'
    );
    const MAX_DOMAIN_HINTS = 80;
    const domainList =
      existingDomains.length <= MAX_DOMAIN_HINTS
        ? existingDomains.join(', ')
        : `${existingDomains.slice(0, MAX_DOMAIN_HINTS).join(', ')} ... and ${existingDomains.length - MAX_DOMAIN_HINTS} more`;
    parts.push(`Domains in use: ${domainList}`);
    parts.push('');
  }

  // Symbols section
  parts.push(`## Symbols to Annotate (${symbols.length})`);
  parts.push('');

  for (const symbol of symbols) {
    parts.push(`### #${symbol.id}: ${symbol.name} (${symbol.kind})`);

    // File location
    const lineRange = symbol.line === symbol.endLine ? `${symbol.line}` : `${symbol.line}-${symbol.endLine}`;
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

        const annotationStr = annotations.length > 0 ? annotations.join(' ') : '(not yet annotated)';
        parts.push(`- ${dep.name} (#${dep.id}): ${annotationStr}`);
      }
    }
    parts.push('');

    // Relationships to annotate
    if (symbol.relationshipsToAnnotate.length > 0) {
      parts.push('Relationships to annotate:');
      for (const rel of symbol.relationshipsToAnnotate) {
        parts.push(`- [${rel.relationshipType}] → ${rel.toName} (#${rel.toId}) at line ${rel.usageLine}`);
      }
      parts.push('');
    }

    // Source code
    const codeFenceLang = language === 'ruby' ? 'ruby' : 'typescript';
    parts.push('Source Code:');
    parts.push(`\`\`\`${codeFenceLang}`);
    parts.push(symbol.sourceCode);
    parts.push('```');
    parts.push('');

    // Incoming dependencies (who uses this symbol)
    if (symbol.incomingDependencyCount > 0) {
      const shownCount = symbol.incomingDependencies.length;
      const totalCount = symbol.incomingDependencyCount;
      if (shownCount < totalCount) {
        parts.push(`Incoming dependencies (${shownCount} of ${totalCount} total):`);
      } else {
        parts.push(`Incoming dependencies (${totalCount}):`);
      }
      for (const inc of symbol.incomingDependencies) {
        parts.push(`- ${inc.name} (${inc.kind}) from ${inc.filePath}`);
      }
      parts.push('');
    }

    // Export status
    parts.push(`Symbol is exported: ${symbol.isExported ? 'yes' : 'no'}`);
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

export interface IncomingDependencyContext {
  id: number;
  name: string;
  kind: string;
  filePath: string;
}

export type RelationshipType = 'uses' | 'extends' | 'implements';

/**
 * Relationship to annotate (outgoing edge from symbol to dependency).
 */
export interface RelationshipToAnnotate {
  toId: number;
  toName: string;
  toKind: string;
  usageLine: number;
  relationshipType: RelationshipType;
}

export interface SymbolContextEnhanced {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  sourceCode: string;
  isExported: boolean;
  dependencies: DependencyContextEnhanced[];
  relationshipsToAnnotate: RelationshipToAnnotate[];
  incomingDependencies: IncomingDependencyContext[];
  incomingDependencyCount: number;
}

// ============================================================
// Relationship Annotation Prompts
// ============================================================

export interface RelationshipTarget {
  toId: number;
  toName: string;
  toKind: string;
  toFilePath: string;
  toLine: number;
  usageLine: number;
  relationshipType: string;
  toPurpose: string | null;
  toDomains: string[] | null;
  toRole: string | null;
}

export interface RelationshipSourceGroup {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  sourceCode: string;
  purpose: string | null;
  domains: string[] | null;
  role: string | null;
  relationships: RelationshipTarget[];
}

/**
 * Build the system prompt for relationship-only annotation.
 */
export function buildRelationshipSystemPrompt(language: SupportedLanguage = 'typescript'): string {
  const languageLabel = getLanguageLabel(language);
  return `You are a code analyst annotating relationships between ${languageLabel} symbols.

## Your Task
For each source symbol, describe WHY it uses each listed dependency.

## Output Format
Respond with **only** a CSV table with this exact format:

\`\`\`csv
type,id,field,value
relationship,42,55,"validates JWT token before authorizing request"
relationship,42,60,"fetches RSA signing key for token verification"
relationship,88,42,"delegates token validation to dedicated utility"
\`\`\`

## CSV Columns
- **type**: always "relationship"
- **id**: from_id (the source symbol's numeric ID)
- **field**: to_id (the target symbol's numeric ID, shown as #N in the dependency list)
- **value**: semantic description of WHY the source uses the target (min 5 chars)

## Relationship Description Guidelines

**For 'uses' relationships (most common):**
- Explain WHY the source symbol uses the target (1-2 sentences)
- Focus on the semantic purpose, not just "calls" or "uses"
- Example: "validates user credentials before generating session token"

**For 'extends' relationships (class/interface inheritance):**
- Explain WHY this class inherits from the parent
- What behavior is extended or specialized?
- Example: "specializes base logger with JSON formatting for production monitoring"

**For 'implements' relationships (interface implementation):**
- Explain WHAT contract this class fulfills by implementing the interface
- Example: "provides database-backed storage conforming to the Repository pattern"

## CSV Rules
- Header row must be exactly: type,id,field,value
- Values containing commas, quotes, or newlines must be double-quoted
- Escape quotes within values by doubling them ("")
- The field column must be a **numeric ID** — use the ID shown as \`(#N)\` in the dependency list
- If you cannot determine a description, **omit the row entirely**`;
}

/**
 * Build the user prompt for relationship-only annotation.
 */
export function buildRelationshipUserPrompt(
  groups: RelationshipSourceGroup[],
  language: SupportedLanguage = 'typescript'
): string {
  const parts: string[] = [];

  parts.push('## Relationships to Annotate');
  parts.push('');

  for (const group of groups) {
    parts.push(`### Source: #${group.id} ${group.name} (${group.kind})`);

    const lineRange = group.line === group.endLine ? `${group.line}` : `${group.line}-${group.endLine}`;
    parts.push(`File: ${group.filePath}:${lineRange}`);

    if (group.purpose) {
      parts.push(`Purpose: "${group.purpose}"`);
    }
    if (group.domains && group.domains.length > 0) {
      parts.push(`Domains: ${JSON.stringify(group.domains)}`);
    }
    if (group.role) {
      parts.push(`Role: "${group.role}"`);
    }
    parts.push('');

    parts.push('Dependencies to annotate:');
    for (const rel of group.relationships) {
      const targetInfo: string[] = [];
      if (rel.toPurpose) {
        targetInfo.push(`purpose: "${rel.toPurpose}"`);
      }
      const targetMeta = targetInfo.length > 0 ? ` — ${targetInfo.join(', ')}` : '';
      parts.push(
        `- [${rel.relationshipType}] → ${rel.toName} (#${rel.toId}, ${rel.toKind}) at line ${rel.usageLine}${targetMeta}`
      );
    }
    parts.push('');

    const codeFenceLang = language === 'ruby' ? 'ruby' : 'typescript';
    parts.push('Source Code:');
    parts.push(`\`\`\`${codeFenceLang}`);
    parts.push(group.sourceCode);
    parts.push('```');
    parts.push('');
  }

  parts.push('Respond with CSV relationship annotations for all listed dependencies.');

  return parts.join('\n');
}
