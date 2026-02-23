import { describe, expect, it } from 'vitest';
import {
  parseAnnotationVerifyCsv,
  parseModuleAssignmentVerifyCsv,
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
  // parseModuleAssignmentVerifyCsv
  // ============================================================

  describe('parseModuleAssignmentVerifyCsv', () => {
    it('well-formed CSV with header and suggested paths', () => {
      const csv = `definition_id,verdict,reason,suggested_module_path
100,correct,"controller handles customer CRUD operations",
207,wrong,"health check endpoint is infrastructure not customer-specific",project.backend.infrastructure
88,suspect,"generic error handler could be in shared utilities",`;
      const result = parseModuleAssignmentVerifyCsv(csv);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        definitionId: 100,
        verdict: 'correct',
        reason: 'controller handles customer CRUD operations',
        suggestedModulePath: null,
      });
      expect(result[1]).toEqual({
        definitionId: 207,
        verdict: 'wrong',
        reason: 'health check endpoint is infrastructure not customer-specific',
        suggestedModulePath: 'project.backend.infrastructure',
      });
      expect(result[2]).toEqual({
        definitionId: 88,
        verdict: 'suspect',
        reason: 'generic error handler could be in shared utilities',
        suggestedModulePath: null,
      });
    });

    it('minimal CSV without suggested_module_path column', () => {
      const csv = `definition_id,verdict,reason
42,wrong,Misassigned symbol`;
      const result = parseModuleAssignmentVerifyCsv(csv);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        definitionId: 42,
        verdict: 'wrong',
        reason: 'Misassigned symbol',
        suggestedModulePath: null,
      });
    });

    it('invalid definition ID → skipped', () => {
      const csv = `definition_id,verdict,reason
abc,wrong,Bad`;
      const result = parseModuleAssignmentVerifyCsv(csv);
      expect(result).toHaveLength(0);
    });

    it('missing columns → skipped', () => {
      const csv = `definition_id,verdict,reason
1,wrong`;
      const result = parseModuleAssignmentVerifyCsv(csv);
      expect(result).toHaveLength(0);
    });

    it('empty content', () => {
      const result = parseModuleAssignmentVerifyCsv('');
      expect(result).toHaveLength(0);
    });

    it('normalizes verdict to lowercase', () => {
      const csv = `definition_id,verdict,reason
10,WRONG,uppercase verdict`;
      const result = parseModuleAssignmentVerifyCsv(csv);
      expect(result).toHaveLength(1);
      expect(result[0].verdict).toBe('wrong');
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

    it('reassign-module action compiles and is valid', () => {
      const issue: VerificationIssue = {
        definitionId: 10,
        definitionName: 'healthController',
        filePath: '/src/controllers/health.ts',
        severity: 'error',
        category: 'wrong-module-assignment',
        message: 'health check is infrastructure, not customer-specific',
        fixData: {
          action: 'reassign-module',
          reason: 'health check is infrastructure, not customer-specific',
          targetModuleId: 5,
        },
      };
      expect(issue.fixData?.action).toBe('reassign-module');
      expect(issue.fixData?.targetModuleId).toBe(5);
    });
  });
});
