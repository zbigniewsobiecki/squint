/**
 * Unified CSV utilities for LLM response parsing.
 * Consolidates duplicate CSV parsing logic from flows.ts, interactions.ts, and other files.
 * Implements RFC 4180 compliant parsing.
 */

/**
 * Extract CSV content from LLM response (removes code fences).
 */
export function extractCsvContent(content: string): string {
  let csv = content.trim();
  const codeFenceMatch = csv.match(/```(?:csv)?\s*\n([\s\S]*?)\n```/);
  if (codeFenceMatch) {
    csv = codeFenceMatch[1].trim();
  }
  return csv;
}

/**
 * Split CSV content into logical lines, handling multi-line quoted values.
 * RFC 4180 compliant - handles escaped quotes and multi-line values.
 */
export function splitCsvLines(csv: string): string[] {
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
      // Skip carriage returns
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
 * Handles quoted fields and escaped quotes (RFC 4180).
 * Returns null if the row has unclosed quotes.
 */
export function parseRow(line: string): string[] | null {
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
 * Simple CSV line parser that handles quoted fields.
 * Use this for simple parsing needs where full RFC 4180 compliance isn't needed.
 */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);

  return fields;
}

/**
 * Format a value for CSV output.
 * Quotes fields that contain commas, quotes, or newlines.
 */
export function formatCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Parse CSV content with header validation.
 * Returns parsed rows as arrays of strings.
 */
export interface GenericCsvParseResult {
  header: string[];
  rows: string[][];
  errors: string[];
}

export function parseCsvWithHeader(
  content: string,
  expectedColumns: number,
  headerValidator?: (header: string[]) => boolean
): GenericCsvParseResult {
  const errors: string[] = [];
  const rows: string[][] = [];

  const csv = extractCsvContent(content);
  const lines = splitCsvLines(csv);

  if (lines.length === 0) {
    errors.push('Empty CSV content');
    return { header: [], rows, errors };
  }

  const header = parseRow(lines[0]);
  if (!header) {
    errors.push(`Invalid header row: ${lines[0]}`);
    return { header: [], rows, errors };
  }

  if (header.length !== expectedColumns) {
    errors.push(`Expected ${expectedColumns} columns in header, got ${header.length}`);
    return { header: [], rows, errors };
  }

  if (headerValidator && !headerValidator(header)) {
    errors.push(`Invalid header columns: ${header.join(',')}`);
    return { header: [], rows, errors };
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed) {
      errors.push(`Line ${i + 1}: Failed to parse row: ${line.substring(0, 50)}...`);
      continue;
    }

    if (parsed.length !== expectedColumns) {
      errors.push(`Line ${i + 1}: Expected ${expectedColumns} columns, got ${parsed.length}`);
      continue;
    }

    rows.push(parsed.map((v) => v.trim()));
  }

  return { header: header.map((h) => h.trim().toLowerCase()), rows, errors };
}

/**
 * Skip header row if present and filter empty lines.
 */
export function getDataLines(lines: string[], headerPrefix?: string): string[] {
  return lines.filter((l, i) => {
    const trimmed = l.trim();
    if (!trimmed) return false;
    if (i === 0 && headerPrefix && trimmed.toLowerCase().startsWith(headerPrefix.toLowerCase())) {
      return false;
    }
    return true;
  });
}
