/**
 * CSV parsing for module tree and symbol assignment LLM responses.
 */

import { extractCsvContent, parseCsvWithMapper, parseRow, safeParseInt, splitCsvLines } from './csv-utils.js';

export { formatCsvValue } from './csv-utils.js';

// ============================================================
// Normalization
// ============================================================

/**
 * Normalize an LLM-returned module path before validation.
 *
 * Fixes common LLM formatting quirks:
 * - Strips backticks and surrounding quotes
 * - Lowercases each segment
 * - Replaces underscores with hyphens
 * - Trims whitespace within segments
 * - Collapses consecutive dots
 */
export function normalizeModulePath(raw: string): string {
  let p = raw;
  // Strip backticks and surrounding quotes
  p = p.replace(/`/g, '');
  p = p.replace(/^["']|["']$/g, '');
  // Lowercase
  p = p.toLowerCase();
  // Replace underscores with hyphens
  p = p.replace(/_/g, '-');
  // Trim whitespace (including within segments around dots)
  p = p
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('.');
  return p;
}

// ============================================================
// Validation Rules
// ============================================================

/**
 * Validate a module slug.
 * Rules: ^[a-z][a-z0-9-]*$, max 50 chars, no consecutive/trailing hyphens
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > 50) return false;
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) return false;
  if (slug.includes('--')) return false;
  if (slug.endsWith('-')) return false;
  return true;
}

/**
 * Validate a module path.
 * Rules: Must start with "project", dot-separated valid slugs
 */
export function isValidModulePath(path: string): boolean {
  if (!path.startsWith('project')) return false;
  const parts = path.split('.');
  return parts.every(isValidSlug);
}

// ============================================================
// Phase 1: Tree Structure Parsing
// ============================================================

export interface ModuleDefinitionRow {
  parentPath: string;
  slug: string;
  name: string;
  description: string;
  isTest: boolean;
}

export interface TreeParseResult {
  modules: ModuleDefinitionRow[];
  errors: string[];
}

/**
 * Parse Phase 1 LLM response (tree structure).
 * Expected CSV format: type,parent_path,slug,name,description,is_test
 * Also accepts legacy 5-column format without is_test.
 */
export function parseTreeCsv(content: string): TreeParseResult {
  const { items, errors } = parseCsvWithMapper<ModuleDefinitionRow>(content, {
    expectedColumns: [5, 6],
    headerValidator: (h) => {
      const norm = h.map((s) => s.toLowerCase().trim().replace(/_/g, '_'));
      const hasIsTest = h.length === 6;
      return (
        norm[0] === 'type' &&
        (norm[1] === 'parent_path' || norm[1] === 'parentpath') &&
        norm[2] === 'slug' &&
        norm[3] === 'name' &&
        (norm[4] === 'description' || norm[4] === 'desc') &&
        (!hasIsTest || norm[5] === 'is_test' || norm[5] === 'istest')
      );
    },
    rowMapper: (cols, lineNum, errs) => {
      const [rowType, parentPath, slug, name, description] = cols;
      const isTestStr = cols.length >= 6 ? cols[5] : 'false';

      if (rowType !== 'module') {
        errs.push(`Line ${lineNum}: Unknown type "${rowType}", expected "module"`);
        return null;
      }
      if (!isValidModulePath(parentPath)) {
        errs.push(`Line ${lineNum}: Invalid parent_path "${parentPath}"`);
        return null;
      }
      if (!isValidSlug(slug)) {
        errs.push(`Line ${lineNum}: Invalid slug "${slug}"`);
        return null;
      }
      if (!name) {
        errs.push(`Line ${lineNum}: Missing name`);
        return null;
      }

      return {
        parentPath,
        slug,
        name,
        description: description || '',
        isTest: isTestStr.toLowerCase() === 'true',
      };
    },
  });

  return { modules: items, errors };
}

// ============================================================
// Phase 2: Symbol Assignment Parsing
// ============================================================

export interface SymbolAssignmentRow {
  symbolId: number;
  modulePath: string;
}

export interface AssignmentParseResult {
  assignments: SymbolAssignmentRow[];
  errors: string[];
}

/**
 * Parse Phase 2 LLM response (symbol assignments).
 * Expected CSV format: type,symbol_id,module_path
 */
export function parseAssignmentCsv(content: string): AssignmentParseResult {
  const { items, errors } = parseCsvWithMapper<SymbolAssignmentRow>(content, {
    expectedColumns: 3,
    headerValidator: (h) => {
      const norm = h.map((s) => s.toLowerCase().trim().replace(/_/g, '_'));
      return (
        norm[0] === 'type' &&
        (norm[1] === 'symbol_id' || norm[1] === 'symbolid') &&
        (norm[2] === 'module_path' || norm[2] === 'modulepath')
      );
    },
    rowMapper: (cols, lineNum, errs) => {
      const [rowType, symbolIdStr, rawModulePath] = cols;

      if (rowType !== 'assignment') {
        errs.push(`Line ${lineNum}: Unknown type "${rowType}", expected "assignment"`);
        return null;
      }

      const symbolId = safeParseInt(symbolIdStr, 'symbol_id', lineNum, errs);
      if (symbolId === null) return null;

      const modulePath = normalizeModulePath(rawModulePath);
      if (!isValidModulePath(modulePath)) {
        errs.push(`Line ${lineNum}: Invalid module_path "${rawModulePath}"`);
        return null;
      }

      return { symbolId, modulePath };
    },
  });

  return { assignments: items, errors };
}

// ============================================================
// Phase 3: Deepen Response Parsing
// ============================================================

export interface DeepenModuleRow {
  parentPath: string;
  slug: string;
  name: string;
  description: string;
}

export interface DeepenReassignRow {
  definitionId: number;
  targetModulePath: string;
}

export interface DeepenParseResult {
  newModules: DeepenModuleRow[];
  reassignments: DeepenReassignRow[];
  errors: string[];
}

/**
 * Parse Phase 3 LLM response (deepen/split modules).
 * Expected CSV format: type,parent_path,slug,name,description,definition_id
 */
export function parseDeepenCsv(content: string): DeepenParseResult {
  // Detect whether first row is a header or data
  const csv = extractCsvContent(content);
  const firstLine = splitCsvLines(csv)[0] ?? '';
  const firstRow = parseRow(firstLine);
  const hasHeader = firstRow?.[0]?.toLowerCase().trim() === 'type';

  type DeepenItem = { kind: 'module'; data: DeepenModuleRow } | { kind: 'reassign'; data: DeepenReassignRow };

  const { items, errors } = parseCsvWithMapper<DeepenItem>(content, {
    expectedColumns: 6,
    skipHeader: hasHeader,
    rowMapper: (cols, lineNum, errs) => {
      const [rowType, parentPath, slug, name, description, definitionIdStr] = cols;

      if (rowType === 'module') {
        if (!isValidModulePath(parentPath)) {
          errs.push(`Line ${lineNum}: Invalid parent_path "${parentPath}"`);
          return null;
        }
        if (!isValidSlug(slug)) {
          errs.push(`Line ${lineNum}: Invalid slug "${slug}"`);
          return null;
        }
        if (!name) {
          errs.push(`Line ${lineNum}: Missing name for module`);
          return null;
        }
        return { kind: 'module', data: { parentPath, slug, name, description: description || '' } };
      }
      if (rowType === 'reassign') {
        if (!isValidModulePath(parentPath)) {
          errs.push(`Line ${lineNum}: Invalid target module path "${parentPath}"`);
          return null;
        }
        const definitionId = safeParseInt(definitionIdStr, 'definition_id', lineNum, errs);
        if (definitionId === null) return null;
        return { kind: 'reassign', data: { definitionId, targetModulePath: parentPath } };
      }
      errs.push(`Line ${lineNum}: Unknown type "${rowType}", expected "module" or "reassign"`);
      return null;
    },
  });

  return {
    newModules: items.filter((i): i is DeepenItem & { kind: 'module' } => i.kind === 'module').map((i) => i.data),
    reassignments: items
      .filter((i): i is DeepenItem & { kind: 'reassign' } => i.kind === 'reassign')
      .map((i) => i.data),
    errors,
  };
}
