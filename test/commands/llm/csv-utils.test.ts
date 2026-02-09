import { describe, expect, it } from 'vitest';
import {
  extractCsvContent,
  formatCsvValue,
  getDataLines,
  parseCSVLine,
  parseCsvWithHeader,
  parseRow,
  splitCsvLines,
} from '../../../src/commands/llm/_shared/csv-utils.js';

describe('csv-utils', () => {
  // ============================================
  // extractCsvContent
  // ============================================
  describe('extractCsvContent', () => {
    it('returns plain CSV as-is (trimmed)', () => {
      const input = '  id,name\n1,Alice  ';
      expect(extractCsvContent(input)).toBe('id,name\n1,Alice');
    });

    it('strips ```csv code fence', () => {
      const input = '```csv\nid,name\n1,Alice\n```';
      expect(extractCsvContent(input)).toBe('id,name\n1,Alice');
    });

    it('strips ``` code fence without language tag', () => {
      const input = '```\nid,name\n1,Alice\n```';
      expect(extractCsvContent(input)).toBe('id,name\n1,Alice');
    });

    it('handles surrounding text outside code fence', () => {
      const input = 'Here is the CSV:\n```csv\nid,name\n1,Alice\n```\nDone.';
      expect(extractCsvContent(input)).toBe('id,name\n1,Alice');
    });

    it('handles empty input', () => {
      expect(extractCsvContent('')).toBe('');
      expect(extractCsvContent('   ')).toBe('');
    });
  });

  // ============================================
  // splitCsvLines
  // ============================================
  describe('splitCsvLines', () => {
    it('splits simple lines', () => {
      expect(splitCsvLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
    });

    it('handles carriage returns', () => {
      expect(splitCsvLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
    });

    it('keeps multi-line quoted values on one logical line', () => {
      const csv = 'id,"value with\nnewline"\nnext';
      const lines = splitCsvLines(csv);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('value with\nnewline');
      expect(lines[1]).toBe('next');
    });

    it('handles escaped quotes inside multi-line values', () => {
      const csv = 'id,"she said ""hi""\nand left"\nnext';
      const lines = splitCsvLines(csv);
      expect(lines).toHaveLength(2);
    });

    it('returns empty array for empty string', () => {
      expect(splitCsvLines('')).toEqual([]);
    });

    it('handles single line without newline', () => {
      expect(splitCsvLines('a,b,c')).toEqual(['a,b,c']);
    });
  });

  // ============================================
  // parseRow
  // ============================================
  describe('parseRow', () => {
    it('parses simple unquoted row', () => {
      expect(parseRow('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('parses quoted fields', () => {
      expect(parseRow('"hello","world"')).toEqual(['hello', 'world']);
    });

    it('handles escaped quotes (doubled)', () => {
      expect(parseRow('"she said ""hi"""')).toEqual(['she said "hi"']);
    });

    it('handles commas inside quoted fields', () => {
      expect(parseRow('"a,b",c')).toEqual(['a,b', 'c']);
    });

    it('handles mixed quoted and unquoted', () => {
      expect(parseRow('plain,"quoted",123')).toEqual(['plain', 'quoted', '123']);
    });

    it('returns null for unclosed quote', () => {
      expect(parseRow('"unclosed')).toBeNull();
    });

    it('handles empty fields', () => {
      expect(parseRow('a,,c')).toEqual(['a', '', 'c']);
    });

    it('handles single column', () => {
      expect(parseRow('alone')).toEqual(['alone']);
    });

    it('handles empty string', () => {
      expect(parseRow('')).toEqual(['']);
    });

    it('handles empty quoted field', () => {
      expect(parseRow('""')).toEqual(['']);
    });
  });

  // ============================================
  // parseCSVLine
  // ============================================
  describe('parseCSVLine', () => {
    it('parses simple fields', () => {
      expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('handles quoted fields (strips quotes from toggle)', () => {
      // parseCSVLine toggles inQuotes but doesn't strip quotes from the output value
      const result = parseCSVLine('"hello","world"');
      expect(result).toEqual(['hello', 'world']);
    });

    it('handles commas inside quotes', () => {
      const result = parseCSVLine('"a,b",c');
      expect(result).toEqual(['a,b', 'c']);
    });
  });

  // ============================================
  // formatCsvValue
  // ============================================
  describe('formatCsvValue', () => {
    it('returns simple values unchanged', () => {
      expect(formatCsvValue('hello')).toBe('hello');
    });

    it('quotes values with commas', () => {
      expect(formatCsvValue('a,b')).toBe('"a,b"');
    });

    it('quotes values with newlines', () => {
      expect(formatCsvValue('line1\nline2')).toBe('"line1\nline2"');
    });

    it('doubles existing quotes and wraps', () => {
      expect(formatCsvValue('she said "hi"')).toBe('"she said ""hi"""');
    });

    it('handles values with commas and quotes combined', () => {
      expect(formatCsvValue('a,"b"')).toBe('"a,""b"""');
    });
  });

  // ============================================
  // parseCsvWithHeader
  // ============================================
  describe('parseCsvWithHeader', () => {
    it('parses valid CSV with header', () => {
      const csv = 'type,id,value\nfoo,1,bar\nbaz,2,qux';
      const result = parseCsvWithHeader(csv, 3);
      expect(result.errors).toEqual([]);
      expect(result.header).toEqual(['type', 'id', 'value']);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual(['foo', '1', 'bar']);
      expect(result.rows[1]).toEqual(['baz', '2', 'qux']);
    });

    it('reports error on empty content', () => {
      const result = parseCsvWithHeader('', 3);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Empty CSV content');
    });

    it('reports error on wrong column count in header', () => {
      const result = parseCsvWithHeader('a,b\n1,2', 3);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Expected 3 columns');
    });

    it('skips empty lines in body', () => {
      const csv = 'a,b,c\n1,2,3\n\n4,5,6';
      const result = parseCsvWithHeader(csv, 3);
      expect(result.rows).toHaveLength(2);
    });

    it('reports error on wrong column count in data row', () => {
      const csv = 'a,b,c\n1,2\n4,5,6';
      const result = parseCsvWithHeader(csv, 3);
      expect(result.rows).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Expected 3 columns, got 2');
    });

    it('strips code fences before parsing', () => {
      const csv = '```csv\na,b\n1,2\n```';
      const result = parseCsvWithHeader(csv, 2);
      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);
    });

    it('applies custom header validator', () => {
      const csv = 'wrong,header\n1,2';
      const result = parseCsvWithHeader(csv, 2, (h) => h[0].toLowerCase() === 'correct');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Invalid header columns');
    });

    it('lowercases and trims header values', () => {
      const csv = ' Type , Id , Value \n1,2,3';
      const result = parseCsvWithHeader(csv, 3);
      expect(result.header).toEqual(['type', 'id', 'value']);
    });

    it('trims cell values in data rows', () => {
      const csv = 'a,b\n  hello  ,  world  ';
      const result = parseCsvWithHeader(csv, 2);
      expect(result.rows[0]).toEqual(['hello', 'world']);
    });

    it('reports error on unparseable header (unclosed quote)', () => {
      const csv = '"unclosed\n1,2';
      // The splitCsvLines will keep the unclosed quote line going.
      // The header won't parse properly.
      const result = parseCsvWithHeader(csv, 2);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // getDataLines
  // ============================================
  describe('getDataLines', () => {
    it('filters empty lines', () => {
      expect(getDataLines(['a', '', 'b', '  ', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('skips header row when prefix matches', () => {
      expect(getDataLines(['type,id,value', '1,2,3'], 'type')).toEqual(['1,2,3']);
    });

    it('does not skip header when prefix does not match', () => {
      expect(getDataLines(['data,id,value', '1,2,3'], 'type')).toEqual(['data,id,value', '1,2,3']);
    });

    it('header matching is case-insensitive', () => {
      expect(getDataLines(['TYPE,ID', '1,2'], 'type')).toEqual(['1,2']);
    });

    it('returns empty for all-empty lines', () => {
      expect(getDataLines(['', '  ', ''])).toEqual([]);
    });
  });
});
