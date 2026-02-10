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
 * Safely parse an integer from a CSV field, pushing an error if invalid.
 */
export function safeParseInt(value: string, fieldName: string, lineNum: number, errors: string[]): number | null {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    errors.push(`Line ${lineNum}: Invalid ${fieldName} "${value}"`);
    return null;
  }
  return n;
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
 * Generic mapper-based CSV parser. Handles shared boilerplate (extract content,
 * split lines, validate header, iterate rows, validate column count) and
 * delegates row-level logic to a callback.
 */
export interface CsvParseOptions<T> {
  /** Exact column count(s) accepted. Rows with other counts are rejected. */
  expectedColumns?: number | number[];
  /** Minimum column count accepted. Rows with fewer columns are rejected. */
  minColumns?: number;
  /** Optional header validation (receives raw header fields). */
  headerValidator?: (header: string[]) => boolean;
  /** Map trimmed columns to a domain object, or return null to skip the row. */
  rowMapper: (columns: string[], lineNum: number, errors: string[]) => T | null;
  /** Whether to skip the first row as a header (default: true). */
  skipHeader?: boolean;
}

export function parseCsvWithMapper<T>(content: string, options: CsvParseOptions<T>): { items: T[]; errors: string[] } {
  const errors: string[] = [];
  const items: T[] = [];
  const skipHeader = options.skipHeader !== false;

  const csv = extractCsvContent(content);
  const lines = splitCsvLines(csv);

  if (lines.length === 0) {
    errors.push('Empty CSV content');
    return { items, errors };
  }

  let startIndex = 0;

  if (skipHeader) {
    const header = parseRow(lines[0]);
    if (!header) {
      errors.push(`Invalid header row: ${lines[0]}`);
      return { items, errors };
    }

    if (options.expectedColumns !== undefined) {
      const expected = Array.isArray(options.expectedColumns) ? options.expectedColumns : [options.expectedColumns];
      if (!expected.includes(header.length)) {
        errors.push(`Expected ${expected.join(' or ')} columns in header, got ${header.length}`);
        return { items, errors };
      }
    }
    if (options.minColumns !== undefined && header.length < options.minColumns) {
      errors.push(`Expected at least ${options.minColumns} columns in header, got ${header.length}`);
      return { items, errors };
    }

    if (options.headerValidator && !options.headerValidator(header)) {
      errors.push(`Invalid header columns: ${header.join(',')}`);
      return { items, errors };
    }

    startIndex = 1;
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed) {
      errors.push(`Line ${i + 1}: Failed to parse row: ${line.substring(0, 50)}...`);
      continue;
    }

    if (options.expectedColumns !== undefined) {
      const expected = Array.isArray(options.expectedColumns) ? options.expectedColumns : [options.expectedColumns];
      if (!expected.includes(parsed.length)) {
        errors.push(
          `Line ${i + 1}: Expected ${expected.join(' or ')} columns, got ${parsed.length}: ${line.substring(0, 50)}...`
        );
        continue;
      }
    }
    if (options.minColumns !== undefined && parsed.length < options.minColumns) {
      errors.push(`Line ${i + 1}: Expected at least ${options.minColumns} columns, got ${parsed.length}`);
      continue;
    }

    const trimmed = parsed.map((v) => v.trim());
    const item = options.rowMapper(trimmed, i + 1, errors);
    if (item !== null) {
      items.push(item);
    }
  }

  return { items, errors };
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
