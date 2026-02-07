/**
 * RFC 4180 CSV parser - no external dependencies
 * Handles quoted fields, escaped quotes, and multi-line values.
 */

export interface CsvRow {
  id: string;
  aspect: string;
  value: string;
}

export interface ParseResult {
  rows: CsvRow[];
  errors: string[];
}

/**
 * Combined CSV row for symbol or relationship annotations.
 */
export interface SymbolAnnotationRow {
  symbolId: number;
  aspect: string;
  value: string;
}

export interface RelationshipAnnotationRow {
  fromId: number;
  toId: number;
  value: string;
}

export interface CombinedParseResult {
  symbols: SymbolAnnotationRow[];
  relationships: RelationshipAnnotationRow[];
  errors: string[];
}

/**
 * Parse CSV content from LLM response.
 * Expects header row: id,aspect,value
 * Handles:
 * - Quoted fields with commas
 * - Escaped quotes ("" within quoted fields)
 * - Optional ```csv code fence wrapper
 */
export function parseCsv(content: string): ParseResult {
  const rows: CsvRow[] = [];
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
    return { rows, errors };
  }

  // Parse header
  const headerLine = lines[0];
  const header = parseRow(headerLine);
  if (!header || header.length !== 3) {
    errors.push(`Invalid header row: expected "id,aspect,value", got "${headerLine}"`);
    return { rows, errors };
  }

  const [idCol, aspectCol, valueCol] = header.map(h => h.toLowerCase().trim());
  if (idCol !== 'id' || aspectCol !== 'aspect' || valueCol !== 'value') {
    errors.push(`Invalid header columns: expected "id,aspect,value", got "${header.join(',')}"`);
    return { rows, errors };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // Skip empty lines

    const parsed = parseRow(line);
    if (!parsed) {
      errors.push(`Line ${i + 1}: Failed to parse row: ${line.substring(0, 50)}...`);
      continue;
    }

    if (parsed.length !== 3) {
      errors.push(`Line ${i + 1}: Expected 3 columns, got ${parsed.length}: ${line.substring(0, 50)}...`);
      continue;
    }

    const [id, aspect, value] = parsed;
    if (!id.trim() || !aspect.trim()) {
      errors.push(`Line ${i + 1}: Missing id or aspect: ${line.substring(0, 50)}...`);
      continue;
    }

    rows.push({
      id: id.trim(),
      aspect: aspect.trim(),
      value: value.trim(),
    });
  }

  return { rows, errors };
}

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
      // Check for escaped quote
      if (inQuotes && csv[i + 1] === '"') {
        current += '""';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
    } else if (char === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (char === '\r' && !inQuotes) {
      // Skip carriage returns
      continue;
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
        // Start of quoted field
        inQuotes = true;
        i++;
        continue;
      }

      // Check for escaped quote or end of quoted field
      if (line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i += 2;
        continue;
      }

      // End of quoted field
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

  // Add final column
  columns.push(current);

  // Check for unclosed quotes
  if (inQuotes) {
    return null;
  }

  return columns;
}

/**
 * Format a value for CSV output (for testing/debugging).
 */
export function formatCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Parse combined CSV content for symbol and relationship annotations.
 * Expects header row: type,id,field,value
 *
 * Format:
 * - For symbols: type=symbol, id=symbol_id, field=aspect_name, value=annotation
 * - For relationships: type=relationship, id=from_id, field=to_id, value=semantic_description
 */
export function parseCombinedCsv(content: string): CombinedParseResult {
  const symbols: SymbolAnnotationRow[] = [];
  const relationships: RelationshipAnnotationRow[] = [];
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
    return { symbols, relationships, errors };
  }

  // Parse header
  const headerLine = lines[0];
  const header = parseRow(headerLine);
  if (!header || header.length !== 4) {
    errors.push(`Invalid header row: expected "type,id,field,value", got "${headerLine}"`);
    return { symbols, relationships, errors };
  }

  const [typeCol, idCol, fieldCol, valueCol] = header.map(h => h.toLowerCase().trim());
  if (typeCol !== 'type' || idCol !== 'id' || fieldCol !== 'field' || valueCol !== 'value') {
    errors.push(`Invalid header columns: expected "type,id,field,value", got "${header.join(',')}"`);
    return { symbols, relationships, errors };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // Skip empty lines

    const parsed = parseRow(line);
    if (!parsed) {
      errors.push(`Line ${i + 1}: Failed to parse row: ${line.substring(0, 50)}...`);
      continue;
    }

    if (parsed.length !== 4) {
      errors.push(`Line ${i + 1}: Expected 4 columns, got ${parsed.length}: ${line.substring(0, 50)}...`);
      continue;
    }

    const [rowType, id, field, value] = parsed.map(v => v.trim());

    if (rowType === 'symbol') {
      const symbolId = parseInt(id, 10);
      if (isNaN(symbolId)) {
        errors.push(`Line ${i + 1}: Invalid symbol ID: ${id}`);
        continue;
      }
      if (!field) {
        errors.push(`Line ${i + 1}: Missing aspect name`);
        continue;
      }
      symbols.push({ symbolId, aspect: field, value });
    } else if (rowType === 'relationship') {
      const fromId = parseInt(id, 10);
      const toId = parseInt(field, 10);
      if (isNaN(fromId)) {
        errors.push(`Line ${i + 1}: Invalid from_id: ${id}`);
        continue;
      }
      if (isNaN(toId)) {
        errors.push(`Line ${i + 1}: Invalid to_id: ${field}`);
        continue;
      }
      if (!value) {
        errors.push(`Line ${i + 1}: Missing relationship description`);
        continue;
      }
      relationships.push({ fromId, toId, value });
    } else {
      errors.push(`Line ${i + 1}: Unknown type "${rowType}", expected "symbol" or "relationship"`);
    }
  }

  return { symbols, relationships, errors };
}
