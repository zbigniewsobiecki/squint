/**
 * Prompt builders for the two-phase module tree LLM process.
 */

import type { AnnotatedSymbolInfo, Module } from '../../../db/database.js';

// ============================================================
// Phase 1: Tree Structure Generation
// ============================================================

export interface DomainSummary {
  domain: string;
  count: number;
  sampleSymbols: Array<{
    name: string;
    kind: string;
    role: string | null;
  }>;
}

export interface TreeGenerationContext {
  totalSymbolCount: number;
  domains: DomainSummary[];
  directoryStructure: string[];
}

/**
 * Build the system prompt for Phase 1 (tree structure generation).
 */
export function buildTreeSystemPrompt(): string {
  return `You are a software architect designing a module structure for a codebase.
The root "project" module already exists. Propose child modules to organize the codebase.

## Your Task
Analyze the provided domain/role information and directory structure to propose a hierarchical module tree.
The tree should reflect logical groupings of functionality, not just mirror the file system.

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
type,parent_path,slug,name,description
module,project,frontend,"Frontend","UI components and screens"
module,project,backend,"Backend","Server-side logic and APIs"
module,project.frontend,screens,"Screens","Application screens"
module,project.frontend,components,"Components","Reusable UI components"
module,project.backend,services,"Services","Business logic services"
module,project.backend,api,"API","HTTP endpoint handlers"
\`\`\`

## Slug Rules
- Must start with lowercase letter
- Only lowercase letters, numbers, and hyphens allowed
- No consecutive hyphens (e.g., "my--module" is invalid)
- No trailing hyphens (e.g., "my-module-" is invalid)
- Maximum 50 characters

## Guidelines
- Create 3-5 levels of depth at most
- Group by functionality/domain, not by file type
- Use domain tags to inform module boundaries
- Consider architectural layers (e.g., presentation, business logic, data)
- Keep module names concise but descriptive
- Each parent_path must be a valid path (either "project" or a previously defined module)
- For API layers (controllers, routes, services), create entity-specific modules:
  - backend.api.controllers.users (not just backend.api.controllers)
  - backend.api.controllers.products
  - backend.services.user-management
  This enables accurate per-entity flow tracing.`;
}

/**
 * Build the user prompt for Phase 1 (tree structure generation).
 */
export function buildTreeUserPrompt(context: TreeGenerationContext): string {
  const parts: string[] = [];

  parts.push('## Codebase Overview');
  parts.push(`Total symbols: ${context.totalSymbolCount}`);
  parts.push('');

  // Domains with sample symbols
  parts.push(`## Domains Found (${context.domains.length})`);
  parts.push('');

  for (const domain of context.domains) {
    parts.push(`### ${domain.domain} (${domain.count} symbols)`);
    parts.push('Sample symbols:');
    for (const sym of domain.sampleSymbols.slice(0, 5)) {
      const roleStr = sym.role ? ` [${sym.role}]` : '';
      parts.push(`- ${sym.name} (${sym.kind})${roleStr}`);
    }
    parts.push('');
  }

  // Directory structure overview
  parts.push('## Directory Structure');
  for (const dir of context.directoryStructure.slice(0, 30)) {
    parts.push(`- ${dir}`);
  }
  if (context.directoryStructure.length > 30) {
    parts.push(`... and ${context.directoryStructure.length - 30} more directories`);
  }
  parts.push('');

  parts.push('Propose a module tree structure in CSV format.');

  return parts.join('\n');
}

// ============================================================
// Phase 2: Symbol Assignment
// ============================================================

export interface SymbolForAssignment {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  purpose: string | null;
  domain: string[] | null;
  role: string | null;
}

/**
 * Build the system prompt for Phase 2 (symbol assignment).
 */
export function buildAssignmentSystemPrompt(): string {
  return `You are a software architect assigning symbols to modules.
Each symbol must be assigned to exactly ONE module path.

## Your Task
For each symbol, choose the most appropriate module based on:
1. The symbol's purpose and role
2. The symbol's domain tags
3. The symbol's file path
4. The module descriptions

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
type,symbol_id,module_path
assignment,42,project.frontend.screens.login
assignment,87,project.backend.services.auth
assignment,123,project.shared.utils
\`\`\`

## Guidelines
- Every symbol must be assigned to exactly one module
- Module paths must match existing modules in the tree
- Prefer more specific modules over general ones
- Group related symbols together
- Consider the file path as a hint but prioritize functionality`;
}

/**
 * Format module tree for display in user prompt.
 */
