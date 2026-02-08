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
- Each parent_path must be a valid path (either "project" or a previously defined module)`;
}

/**
 * Build the user prompt for Phase 1 (tree structure generation).
 */
export function buildTreeUserPrompt(context: TreeGenerationContext): string {
  const parts: string[] = [];

  parts.push(`## Codebase Overview`);
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
  parts.push(`## Directory Structure`);
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
export function buildAssignmentUserPrompt(
  modules: Module[],
  symbols: SymbolForAssignment[],
): string {
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
