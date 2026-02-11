import { describe, expect, it } from 'vitest';
import {
  parseAnnotationVerifyCsv,
  parseRelationshipVerifyCsv,
  verdictToSeverity,
} from '../../../src/commands/llm/_shared/verify/content-verifier.js';
import type { VerificationIssue } from '../../../src/commands/llm/_shared/verify/verify-types.js';

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

  // ============================================================
  // New fix action types compile correctly
  // ============================================================

  describe('fix action types', () => {
    it('reannotate-relationship action compiles and is valid', () => {
      const issue: VerificationIssue = {
        definitionId: 1,
        definitionName: 'TestDef',
        severity: 'error',
        category: 'wrong-relationship',
        message: 'Test',
        fixData: {
          action: 'reannotate-relationship',
          targetDefinitionId: 2,
          reason: 'Factually wrong description',
        },
      };
      expect(issue.fixData?.action).toBe('reannotate-relationship');
      expect(issue.fixData?.reason).toBe('Factually wrong description');
    });

    it('annotate-missing-relationship action compiles and is valid', () => {
      const issue: VerificationIssue = {
        severity: 'error',
        category: 'missing-relationship',
        message: 'Missing: A → B',
        fixData: {
          action: 'annotate-missing-relationship',
          targetDefinitionId: 3,
        },
      };
      expect(issue.fixData?.action).toBe('annotate-missing-relationship');
    });

    it('reannotate-definition action compiles and is valid', () => {
      const issue: VerificationIssue = {
        definitionId: 5,
        severity: 'error',
        category: 'wrong-purpose',
        message: 'purpose: Incorrect',
        fixData: {
          action: 'reannotate-definition',
          reason: 'Purpose is factually wrong',
        },
      };
      expect(issue.fixData?.action).toBe('reannotate-definition');
    });

    it('harmonize-domain action compiles and is valid', () => {
      const issue: VerificationIssue = {
        definitionId: 7,
        definitionName: 'helper',
        severity: 'warning',
        category: 'inconsistent-domain',
        message: 'Different domains',
        fixData: { action: 'harmonize-domain' },
      };
      expect(issue.fixData?.action).toBe('harmonize-domain');
    });
  });
});
