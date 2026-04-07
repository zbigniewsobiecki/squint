import { describe, expect, it } from 'vitest';
import type { DiffReport } from '../types.js';
import { renderJsonReport, renderMarkdownReport } from './index.js';

/**
 * Reporter tests use frozen DiffReport inputs and assert on the rendered
 * output. Snapshot-style: precise enough to catch regressions in formatting
 * but not so brittle that minor wording changes break everything.
 */
describe('reporter', () => {
  const passingReport: DiffReport = {
    fixtureName: 'todo-api',
    passed: true,
    scope: ['files', 'definitions'],
    tables: [
      {
        table: 'files',
        passed: true,
        expectedCount: 13,
        producedCount: 13,
        diffs: [],
      },
      {
        table: 'definitions',
        passed: true,
        expectedCount: 42,
        producedCount: 42,
        diffs: [],
      },
    ],
    summary: { critical: 0, major: 0, minor: 0, proseChecks: { passed: 0, failed: 0 } },
    durationMs: 1234,
    squintCommit: 'c938a65',
  };

  const failingReport: DiffReport = {
    fixtureName: 'todo-api',
    passed: false,
    scope: ['files', 'definitions', 'contracts'],
    tables: [
      { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
      {
        table: 'definitions',
        passed: false,
        expectedCount: 42,
        producedCount: 41,
        diffs: [
          {
            kind: 'missing',
            severity: 'critical',
            naturalKey: 'src/foo.ts::missingFn',
            details: 'Definition missing',
          },
          {
            kind: 'mismatch',
            severity: 'minor',
            naturalKey: 'src/foo.ts::Foo',
            details: 'line: expected 5 (±2), produced 12',
          },
        ],
      },
      {
        table: 'contracts',
        passed: false,
        expectedCount: 4,
        producedCount: 3,
        diffs: [
          {
            kind: 'missing',
            severity: 'critical',
            naturalKey: 'events::task.completed',
            details: 'Contract missing',
            fixHintId: 'events-pubsub-detection',
          },
        ],
      },
    ],
    summary: { critical: 2, major: 0, minor: 1, proseChecks: { passed: 0, failed: 0 } },
    durationMs: 5432,
    squintCommit: 'abc1234',
  };

  describe('renderMarkdownReport', () => {
    it('starts with a header containing the fixture name and pass/fail badge', () => {
      const md = renderMarkdownReport(passingReport);
      expect(md).toContain('# Squint Eval Report — todo-api');
      expect(md).toContain('PASS');
    });

    it('shows fail badge for failing reports', () => {
      const md = renderMarkdownReport(failingReport);
      expect(md).toContain('FAIL');
    });

    it('lists per-table sections with counts', () => {
      const md = renderMarkdownReport(passingReport);
      expect(md).toContain('## Table: files');
      expect(md).toContain('13/13');
      expect(md).toContain('## Table: definitions');
      expect(md).toContain('42/42');
    });

    it('renders critical diffs with prominent severity tags', () => {
      const md = renderMarkdownReport(failingReport);
      expect(md).toContain('CRITICAL');
      expect(md).toContain('src/foo.ts::missingFn');
      expect(md).toContain('events::task.completed');
    });

    it('groups diffs by severity within a table section', () => {
      const md = renderMarkdownReport(failingReport);
      // Critical section should appear before minor in the definitions block
      const defsSection = md.split('## Table: definitions')[1].split('## Table:')[0];
      const criticalIdx = defsSection.indexOf('CRITICAL');
      const minorIdx = defsSection.indexOf('Minor');
      expect(criticalIdx).toBeGreaterThan(-1);
      expect(minorIdx).toBeGreaterThan(criticalIdx);
    });

    it('shows the summary line with severity counts', () => {
      const md = renderMarkdownReport(failingReport);
      expect(md).toMatch(/Critical:\s*2/);
      expect(md).toMatch(/Major:\s*0/);
      expect(md).toMatch(/Minor:\s*1/);
    });

    it('includes the squint commit', () => {
      const md = renderMarkdownReport(passingReport);
      expect(md).toContain('c938a65');
    });

    it('shows fix-hint id when present', () => {
      const md = renderMarkdownReport(failingReport);
      expect(md).toContain('events-pubsub-detection');
    });
  });

  describe('renderJsonReport', () => {
    it('produces valid JSON', () => {
      const json = renderJsonReport(passingReport);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('preserves all critical fields', () => {
      const json = renderJsonReport(failingReport);
      const parsed = JSON.parse(json) as DiffReport;
      expect(parsed.fixtureName).toBe('todo-api');
      expect(parsed.passed).toBe(false);
      expect(parsed.summary.critical).toBe(2);
      expect(parsed.tables).toHaveLength(3);
      expect(parsed.tables[1].diffs).toHaveLength(2);
    });

    it('is pretty-printed (multi-line)', () => {
      const json = renderJsonReport(passingReport);
      expect(json.split('\n').length).toBeGreaterThan(5);
    });
  });
});