export function formatModuleTreeForPrompt(modules: Module[]): string {
  const lines: string[] = [];

  // Sort by depth then path
  const sorted = [...modules].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.fullPath.localeCompare(b.fullPath);
  });

  for (const mod of sorted) {
    const indent = '  '.repeat(mod.depth);
    const desc = mod.description ? ` - ${mod.description}` : '';
    lines.push(`${indent}${mod.fullPath}: ${mod.name}${desc}`);
  }

  return lines.join('\n');
}

/**
 * Build the user prompt for Phase 2 (symbol assignment batch).
 */
export function buildAssignmentUserPrompt(modules: Module[], symbols: SymbolForAssignment[]): string {
  const parts: string[] = [];

  // Module tree
  parts.push('## Available Modules');
  parts.push('');
  parts.push(formatModuleTreeForPrompt(modules));
  parts.push('');

  // Symbols to assign
  parts.push(`## Symbols to Assign (${symbols.length})`);
  parts.push('');

  for (const sym of symbols) {
    parts.push(`### #${sym.id}: ${sym.name} (${sym.kind})`);
    parts.push(`File: ${sym.filePath}`);

    if (sym.purpose) {
      parts.push(`Purpose: ${sym.purpose}`);
    }
    if (sym.domain && sym.domain.length > 0) {
      parts.push(`Domains: ${sym.domain.join(', ')}`);
    }
    if (sym.role) {
      parts.push(`Role: ${sym.role}`);
    }
    parts.push('');
  }

  parts.push('Assign each symbol to exactly ONE module path.');

  return parts.join('\n');
}

/**
 * Convert AnnotatedSymbolInfo to SymbolForAssignment.
 */
export function toSymbolForAssignment(sym: AnnotatedSymbolInfo): SymbolForAssignment {
  return {
    id: sym.id,
    name: sym.name,
    kind: sym.kind,
    filePath: sym.filePath,
    purpose: sym.purpose,
    domain: sym.domain,
    role: sym.role,
  };
}

// ============================================================
// Phase 3: Module Deepening
// ============================================================

export interface ModuleMemberForDeepening {
  definitionId: number;
  name: string;
  kind: string;
  filePath: string;
}

export interface ModuleForDeepening {
  id: number;
  fullPath: string;
  name: string;
  members: ModuleMemberForDeepening[];
}

/**
 * Build the system prompt for Phase 3 (module deepening).
 */
export function buildDeepenSystemPrompt(): string {
  return `You are a software architect splitting a large module into smaller sub-modules.

## Your Task
A module has too many members and needs to be split into 2-5 smaller sub-modules.
Analyze the member symbols and propose sub-modules based on patterns in:
- Names (e.g., use*Customer* → customers sub-module)
- File paths (same file often = same sub-module)
- Functionality (CRUD operations, queries, mutations, etc.)
- Entity/domain groupings (customers, sales, vehicles, etc.)

## Output Format
Respond with **only** a CSV table with two row types:

\`\`\`csv
type,parent_path,slug,name,description,definition_id
module,project.frontend.hooks.data-fetching,customers,"Customer Hooks","Hooks for customer data",
module,project.frontend.hooks.data-fetching,sales,"Sales Hooks","Hooks for sales data",
reassign,project.frontend.hooks.data-fetching.customers,,,,42
reassign,project.frontend.hooks.data-fetching.customers,,,,43
reassign,project.frontend.hooks.data-fetching.sales,,,,87
\`\`\`

Row types:
- \`module\`: Creates a new sub-module. parent_path is the current module being split. Leave definition_id empty.
- \`reassign\`: Moves a symbol to a sub-module. parent_path is the target module path (new sub-module). definition_id is required, other fields empty.

## Slug Rules
- Must start with lowercase letter
- Only lowercase letters, numbers, and hyphens allowed
- No consecutive hyphens
- No trailing hyphens
- Maximum 50 characters

## Guidelines
- Create 2-5 sub-modules (not more)
- Every member MUST be reassigned to exactly one sub-module
- Group related symbols together
- Use clear, descriptive slugs based on the grouping pattern
- Do NOT leave any members in the parent module
- For API layer modules (controllers, routes, handlers), prioritize splitting by entity/domain
  even if member count is low, because each entity typically has separate user flows`;
}

/**
 * Build the user prompt for Phase 3 (module deepening).
 */
export function buildDeepenUserPrompt(module: ModuleForDeepening): string {
  const parts: string[] = [];

  parts.push('## Module to Split');
  parts.push(`Path: ${module.fullPath}`);
  parts.push(`Name: ${module.name}`);
  parts.push(`Members (${module.members.length}):`);
  parts.push('');

  for (const member of module.members) {
    parts.push(`- #${member.definitionId}: ${member.name} (${member.kind}) from ${member.filePath}`);
  }
  parts.push('');

  parts.push('Propose sub-modules and reassign all members to them.');

  return parts.join('\n');
}
