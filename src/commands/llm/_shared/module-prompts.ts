/**
 * Prompt builders for the two-phase module tree LLM process.
 */

import type { AnnotatedSymbolInfo, Module } from '../../../db/database.js';
import type { ModuleSymbol } from '../../../db/repositories/module-repository.js';

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

export interface DirectoryInfo {
  path: string;
  symbolCount: number;
}

export interface TreeGenerationContext {
  totalSymbolCount: number;
  domains: DomainSummary[];
  directoryStructure: DirectoryInfo[];
  maxModules?: number;
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
type,parent_path,slug,name,description,is_test
module,project,frontend,"Frontend","UI components and screens",false
module,project,backend,"Backend","Server-side logic and APIs",false
module,project,testing,"Testing","Test utilities and helpers",true
module,project.frontend,screens,"Screens","Application screens",false
module,project.frontend,components,"Components","Reusable UI components",false
module,project.backend,services,"Services","Business logic services",false
module,project.backend,api,"API","HTTP endpoint handlers",false
module,project.testing,factories,"Test Factories","Mock data generators for tests",true
\`\`\`

## Test Classification
For each module, set is_test to "true" if the module exists solely to support testing:
- Test utilities, mock factories, fixture generators, test helpers
- Test data builders, spec runners, integration test support
- Anything that wouldn't ship in a production build

Set is_test to "false" for all production code modules.
Test classification is inherited: if a parent is test, children should also be test.

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
  This enables accurate per-entity flow tracing.

## Business Domain Parity (CRITICAL)
- Every business entity domain MUST be a first-class branch.
  If the codebase has customers, vehicles, and sales — each gets equal treatment.
  Do NOT bury one domain under "Infrastructure" or "Misc" while others get their own branch.
  The domains list below tells you which business entities exist — ensure each one appears
  in the tree at the same structural level.

## Test Code Segregation
- Test/spec code MUST go in its own top-level branch (e.g., project.testing).
  Do NOT mix test helpers, mocks, fixtures, or data generators into business domain branches.
  Use the symbol names, file paths, purposes, and domain tags to determine what is test code —
  look for test utilities, mock factories, fixture generators, and spec helpers.

## Infrastructure Scope
- The "infrastructure" or "utility" branch should ONLY contain true cross-cutting concerns:
  database connections, logging, configuration, error handling base classes.
  Business logic services, controllers, and routes are NOT infrastructure —
  they belong under their respective business domain branches.`;
}

/**
 * Build the user prompt for Phase 1 (tree structure generation).
 */
export function buildTreeUserPrompt(context: TreeGenerationContext): string {
  const parts: string[] = [];

  parts.push('## Codebase Overview');
  parts.push(`Total symbols: ${context.totalSymbolCount}`);
  if (context.maxModules && context.maxModules > 0) {
    const initialTarget = Math.floor(context.maxModules * 0.4);
    parts.push(
      `Module budget: ${context.maxModules} total. Create ~${initialTarget} modules now — oversized leaves will be split automatically later. Focus on the top 2–3 levels.`
    );
  }
  parts.push('');

  // Domains with sample symbols
  parts.push(`## Domains Found (${context.domains.length})`);
  parts.push('');

  for (const domain of context.domains) {
    parts.push(`### ${domain.domain} (${domain.count} symbols)`);
    parts.push('Sample symbols:');
    for (const sym of domain.sampleSymbols) {
      const roleStr = sym.role ? ` [${sym.role}]` : '';
      parts.push(`- ${sym.name} (${sym.kind})${roleStr}`);
    }
    parts.push('');
  }

  // Directory structure (full — the LLM needs the complete picture to design modules)
  parts.push('## Directory Structure');
  for (const dir of context.directoryStructure) {
    parts.push(`- ${dir.path} (${dir.symbolCount} symbols)`);
  }
  parts.push('');

  parts.push('Propose a module tree structure in CSV format.');

  return parts.join('\n');
}

// ============================================================
// Helpers
// ============================================================

/**
 * Check if a file path is a test file based on naming conventions.
 */
export function isTestFile(filePath: string): boolean {
  const segments = filePath.split('/');
  const fileName = segments[segments.length - 1] ?? '';
  return (
    fileName.endsWith('.test.ts') ||
    fileName.endsWith('.test.tsx') ||
    fileName.endsWith('.spec.ts') ||
    fileName.endsWith('.spec.tsx') ||
    segments.includes('__tests__')
  );
}

// ============================================================
// Phase 2: Symbol Assignment
// ============================================================

