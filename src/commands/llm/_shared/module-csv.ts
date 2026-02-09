/**
 * CSV parsing for module tree and symbol assignment LLM responses.
 */

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
}

export interface TreeParseResult {
  modules: ModuleDefinitionRow[];
  errors: string[];
}

/**
 * Parse Phase 1 LLM response (tree structure).
 * Expected CSV format: type,parent_path,slug,name,description
 */
export function parseTreeCsv(content: string): TreeParseResult {
  const modules: ModuleDefinitionRow[] = [];
  const errors: string[] = [];

  // Remove code fence if present
  let csv = content.trim();
  const codeFenceMatch = csv.match(/```(?:csv)?\s*\n([\s\S]*?)\n```/);
  if (codeFenceMatch) {
    csv = codeFenceMatch[1].trim();
  }

  const lines = splitCsvLines(csv);
  if (lines.length === 0) {
    errors.push('Empty CSV content');
    return { modules, errors };
  }

  // Parse header
  const headerLine = lines[0];
  const header = parseRow(headerLine);
  if (!header || header.length !== 5) {
    errors.push(`Invalid header row: expected "type,parent_path,slug,name,description", got "${headerLine}"`);
    return { modules, errors };
  }

  const expectedHeaders = ['type', 'parent_path', 'slug', 'name', 'description'];
  const normalizedHeaders = header.map((h) => h.toLowerCase().trim().replace(/_/g, '_'));

  // Check headers (allow some flexibility)
  const headerOk =
    normalizedHeaders[0] === 'type' &&
    (normalizedHeaders[1] === 'parent_path' || normalizedHeaders[1] === 'parentpath') &&
    normalizedHeaders[2] === 'slug' &&
    normalizedHeaders[3] === 'name' &&
    (normalizedHeaders[4] === 'description' || normalizedHeaders[4] === 'desc');

  if (!headerOk) {
    errors.push(`Invalid header columns: expected "${expectedHeaders.join(',')}", got "${header.join(',')}"`);
    return { modules, errors };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed) {
      errors.push(`Line ${i + 1}: Failed to parse row: ${line.substring(0, 50)}...`);
      continue;
    }

    if (parsed.length !== 5) {
      errors.push(`Line ${i + 1}: Expected 5 columns, got ${parsed.length}: ${line.substring(0, 50)}...`);
      continue;
    }

    const [rowType, parentPath, slug, name, description] = parsed.map((v) => v.trim());

    if (rowType !== 'module') {
      errors.push(`Line ${i + 1}: Unknown type "${rowType}", expected "module"`);
      continue;
    }

    // Validate parent_path
    if (!isValidModulePath(parentPath)) {
      errors.push(`Line ${i + 1}: Invalid parent_path "${parentPath}"`);
      continue;
    }

    // Validate slug
    if (!isValidSlug(slug)) {
      errors.push(`Line ${i + 1}: Invalid slug "${slug}"`);
      continue;
    }

    if (!name) {
      errors.push(`Line ${i + 1}: Missing name`);
      continue;
    }

    modules.push({
      parentPath,
      slug,
      name,
      description: description || '',
    });
  }

  return { modules, errors };
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
  const assignments: SymbolAssignmentRow[] = [];
  const errors: string[] = [];

  // Remove code fence if present
  let csv = content.trim();
  const codeFenceMatch = csv.match(/```(?:csv)?\s*\n([\s\S]*?)\n```/);
  if (codeFenceMatch) {
    csv = codeFenceMatch[1].trim();
  }

  const lines = splitCsvLines(csv);
  if (lines.length === 0) {
    errors.push('Empty CSV content');
    return { assignments, errors };
  }

  // Parse header
  const headerLine = lines[0];
  const header = parseRow(headerLine);
  if (!header || header.length !== 3) {
    errors.push(`Invalid header row: expected "type,symbol_id,module_path", got "${headerLine}"`);
    return { assignments, errors };
  }

  const normalizedHeaders = header.map((h) => h.toLowerCase().trim().replace(/_/g, '_'));
  const headerOk =
    normalizedHeaders[0] === 'type' &&
    (normalizedHeaders[1] === 'symbol_id' || normalizedHeaders[1] === 'symbolid') &&
    (normalizedHeaders[2] === 'module_path' || normalizedHeaders[2] === 'modulepath');

  if (!headerOk) {
    errors.push(`Invalid header columns: expected "type,symbol_id,module_path", got "${header.join(',')}"`);
    return { assignments, errors };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed) {
      errors.push(`Line ${i + 1}: Failed to parse row: ${line.substring(0, 50)}...`);
      continue;
    }

    if (parsed.length !== 3) {
      errors.push(`Line ${i + 1}: Expected 3 columns, got ${parsed.length}: ${line.substring(0, 50)}...`);
      continue;
    }

    const [rowType, symbolIdStr, modulePath] = parsed.map((v) => v.trim());

    if (rowType !== 'assignment') {
      errors.push(`Line ${i + 1}: Unknown type "${rowType}", expected "assignment"`);
      continue;
    }

    const symbolId = Number.parseInt(symbolIdStr, 10);
    if (Number.isNaN(symbolId)) {
      errors.push(`Line ${i + 1}: Invalid symbol_id "${symbolIdStr}"`);
      continue;
    }

    if (!isValidModulePath(modulePath)) {
      errors.push(`Line ${i + 1}: Invalid module_path "${modulePath}"`);
      continue;
    }

    assignments.push({
      symbolId,
      modulePath,
    });
  }

  return { assignments, errors };
}

