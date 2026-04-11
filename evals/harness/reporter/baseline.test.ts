import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffReport } from '../types.js';
import { computeBaselineFromReport, loadBaseline, updateBaseline } from './baseline.js';

/**
 * The baseline scoreboard at evals/baselines/<fixture>.json tracks
 * pass-rate per stage across iterations. The reporter computes a delta
 * (improvements vs regressions) when updating it so PR review can see
 * progress at a glance.
 */
describe('baseline scoreboard', () => {
  let dir: string;
  let baselinePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-eval-base-'));
    baselinePath = path.join(dir, 'todo-api.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sampleReport: DiffReport = {
    fixtureName: 'todo-api',
    passed: true,
    scope: ['files', 'definitions'],
    tables: [
      { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
      { table: 'definitions', passed: true, expectedCount: 42, producedCount: 42, diffs: [] },
    ],
    summary: { critical: 0, major: 0, minor: 0, proseChecks: { passed: 0, failed: 0 } },
    durationMs: 1000,
    squintCommit: 'abc123',
  };

  describe('computeBaselineFromReport', () => {
    it('extracts a stage scorecard from the report', () => {
      const baseline = computeBaselineFromReport(sampleReport);
      expect(baseline.fixture).toBe('todo-api');
      expect(baseline.squintCommit).toBe('abc123');
      expect(baseline.tableScores).toEqual({
        files: { passed: true, expected: 13, produced: 13, critical: 0, major: 0, minor: 0 },
        definitions: { passed: true, expected: 42, produced: 42, critical: 0, major: 0, minor: 0 },
      });
    });

    it('counts diffs by severity per table', () => {
      const failingReport: DiffReport = {
        ...sampleReport,
        passed: false,
        tables: [
          {
            table: 'definitions',
            passed: false,
            expectedCount: 42,
            producedCount: 40,
            diffs: [
              { kind: 'missing', severity: 'critical', naturalKey: 'a', details: '' },
              { kind: 'mismatch', severity: 'major', naturalKey: 'b', details: '' },
              { kind: 'mismatch', severity: 'minor', naturalKey: 'c', details: '' },
              { kind: 'mismatch', severity: 'minor', naturalKey: 'd', details: '' },
            ],
          },
        ],
        summary: { critical: 1, major: 1, minor: 2, proseChecks: { passed: 0, failed: 0 } },
      };
      const baseline = computeBaselineFromReport(failingReport);
      expect(baseline.tableScores.definitions).toEqual({
        passed: false,
        expected: 42,
        produced: 40,
        critical: 1,
        major: 1,
        minor: 2,
      });
    });
  });

  describe('loadBaseline', () => {
    it('returns null if no baseline file exists', () => {
      expect(loadBaseline(baselinePath)).toBeNull();
    });

    it('parses an existing baseline JSON file', () => {
      const baseline = computeBaselineFromReport(sampleReport);
      fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
      const loaded = loadBaseline(baselinePath);
      expect(loaded?.fixture).toBe('todo-api');
      expect(loaded?.tableScores.files?.passed).toBe(true);
    });
  });

  describe('updateBaseline', () => {
    it('writes a new baseline file', () => {
      const result = updateBaseline(baselinePath, sampleReport);
      expect(fs.existsSync(baselinePath)).toBe(true);
      expect(result.improvements).toEqual([]);
      expect(result.regressions).toEqual([]);
    });

    it('detects regressions vs prior baseline', () => {
      // Write a passing baseline first
      updateBaseline(baselinePath, sampleReport);
      // Now produce a failing report
      const failing: DiffReport = {
        ...sampleReport,
        passed: false,
        tables: [
          { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
          {
            table: 'definitions',
            passed: false,
            expectedCount: 42,
            producedCount: 40,
            diffs: [{ kind: 'missing', severity: 'critical', naturalKey: 'x', details: '' }],
          },
        ],
        summary: { critical: 1, major: 0, minor: 0, proseChecks: { passed: 0, failed: 0 } },
      };
      const result = updateBaseline(baselinePath, failing);
      expect(result.regressions).toEqual([expect.stringContaining('definitions')]);
      expect(result.improvements).toEqual([]);
    });

    it('detects improvements vs prior baseline', () => {
      const failing: DiffReport = {
        ...sampleReport,
        passed: false,
        tables: [
          { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
          {
            table: 'definitions',
            passed: false,
            expectedCount: 42,
            producedCount: 40,
            diffs: [{ kind: 'missing', severity: 'critical', naturalKey: 'x', details: '' }],
          },
        ],
        summary: { critical: 1, major: 0, minor: 0, proseChecks: { passed: 0, failed: 0 } },
      };
      updateBaseline(baselinePath, failing);
      const result = updateBaseline(baselinePath, sampleReport);
      expect(result.improvements).toEqual([expect.stringContaining('definitions')]);
      expect(result.regressions).toEqual([]);
    });
  });

  // PR2: prose-drift counters live alongside the structural counters in
  // the baseline so the persisted scoreboard can ratchet drift down across
  // runs. Without these the existing severity counters never see prose drift
  // (it goes only to TableDiff.proseChecks) and the regression check is blind
  // to whether a run got better or worse on the LLM-driven aspects.
  describe('proseChecks tracking', () => {
    const reportWithProse: DiffReport = {
      fixtureName: 'todo-api',
      passed: true,
      scope: ['files', 'definition_metadata'],
      tables: [
        { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
        {
          table: 'definition_metadata',
          passed: true,
          expectedCount: 30,
          producedCount: 30,
          diffs: [],
          proseChecks: { passed: 28, failed: 2 },
        },
      ],
      summary: { critical: 0, major: 0, minor: 0, proseChecks: { passed: 28, failed: 2 } },
      durationMs: 1000,
      squintCommit: 'abc123',
    };

    it('computeBaselineFromReport copies proseChecks onto the per-table score', () => {
      const baseline = computeBaselineFromReport(reportWithProse);
      expect(baseline.tableScores.definition_metadata?.proseChecks).toEqual({ passed: 28, failed: 2 });
    });

    it('omits proseChecks for tables that never had any (e.g. files)', () => {
      const baseline = computeBaselineFromReport(reportWithProse);
      expect(baseline.tableScores.files?.proseChecks).toBeUndefined();
    });

    it('updateBaseline reports an improvement when prose drift drops', () => {
      // Prior: 5 failures
      const prior: DiffReport = {
        ...reportWithProse,
        tables: [
          { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
          {
            table: 'definition_metadata',
            passed: true,
            expectedCount: 30,
            producedCount: 30,
            diffs: [],
            proseChecks: { passed: 25, failed: 5 },
          },
        ],
      };
      updateBaseline(baselinePath, prior);
      // Next: 0 failures
      const next: DiffReport = {
        ...reportWithProse,
        tables: [
          { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
          {
            table: 'definition_metadata',
            passed: true,
            expectedCount: 30,
            producedCount: 30,
            diffs: [],
            proseChecks: { passed: 30, failed: 0 },
          },
        ],
      };
      const result = updateBaseline(baselinePath, next);
      expect(result.improvements).toEqual(
        expect.arrayContaining([expect.stringContaining('definition_metadata: 5 → 0 prose drifts')])
      );
      expect(result.regressions).toEqual([]);
    });

    it('updateBaseline reports a regression when prose drift rises', () => {
      const prior: DiffReport = {
        ...reportWithProse,
        tables: [
          { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
          {
            table: 'definition_metadata',
            passed: true,
            expectedCount: 30,
            producedCount: 30,
            diffs: [],
            proseChecks: { passed: 30, failed: 0 },
          },
        ],
      };
      updateBaseline(baselinePath, prior);
      const next: DiffReport = {
        ...reportWithProse,
        tables: [
          { table: 'files', passed: true, expectedCount: 13, producedCount: 13, diffs: [] },
          {
            table: 'definition_metadata',
            passed: true,
            expectedCount: 30,
            producedCount: 30,
            diffs: [],
            proseChecks: { passed: 27, failed: 3 },
          },
        ],
      };
      const result = updateBaseline(baselinePath, next);
      expect(result.regressions).toEqual(
        expect.arrayContaining([expect.stringContaining('definition_metadata: 0 → 3 prose drifts')])
      );
      expect(result.improvements).toEqual([]);
    });

    it('updateBaseline emits no delta when prose counts are unchanged', () => {
      updateBaseline(baselinePath, reportWithProse);
      const result = updateBaseline(baselinePath, reportWithProse);
      expect(result.improvements).toEqual([]);
      expect(result.regressions).toEqual([]);
    });

    it('loading a legacy baseline (no proseChecks fields) is non-fatal', () => {
      // Simulate a baseline file written by the pre-PR2 schema.
      const legacy = {
        fixture: 'todo-api',
        lastRun: '2026-04-10T10:00:00.000Z',
        squintCommit: 'old',
        tableScores: {
          files: { passed: true, expected: 13, produced: 13, critical: 0, major: 0, minor: 0 },
          definition_metadata: { passed: true, expected: 30, produced: 30, critical: 0, major: 0, minor: 0 },
        },
      };
      fs.writeFileSync(baselinePath, JSON.stringify(legacy, null, 2));
      // updateBaseline should NOT crash and should not invent prose deltas
      // when the prior baseline lacks proseChecks data.
      const result = updateBaseline(baselinePath, reportWithProse);
      expect(result.regressions).toEqual([]);
      expect(result.improvements).toEqual([]);
    });
  });
});
