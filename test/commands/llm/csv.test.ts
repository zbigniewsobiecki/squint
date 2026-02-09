import { describe, expect, it } from 'vitest';
import { formatCsvValue, parseCombinedCsv, parseCsv } from '../../../src/commands/llm/_shared/csv.js';

describe('csv', () => {
  // ============================================
  // parseCsv
  // ============================================
  describe('parseCsv', () => {
    it('parses valid CSV with correct header', () => {
      const csv = 'id,aspect,value\n1,purpose,Does something\n2,domain,"[""auth""]"';
      const result = parseCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({ id: '1', aspect: 'purpose', value: 'Does something' });
      expect(result.rows[1]).toEqual({ id: '2', aspect: 'domain', value: '["auth"]' });
    });

    it('strips code fences', () => {
      const csv = '```csv\nid,aspect,value\n1,purpose,hello\n```';
      const result = parseCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);
    });

    it('reports error on empty content', () => {
      const result = parseCsv('');
      expect(result.rows).toEqual([]);
      expect(result.errors[0]).toContain('Empty CSV content');
    });

    it('reports error on invalid header', () => {
      const result = parseCsv('wrong,header,names\n1,2,3');
      expect(result.rows).toEqual([]);
      expect(result.errors[0]).toContain('Invalid header columns');
    });

    it('reports error on wrong column count in header', () => {
      const result = parseCsv('id,aspect\n1,purpose');
      expect(result.rows).toEqual([]);
      expect(result.errors[0]).toContain('Invalid header row');
    });

    it('reports error on wrong column count in data row', () => {
      const csv = 'id,aspect,value\n1,purpose';
      const result = parseCsv(csv);
      expect(result.rows).toEqual([]);
      expect(result.errors[0]).toContain('Expected 3 columns, got 2');
    });

    it('reports error on missing id or aspect', () => {
      const csv = 'id,aspect,value\n,purpose,hello\n1,,world';
      const result = parseCsv(csv);
      expect(result.rows).toEqual([]);
      expect(result.errors).toHaveLength(2);
    });

    it('skips empty lines', () => {
      const csv = 'id,aspect,value\n\n1,purpose,hello\n\n';
      const result = parseCsv(csv);
      expect(result.rows).toHaveLength(1);
    });

    it('trims id, aspect, and value', () => {
      const csv = 'id,aspect,value\n  1  ,  purpose  ,  hello world  ';
      const result = parseCsv(csv);
      expect(result.rows[0]).toEqual({ id: '1', aspect: 'purpose', value: 'hello world' });
    });

    it('handles quoted values with commas', () => {
      const csv = 'id,aspect,value\n1,purpose,"does A, B, and C"';
      const result = parseCsv(csv);
      expect(result.rows[0].value).toBe('does A, B, and C');
    });

    it('handles quoted values with escaped quotes', () => {
      const csv = 'id,aspect,value\n1,purpose,"says ""hello"""';
      const result = parseCsv(csv);
      expect(result.rows[0].value).toBe('says "hello"');
    });

    it('handles multi-line quoted values', () => {
      const csv = 'id,aspect,value\n1,purpose,"line1\nline2"';
      const result = parseCsv(csv);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].value).toBe('line1\nline2');
    });

    it('is case-insensitive for header', () => {
      const csv = 'ID,Aspect,Value\n1,purpose,test';
      const result = parseCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);
    });
  });

  // ============================================
  // parseCombinedCsv
  // ============================================
  describe('parseCombinedCsv', () => {
    it('parses symbol annotations', () => {
      const csv = 'type,id,field,value\nsymbol,42,purpose,Handles auth\nsymbol,42,domain,"[""auth""]"';
      const result = parseCombinedCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]).toEqual({ symbolId: 42, aspect: 'purpose', value: 'Handles auth' });
      expect(result.symbols[1]).toEqual({ symbolId: 42, aspect: 'domain', value: '["auth"]' });
    });

    it('parses relationship annotations', () => {
      const csv = 'type,id,field,value\nrelationship,42,15,delegates auth to service';
      const result = parseCombinedCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0]).toEqual({
        fromId: 42,
        toId: 15,
        value: 'delegates auth to service',
      });
    });

    it('parses mixed symbols and relationships', () => {
      const csv =
        'type,id,field,value\nsymbol,42,purpose,Auth handler\nrelationship,42,15,uses service\nsymbol,43,role,controller';
      const result = parseCombinedCsv(csv);
      expect(result.symbols).toHaveLength(2);
      expect(result.relationships).toHaveLength(1);
      expect(result.errors).toEqual([]);
    });

    it('reports error on empty content', () => {
      const result = parseCombinedCsv('');
      expect(result.errors[0]).toContain('Empty CSV content');
    });

    it('reports error on invalid header', () => {
      const result = parseCombinedCsv('a,b,c,d\n1,2,3,4');
      expect(result.errors[0]).toContain('Invalid header columns');
    });

    it('reports error on wrong column count', () => {
      const result = parseCombinedCsv('type,id\n1,2');
      expect(result.errors[0]).toContain('Invalid header row');
    });

    it('reports error on non-numeric symbol ID', () => {
      const csv = 'type,id,field,value\nsymbol,abc,purpose,test';
      const result = parseCombinedCsv(csv);
      expect(result.errors[0]).toContain('Invalid symbol ID');
    });

    it('reports error on missing aspect name for symbol', () => {
      const csv = 'type,id,field,value\nsymbol,42,,test';
      const result = parseCombinedCsv(csv);
      expect(result.errors[0]).toContain('Missing aspect name');
    });

    it('reports error on non-numeric relationship from_id', () => {
      const csv = 'type,id,field,value\nrelationship,abc,15,test';
      const result = parseCombinedCsv(csv);
      expect(result.errors[0]).toContain('Invalid from_id');
    });

    it('reports error on non-numeric relationship to_id', () => {
      const csv = 'type,id,field,value\nrelationship,42,abc,test';
      const result = parseCombinedCsv(csv);
      expect(result.errors[0]).toContain('Invalid to_id');
    });

    it('reports error on missing relationship description', () => {
      const csv = 'type,id,field,value\nrelationship,42,15,';
      const result = parseCombinedCsv(csv);
      expect(result.errors[0]).toContain('Missing relationship description');
    });

    it('reports error on unknown type', () => {
      const csv = 'type,id,field,value\nunknown,42,purpose,test';
      const result = parseCombinedCsv(csv);
      expect(result.errors[0]).toContain('Unknown type "unknown"');
    });

    it('skips empty lines', () => {
      const csv = 'type,id,field,value\n\nsymbol,1,purpose,test\n\n';
      const result = parseCombinedCsv(csv);
      expect(result.symbols).toHaveLength(1);
    });

    it('strips code fences', () => {
      const csv = '```csv\ntype,id,field,value\nsymbol,1,purpose,test\n```';
      const result = parseCombinedCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.symbols).toHaveLength(1);
    });

    it('trims all values', () => {
      const csv = 'type,id,field,value\n  symbol  ,  42  ,  purpose  ,  hello  ';
      const result = parseCombinedCsv(csv);
      expect(result.symbols[0]).toEqual({ symbolId: 42, aspect: 'purpose', value: 'hello' });
    });
  });

  // ============================================
  // formatCsvValue
  // ============================================
  describe('formatCsvValue', () => {
    it('returns plain values unchanged', () => {
      expect(formatCsvValue('simple')).toBe('simple');
    });

    it('quotes values with commas', () => {
      expect(formatCsvValue('a,b')).toBe('"a,b"');
    });

    it('quotes and escapes values with quotes', () => {
      expect(formatCsvValue('say "hi"')).toBe('"say ""hi"""');
    });

    it('quotes values with newlines', () => {
      expect(formatCsvValue('a\nb')).toBe('"a\nb"');
    });
  });
});
