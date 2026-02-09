import { describe, expect, it } from 'vitest';
import {
  type CoverageInfo,
  type IterationSummary,
  type RelationshipCoverageInfo,
  filterCoverageForAspects,
  formatCoverageLine,
  formatCoverageStats,
  formatFinalSummary,
  formatIterationResults,
} from '../../../src/commands/llm/_shared/coverage.js';

describe('coverage', () => {
  // ============================================
  // formatCoverageLine
  // ============================================
  describe('formatCoverageLine', () => {
    it('formats a coverage line', () => {
      const coverage: CoverageInfo = { aspect: 'purpose', covered: 80, total: 100, percentage: 80 };
      const line = formatCoverageLine(coverage);
      expect(line).toContain('purpose');
      expect(line).toContain('80/100');
      expect(line).toContain('80.0%');
    });

    it('formats zero coverage', () => {
      const coverage: CoverageInfo = { aspect: 'domain', covered: 0, total: 50, percentage: 0 };
      const line = formatCoverageLine(coverage);
      expect(line).toContain('0/50');
      expect(line).toContain('0.0%');
    });

    it('formats 100% coverage', () => {
      const coverage: CoverageInfo = { aspect: 'role', covered: 25, total: 25, percentage: 100 };
      const line = formatCoverageLine(coverage);
      expect(line).toContain('25/25');
      expect(line).toContain('100.0%');
    });
  });

  // ============================================
  // formatCoverageStats
  // ============================================
  describe('formatCoverageStats', () => {
    it('formats multiple coverage lines', () => {
      const coverage: CoverageInfo[] = [
        { aspect: 'purpose', covered: 80, total: 100, percentage: 80 },
        { aspect: 'domain', covered: 30, total: 100, percentage: 30 },
      ];
      const lines = formatCoverageStats(coverage);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('purpose');
      expect(lines[1]).toContain('domain');
    });

    it('shows delta when previous coverage is provided', () => {
      const coverage: CoverageInfo[] = [{ aspect: 'purpose', covered: 85, total: 100, percentage: 85 }];
      const prev: CoverageInfo[] = [{ aspect: 'purpose', covered: 80, total: 100, percentage: 80 }];
      const lines = formatCoverageStats(coverage, prev);
      expect(lines[0]).toContain('+5');
    });

    it('does not show delta when covered count unchanged', () => {
      const coverage: CoverageInfo[] = [{ aspect: 'purpose', covered: 80, total: 100, percentage: 80 }];
      const prev: CoverageInfo[] = [{ aspect: 'purpose', covered: 80, total: 100, percentage: 80 }];
      const lines = formatCoverageStats(coverage, prev);
      expect(lines[0]).not.toContain('+');
    });

    it('handles no previous coverage', () => {
      const coverage: CoverageInfo[] = [{ aspect: 'purpose', covered: 50, total: 100, percentage: 50 }];
      const lines = formatCoverageStats(coverage);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('+');
    });
  });

  // ============================================
  // formatIterationResults
  // ============================================
  describe('formatIterationResults', () => {
    it('formats iteration with successful annotations', () => {
      const summary: IterationSummary = {
        iteration: 1,
        results: [
          { symbolId: 42, symbolName: 'Foo', aspect: 'purpose', value: 'Does stuff', success: true },
          { symbolId: 42, symbolName: 'Foo', aspect: 'domain', value: '["auth"]', success: true },
        ],
        relationshipResults: [],
        coverage: [{ aspect: 'purpose', covered: 1, total: 10, percentage: 10 }],
        relationshipCoverage: { annotated: 0, total: 5, percentage: 0 },
        readyCount: 5,
        blockedCount: 3,
      };

      const lines = formatIterationResults(summary);
      const output = lines.join('\n');
      expect(output).toContain('Iteration 1');
      expect(output).toContain('Foo');
      expect(output).toContain('Does stuff');
      expect(output).toContain('domain: ["auth"]');
      expect(output).toContain('Ready:');
      expect(output).toContain('Blocked:');
    });

    it('shows errors for failed annotations', () => {
      const summary: IterationSummary = {
        iteration: 1,
        results: [
          { symbolId: 42, symbolName: 'Foo', aspect: 'purpose', value: '', success: false, error: 'parse error' },
        ],
        relationshipResults: [],
        coverage: [],
        relationshipCoverage: { annotated: 0, total: 0, percentage: 0 },
        readyCount: 0,
        blockedCount: 0,
      };

      const lines = formatIterationResults(summary);
      const output = lines.join('\n');
      expect(output).toContain('parse error');
    });

    it('shows relationship results', () => {
      const summary: IterationSummary = {
        iteration: 1,
        results: [{ symbolId: 42, symbolName: 'Foo', aspect: 'purpose', value: 'test', success: true }],
        relationshipResults: [
          { fromId: 42, fromName: 'Foo', toId: 15, toName: 'Bar', value: 'uses service', success: true },
        ],
        coverage: [],
        relationshipCoverage: { annotated: 1, total: 5, percentage: 20 },
        readyCount: 0,
        blockedCount: 0,
      };

      const lines = formatIterationResults(summary);
      const output = lines.join('\n');
      expect(output).toContain('Bar');
      expect(output).toContain('uses service');
    });

    it('handles empty results', () => {
      const summary: IterationSummary = {
        iteration: 1,
        results: [],
        relationshipResults: [],
        coverage: [],
        relationshipCoverage: { annotated: 0, total: 0, percentage: 0 },
        readyCount: 0,
        blockedCount: 0,
      };

      const lines = formatIterationResults(summary);
      const output = lines.join('\n');
      expect(output).toContain('No annotations received');
    });
  });

  // ============================================
  // formatFinalSummary
  // ============================================
  describe('formatFinalSummary', () => {
    it('formats final summary with all stats', () => {
      const coverage: CoverageInfo[] = [{ aspect: 'purpose', covered: 90, total: 100, percentage: 90 }];
      const relCoverage: RelationshipCoverageInfo = { annotated: 40, total: 50, percentage: 80 };

      const lines = formatFinalSummary(200, 40, 5, 3, coverage, relCoverage);
      const output = lines.join('\n');
      expect(output).toContain('Annotation Complete');
      expect(output).toContain('Total iterations: 3');
      expect(output).toContain('200');
      expect(output).toContain('40');
      expect(output).toContain('Errors:');
      expect(output).toContain('5');
      expect(output).toContain('Final Coverage:');
      expect(output).toContain('purpose');
      expect(output).toContain('relationships:');
    });

    it('omits error line when zero errors', () => {
      const lines = formatFinalSummary(10, 5, 0, 1, [], { annotated: 0, total: 0, percentage: 0 });
      const output = lines.join('\n');
      expect(output).not.toContain('Errors:');
    });
  });

  // ============================================
  // filterCoverageForAspects
  // ============================================
  describe('filterCoverageForAspects', () => {
    it('returns existing coverage for matching aspects', () => {
      const allCoverage: CoverageInfo[] = [
        { aspect: 'purpose', covered: 80, total: 100, percentage: 80 },
        { aspect: 'domain', covered: 50, total: 100, percentage: 50 },
      ];

      const result = filterCoverageForAspects(allCoverage, ['purpose', 'domain'], 100);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ aspect: 'purpose', covered: 80, total: 100, percentage: 80 });
      expect(result[1]).toEqual({ aspect: 'domain', covered: 50, total: 100, percentage: 50 });
    });

    it('creates zero coverage for missing aspects', () => {
      const allCoverage: CoverageInfo[] = [{ aspect: 'purpose', covered: 80, total: 100, percentage: 80 }];

      const result = filterCoverageForAspects(allCoverage, ['purpose', 'role'], 200);
      expect(result).toHaveLength(2);
      expect(result[1]).toEqual({ aspect: 'role', covered: 0, total: 200, percentage: 0 });
    });

    it('handles empty allCoverage', () => {
      const result = filterCoverageForAspects([], ['purpose', 'domain'], 50);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ aspect: 'purpose', covered: 0, total: 50, percentage: 0 });
      expect(result[1]).toEqual({ aspect: 'domain', covered: 0, total: 50, percentage: 0 });
    });

    it('handles empty aspects', () => {
      const result = filterCoverageForAspects(
        [{ aspect: 'purpose', covered: 80, total: 100, percentage: 80 }],
        [],
        100
      );
      expect(result).toEqual([]);
    });
  });
});
