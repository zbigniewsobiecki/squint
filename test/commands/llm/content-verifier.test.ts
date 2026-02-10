import { describe, expect, it } from 'vitest';
import {
  parseAnnotationVerifyCsv,
  parseRelationshipVerifyCsv,
  verdictToSeverity,
} from '../../../src/commands/llm/_shared/verify/content-verifier.js';

describe('content-verifier parse functions', () => {
  // ============================================================
  // parseAnnotationVerifyCsv
  // ============================================================

  describe('parseAnnotationVerifyCsv', () => {
    it('well-formed CSV with header', () => {
      const csv = `definition_id,check,verdict,reason
1,purpose,correct,Matches intent
2,domain,wrong,Incorrect domain assignment`;
      const result = parseAnnotationVerifyCsv(csv);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        definitionId: 1,
        check: 'purpose',
        verdict: 'correct',
        reason: 'Matches intent',
      });
      expect(result[1]).toEqual({
        definitionId: 2,
        check: 'domain',
        verdict: 'wrong',
        reason: 'Incorrect domain assignment',
      });
    });

    it('invalid definition ID → skipped', () => {
      const csv = `definition_id,check,verdict,reason
abc,purpose,correct,Fine`;
      const result = parseAnnotationVerifyCsv(csv);
      expect(result).toHaveLength(0);
    });

    it('missing columns → skipped', () => {
      const csv = `definition_id,check,verdict,reason
1,purpose`;
      const result = parseAnnotationVerifyCsv(csv);
      expect(result).toHaveLength(0);
    });

    it('empty content', () => {
      const result = parseAnnotationVerifyCsv('');
      expect(result).toHaveLength(0);
    });
  });

  // ============================================================
  // parseRelationshipVerifyCsv
  // ============================================================

  describe('parseRelationshipVerifyCsv', () => {
    it('well-formed CSV', () => {
      const csv = `from_id,to_id,verdict,reason
1,2,correct,Accurate relationship
3,4,wrong,Reversed direction`;
      const result = parseRelationshipVerifyCsv(csv);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        fromId: 1,
        toId: 2,
        verdict: 'correct',
        reason: 'Accurate relationship',
      });
    });

    it('invalid from/to IDs → skipped', () => {
      const csv = `from_id,to_id,verdict,reason
abc,2,wrong,Bad
1,xyz,wrong,Bad`;
      const result = parseRelationshipVerifyCsv(csv);
      expect(result).toHaveLength(0);
    });

    it('missing columns → skipped', () => {
      const csv = `from_id,to_id,verdict,reason
1,2`;
      const result = parseRelationshipVerifyCsv(csv);
      expect(result).toHaveLength(0);
    });

    it('empty content', () => {
      const result = parseRelationshipVerifyCsv('');
      expect(result).toHaveLength(0);
    });
  });

  // ============================================================
  // verdictToSeverity
  // ============================================================

  describe('verdictToSeverity', () => {
    it('"wrong" → "error"', () => {
      expect(verdictToSeverity('wrong')).toBe('error');
    });

    it('"suspect" → "warning"', () => {
      expect(verdictToSeverity('suspect')).toBe('warning');
    });

    it('"correct" → null', () => {
      expect(verdictToSeverity('correct')).toBeNull();
    });
  });
});