// ============================================================
// CSV Utilities (from csv.ts pattern)
// ============================================================

/**
 * Split CSV content into logical lines, handling multi-line quoted values.
 */
function splitCsvLines(csv: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];

    if (char === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        current += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
    } else if (char === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (char === '\r' && !inQuotes) {
    } else {
      current += char;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

/**
 * Parse a single CSV row into columns.
 */
function parseRow(line: string): string[] | null {
  const columns: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"') {
      if (!inQuotes) {
        inQuotes = true;
        i++;
        continue;
      }

      if (line[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }

      inQuotes = false;
      i++;
      continue;
    }

    if (char === ',' && !inQuotes) {
      columns.push(current);
      current = '';
      i++;
      continue;
    }

    current += char;
    i++;
  }

  columns.push(current);

  if (inQuotes) {
    return null;
  }

  return columns;
}

/**
 * Format a value for CSV output.
 */
export function formatCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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
  const newModules: DeepenModuleRow[] = [];
  const reassignments: DeepenReassignRow[] = [];
  const errors: string[] = [];

  // Remove code fence if present
  let csv = content.trim();
  const codeFenceMatch = csv.match(/```(?:csv)?\s*\n([\s\S]*?)\n```/);
  if (codeFenceMatch) {
    csv = codeFenceMatch[1].trim();
  }

  const lines = splitCsvLines(csv);
  if (lines.length === 0) {
    errors.push('Empty CSV content');
    return { newModules, reassignments, errors };
  }

  // Determine if first row is header or data
  const firstRow = parseRow(lines[0]);
  let startIndex = 0;

  if (firstRow && firstRow.length >= 1) {
    const firstValue = firstRow[0].toLowerCase().trim();
    // If first row starts with 'type', it's a header - skip it
    // If it starts with 'module' or 'reassign', it's data - process from index 0
    if (firstValue === 'type') {
      startIndex = 1;
    }
  }

  // Parse data rows
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed) {
      errors.push(`Line ${i + 1}: Failed to parse row: ${line.substring(0, 50)}...`);
      continue;
    }

    if (parsed.length !== 6) {
      errors.push(`Line ${i + 1}: Expected 6 columns, got ${parsed.length}: ${line.substring(0, 50)}...`);
      continue;
    }

    const [rowType, parentPath, slug, name, description, definitionIdStr] = parsed.map((v) => v.trim());

    if (rowType === 'module') {
      // Validate parent_path
      if (!isValidModulePath(parentPath)) {
        errors.push(`Line ${i + 1}: Invalid parent_path "${parentPath}"`);
        continue;
      }

      // Validate slug
      if (!isValidSlug(slug)) {
        errors.push(`Line ${i + 1}: Invalid slug "${slug}"`);
        continue;
      }

      if (!name) {
        errors.push(`Line ${i + 1}: Missing name for module`);
        continue;
      }

      newModules.push({
        parentPath,
        slug,
        name,
        description: description || '',
      });
    } else if (rowType === 'reassign') {
      // For reassign rows, parent_path is the target module path
      if (!isValidModulePath(parentPath)) {
        errors.push(`Line ${i + 1}: Invalid target module path "${parentPath}"`);
        continue;
      }

      const definitionId = Number.parseInt(definitionIdStr, 10);
      if (Number.isNaN(definitionId)) {
        errors.push(`Line ${i + 1}: Invalid definition_id "${definitionIdStr}"`);
        continue;
      }

      reassignments.push({
        definitionId,
        targetModulePath: parentPath,
      });
    } else {
      errors.push(`Line ${i + 1}: Unknown type "${rowType}", expected "module" or "reassign"`);
    }
  }

  return { newModules, reassignments, errors };
}
