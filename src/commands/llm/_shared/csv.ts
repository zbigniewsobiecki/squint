/**
 * RFC 4180 CSV parser - no external dependencies
 * Handles quoted fields, escaped quotes, and multi-line values.
 */

import { formatCsvValue, parseCsvWithMapper, safeParseInt } from './csv-utils.js';

export { formatCsvValue };

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
 */
export function parseCsv(content: string): ParseResult {
  const { items, errors } = parseCsvWithMapper<CsvRow>(content, {
    expectedColumns: 3,
    headerValidator: (h) => {
      const norm = h.map((s) => s.toLowerCase().trim());
      return norm[0] === 'id' && norm[1] === 'aspect' && norm[2] === 'value';
    },
    rowMapper: (cols, lineNum, errs) => {
      if (!cols[0] || !cols[1]) {
        errs.push(`Line ${lineNum}: Missing id or aspect`);
        return null;
      }
      return { id: cols[0], aspect: cols[1], value: cols[2] };
    },
  });
  return { rows: items, errors };
}

/**
 * Parse combined CSV content for symbol and relationship annotations.
 * Expects header row: type,id,field,value
 */
export function parseCombinedCsv(content: string): CombinedParseResult {
  type CombinedRow =
    | { kind: 'symbol'; data: SymbolAnnotationRow }
    | { kind: 'relationship'; data: RelationshipAnnotationRow };

  const { items, errors } = parseCsvWithMapper<CombinedRow>(content, {
    expectedColumns: 4,
    headerValidator: (h) => {
      const norm = h.map((s) => s.toLowerCase().trim());
      return norm[0] === 'type' && norm[1] === 'id' && norm[2] === 'field' && norm[3] === 'value';
    },
    rowMapper: (cols, lineNum, errs) => {
      const [rowType, id, field, value] = cols;

      if (rowType === 'symbol') {
        const symbolId = safeParseInt(id, 'symbol ID', lineNum, errs);
        if (symbolId === null) return null;
        if (!field) {
          errs.push(`Line ${lineNum}: Missing aspect name`);
          return null;
        }
        return { kind: 'symbol', data: { symbolId, aspect: field, value } };
      }
      if (rowType === 'relationship') {
        const fromId = safeParseInt(id, 'from_id', lineNum, errs);
        if (fromId === null) return null;
        const toId = safeParseInt(field, 'to_id', lineNum, errs);
        if (toId === null) return null;
        if (!value) {
          errs.push(`Line ${lineNum}: Missing relationship description`);
          return null;
        }
        return { kind: 'relationship', data: { fromId, toId, value } };
      }
      errs.push(`Line ${lineNum}: Unknown type "${rowType}", expected "symbol" or "relationship"`);
      return null;
    },
  });

  return {
    symbols: items.filter((i): i is CombinedRow & { kind: 'symbol' } => i.kind === 'symbol').map((i) => i.data),
    relationships: items
      .filter((i): i is CombinedRow & { kind: 'relationship' } => i.kind === 'relationship')
      .map((i) => i.data),
    errors,
  };
}
