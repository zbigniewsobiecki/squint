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
});
