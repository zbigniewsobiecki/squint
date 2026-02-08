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
        parts.push(`- [${rel.relationshipType}] → ${rel.toName} (#${rel.toId}) at line ${rel.usageLine}`);
      }
      parts.push('');
    }

    // Source code
    parts.push('Source Code:');
    parts.push('```typescript');
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
// Module Detection Prompts
// ============================================================

export interface ModuleMemberInfo {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  domains: string[];
  role: string | null;
}

export interface ModuleCandidate {
  id: number;
  members: ModuleMemberInfo[];
  internalEdges: number;
  externalEdges: number;
  dominantDomains: string[];
  dominantRoles: string[];
}

/**
 * Build the system prompt for module naming.
 */
export function buildModuleSystemPrompt(): string {
  return `You are a software architect analyzing module boundaries detected by community detection on a call graph.

## Your Task
For each module candidate, analyze its members and provide:
1. A concise, descriptive module name
2. The architectural layer (controller/service/repository/adapter/utility)
3. The primary business subsystem/domain
4. A one-sentence description

## Layers
- **controller**: Entry points, HTTP handlers, CLI commands, event handlers
- **service**: Business logic, orchestration, domain rules
- **repository**: Data access, persistence, external data sources
- **adapter**: Integration with external systems, APIs, third-party services
- **utility**: Shared utilities, helpers, pure functions

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
module_id,name,layer,subsystem,description
1,PaymentProcessing,service,payments,"Handles payment request validation and processing"
2,AccountManagement,service,accounts,"Manages account lifecycle and state transitions"
3,DatabaseAccess,repository,persistence,"Provides data access layer for all entities"
\`\`\`

## Guidelines
- Module names should be PascalCase
- Prefer names that describe the cohesive purpose (e.g., "PaymentValidation" not "Validators")
- Layer should match the dominant role of members
- Subsystem should reflect the business domain
- Description should explain WHY these symbols are grouped together`;
}

/**
 * Build the user prompt for module naming.
 */
export function buildModuleUserPrompt(candidates: ModuleCandidate[]): string {
  const parts: string[] = [];

  parts.push(`## Module Candidates (${candidates.length})`);
  parts.push('');

  for (const candidate of candidates) {
    parts.push(`### Module Candidate #${candidate.id} (${candidate.members.length} members)`);

    // Show metrics
    parts.push(`Internal edges: ${candidate.internalEdges}, External edges: ${candidate.externalEdges}`);

    // Show dominant domains and roles
    if (candidate.dominantDomains.length > 0) {
      parts.push(`Dominant domains: ${candidate.dominantDomains.join(', ')}`);
    }
    if (candidate.dominantRoles.length > 0) {
      parts.push(`Dominant roles: ${candidate.dominantRoles.join(', ')}`);
    }
    parts.push('');

    // List all members
    parts.push('Members:');
    for (const member of candidate.members) {
      const domainsStr = member.domains.length > 0 ? ` [${member.domains.join(', ')}]` : '';
      const roleStr = member.role ? ` (${member.role})` : '';
      parts.push(`- ${member.name} (${member.kind})${roleStr}${domainsStr}`);
    }
    parts.push('');
  }

  parts.push('Provide module annotations in CSV format.');

  return parts.join('\n');
}

// ============================================================
// Flow Detection Prompts
// ============================================================

export interface FlowStepInfo {
  definitionId: number;
  name: string;
  kind: string;
  filePath: string;
  depth: number;
  moduleId: number | null;
  moduleName: string | null;
  layer: string | null;
}

export interface FlowCandidate {
  id: number;
  entryPointId: number;
  entryPointName: string;
  entryPointKind: string;
  entryPointFilePath: string;
  steps: FlowStepInfo[];
  modulesCrossed: string[];
  dominantDomains: string[];
}

/**
 * Build the system prompt for flow naming.
 */
export function buildFlowSystemPrompt(): string {
  return `You are a software architect analyzing execution flows detected in a codebase.

## Your Task
For each execution flow (a path from an entry point through the call graph), provide:
1. A descriptive name for the flow (e.g., "CreateSale", "UserAuthentication", "ListVehicles")
2. A one-sentence description of what the flow accomplishes

## What is an Execution Flow?
An execution flow traces the path of a request from an entry point (like a controller or route handler) through the various layers of the system (services, repositories, utilities).

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
flow_id,name,description
1,CreateSale,"Processes a new vehicle sale from customer request to database persistence"
2,UserLogin,"Authenticates user credentials and establishes a session"
3,ListVehicles,"Retrieves and filters vehicle inventory for display"
\`\`\`

## Naming Guidelines
- Use PascalCase for names (e.g., CreateSale, not create_sale)
- Names should be action-oriented verbs or verb phrases
- Names should reflect the business operation, not the technical implementation
- Keep names concise but descriptive (1-3 words typically)
- Common patterns: Create*, Update*, Delete*, Get*, List*, Find*, Process*, Handle*

## Description Guidelines
- One sentence explaining the business purpose
- Focus on WHAT the flow accomplishes, not HOW
- Mention the main entities involved (e.g., "vehicle", "sale", "customer")`;
}

/**
 * Build the user prompt for flow naming.
 */
export function buildFlowUserPrompt(candidates: FlowCandidate[]): string {
  const parts: string[] = [];

  parts.push(`## Execution Flows to Name (${candidates.length})`);
  parts.push('');

  for (const candidate of candidates) {
    parts.push(`### Flow #${candidate.id}`);
    parts.push(`Entry point: ${candidate.entryPointName} (${candidate.entryPointKind})`);
    parts.push(`File: ${candidate.entryPointFilePath}`);

    if (candidate.dominantDomains.length > 0) {
      parts.push(`Domains: ${candidate.dominantDomains.join(', ')}`);
    }

    parts.push('');
    parts.push(`Steps (${candidate.steps.length} total):`);

    // Show up to 10 steps, truncate if more
    const maxSteps = 10;
    const stepsToShow = Math.min(candidate.steps.length, maxSteps);

    for (let i = 0; i < stepsToShow; i++) {
      const step = candidate.steps[i];
      const layerStr = step.layer ? ` [${step.layer}]` : '';
      const moduleStr = step.moduleName ? ` (${step.moduleName})` : '';
      parts.push(`  ${i + 1}. ${step.name}${layerStr}${moduleStr}`);
    }

    if (candidate.steps.length > maxSteps) {
      parts.push(`  ... and ${candidate.steps.length - maxSteps} more steps`);
    }

    if (candidate.modulesCrossed.length > 0) {
      parts.push('');
      parts.push(`Modules crossed: ${candidate.modulesCrossed.join(' → ')}`);
    }

    parts.push('');
  }

  parts.push('Provide flow names and descriptions in CSV format.');

  return parts.join('\n');
}