export interface SymbolForAssignment {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  isExported: boolean;
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
- Consider the file path as a hint but prioritize functionality

## Test Symbol Rules
- Symbols from test files (*.test.ts, *.spec.ts) that are NOT exported are test-file-local.
  Assign them to the nearest test module (project.testing.*) — never to production modules.
- Only exported symbols from dedicated test utility files (test/helpers/*, test/factories/*)
  belong in specific test infrastructure modules (e.g., project.testing.factories.customers).
- Non-exported symbols from test files are inline mocks/fixtures — assign them to a general
  test module like project.testing.helpers or project.testing.mocks, not to granular sub-modules.`;
}

/**
 * Format module tree for display in user prompt.
 */
export function formatModuleTreeForPrompt(modules: Module[], directoryHints?: Map<number, string[]>): string {
  const lines: string[] = [];

  // Sort by depth then path
  const sorted = [...modules].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.fullPath.localeCompare(b.fullPath);
  });

  for (const mod of sorted) {
    const indent = '  '.repeat(mod.depth);
    const desc = mod.description ? ` - ${mod.description}` : '';
    const hints = directoryHints?.get(mod.id);
    const hintStr = hints?.length ? ` [${hints.join(', ')}]` : '';
    lines.push(`${indent}${mod.fullPath}: ${mod.name}${desc}${hintStr}`);
  }

  return lines.join('\n');
}

/**
 * Build the user prompt for Phase 2 (symbol assignment batch).
 */
export function buildAssignmentUserPrompt(
  modules: Module[],
  symbols: SymbolForAssignment[],
  directoryHints?: Map<number, string[]>
): string {
  const parts: string[] = [];

  // Module tree
  parts.push('## Available Modules');
  parts.push('');
  parts.push(formatModuleTreeForPrompt(modules, directoryHints));
  parts.push('');

  // Symbols to assign
  parts.push(`## Symbols to Assign (${symbols.length})`);
  parts.push('');

  for (const sym of symbols) {
    parts.push(`### #${sym.id}: ${sym.name} (${sym.kind})`);
    parts.push(`File: ${sym.filePath}`);
    if (!sym.isExported) {
      parts.push(`Exported: no (file-local symbol)`);
    }
    if (isTestFile(sym.filePath)) {
      parts.push(`Test file: yes`);
    }

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
    isExported: sym.isExported,
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
  isExported: boolean;
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
    const tags: string[] = [];
    if (isTestFile(member.filePath)) tags.push('test-file');
    if (!member.isExported) tags.push('not exported');
    const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    parts.push(`- #${member.definitionId}: ${member.name} (${member.kind}) from ${member.filePath}${tagStr}`);
  }
  parts.push('');

  parts.push('Propose sub-modules and reassign all members to them.');

  return parts.join('\n');
}

// ============================================================
// Ancestor Rebalancing
// ============================================================

export interface AncestorSymbolGroup {
  moduleId: number;
  modulePath: string;
  symbols: ModuleSymbol[];
}

export interface NewSubModuleInfo {
  path: string;
  name: string;
  description: string | null;
}

/**
 * Build the system prompt for ancestor rebalancing.
 */
export function buildRebalanceSystemPrompt(): string {
  return `You are a software architect reviewing symbol assignments after a module was split into sub-modules.

## Your Task
Symbols are currently assigned to ancestor (parent/grandparent) modules. New sub-modules have been created below.
Review each symbol and decide if it now fits better in one of the new sub-modules.
Only reassign symbols that clearly belong in a new sub-module — leave ambiguous ones where they are.

## Output Format
Respond with **only** a CSV table. Only include rows for symbols you want to MOVE.
Symbols not mentioned will stay in their current module.

\`\`\`csv
type,symbol_id,module_path
assignment,42,project.frontend.hooks.customers
assignment,87,project.frontend.hooks.sales
\`\`\`

## Guidelines
- Only move a symbol if the new sub-module is a clearly better fit
- Consider the symbol's name, kind, file path, and the sub-module descriptions
- When in doubt, leave the symbol where it is
- Module paths must match one of the new sub-modules listed below
- If no symbols should be moved, respond with just the CSV header`;
}

/**
 * Build the user prompt for ancestor rebalancing.
 */
export function buildRebalanceUserPrompt(
  ancestorSymbols: AncestorSymbolGroup[],
  newSubModules: NewSubModuleInfo[]
): string {
  const parts: string[] = [];

  parts.push('## New Sub-Modules');
  parts.push('');
  for (const sub of newSubModules) {
    const desc = sub.description ? ` - ${sub.description}` : '';
    parts.push(`- ${sub.path}: ${sub.name}${desc}`);
  }
  parts.push('');

  parts.push('## Symbols Currently in Ancestor Modules');
  parts.push('');
  for (const group of ancestorSymbols) {
    parts.push(`### ${group.modulePath} (${group.symbols.length} symbols)`);
    for (const sym of group.symbols) {
      const tags: string[] = [];
      if (isTestFile(sym.filePath)) tags.push('test-file');
      if (!sym.isExported) tags.push('not exported');
      const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
      parts.push(`- #${sym.id}: ${sym.name} (${sym.kind}) from ${sym.filePath}${tagStr}`);
    }
    parts.push('');
  }

  parts.push('Reassign any symbols that now fit better in the new sub-modules.');

  return parts.join('\n');
}
