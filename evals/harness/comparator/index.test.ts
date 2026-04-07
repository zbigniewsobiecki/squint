import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../../src/db/database-facade.js';
import { buildGroundTruthDb } from '../builder.js';
import { type GroundTruth, type TableName, defKey } from '../types.js';
import { makeStubJudge } from '../types.js';
import { compare } from './index.js';

/**
 * Top-level compare() orchestrator. It:
 * - dispatches per-table comparators based on the requested scope
 * - aggregates per-row diffs into a DiffSummary by severity
 * - sets passed=false if any critical OR major diff exists (minor only → still passes)
 */
describe('compare (top-level orchestrator)', () => {
  let dir: string;
  let producedDb: IndexDatabase;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-eval-top-'));
    producedDb = new IndexDatabase(path.join(dir, 'p.db'));
    producedDb.initialize();
  });

  afterEach(() => {
    producedDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const baseGt: GroundTruth = {
    fixtureName: 'mini',
    files: [
      { path: 'src/c.ts', language: 'typescript' },
      { path: 'src/s.ts', language: 'typescript' },
    ],
    definitions: [
      { file: 'src/c.ts', name: 'ctrl', kind: 'function', isExported: true, line: 1 },
      { file: 'src/s.ts', name: 'svc', kind: 'function', isExported: true, line: 1 },
    ],
    modules: [
      { fullPath: 'project.controllers', name: 'C', members: [defKey('src/c.ts', 'ctrl')] },
      { fullPath: 'project.services', name: 'S', members: [defKey('src/s.ts', 'svc')] },
    ],
    interactions: [
      {
        fromModulePath: 'project.controllers',
        toModulePath: 'project.services',
        pattern: 'business',
        source: 'ast',
      },
    ],
  };

  it('passes when produced exactly matches ground truth across all tables in scope', async () => {
    buildGroundTruthDb(producedDb, baseGt);
    const report = await compare({
      produced: producedDb,
      groundTruth: baseGt,
      scope: ['files', 'definitions', 'modules', 'module_members', 'interactions'],
      judgeFn: async () => ({ similarity: 1, passed: true, reasoning: 'stub' }),
    });
    expect(report.passed).toBe(true);
    expect(report.summary.critical).toBe(0);
    expect(report.summary.major).toBe(0);
    expect(report.tables.map((t) => t.table).sort()).toEqual(
      ['definitions', 'files', 'interactions', 'module_members', 'modules'].sort()
    );
  });

  it('fails on critical diffs, aggregates summary correctly', async () => {
    // Build with a missing file
    buildGroundTruthDb(producedDb, {
      ...baseGt,
      files: [{ path: 'src/c.ts', language: 'typescript' }],
      definitions: [{ file: 'src/c.ts', name: 'ctrl', kind: 'function', isExported: true, line: 1 }],
      modules: [{ fullPath: 'project.controllers', name: 'C', members: [defKey('src/c.ts', 'ctrl')] }],
      interactions: [],
    });
    const report = await compare({
      produced: producedDb,
      groundTruth: baseGt,
      scope: ['files', 'definitions'],
      judgeFn: async () => ({ similarity: 1, passed: true, reasoning: 'stub' }),
    });
    expect(report.passed).toBe(false);
    expect(report.summary.critical).toBeGreaterThan(0);
  });

  it('passes when only minor diffs are present', async () => {
    // Use a different scope to avoid 'modules' producing minor extras
    buildGroundTruthDb(producedDb, {
      ...baseGt,
      definitions: [
        { file: 'src/c.ts', name: 'ctrl', kind: 'function', isExported: true, line: 4 }, // 1 → 4 (within ±2 from 2 is fine, but 1→4 is +3 → mismatch=minor in our impl)
        { file: 'src/s.ts', name: 'svc', kind: 'function', isExported: true, line: 1 },
      ],
    });
    const report = await compare({
      produced: producedDb,
      groundTruth: baseGt,
      scope: ['files', 'definitions'],
      judgeFn: async () => ({ similarity: 1, passed: true, reasoning: 'stub' }),
    });
    // 1 minor diff (line drift), 0 critical, 0 major → still passes
    expect(report.summary.minor).toBe(1);
    expect(report.summary.critical).toBe(0);
    expect(report.summary.major).toBe(0);
    expect(report.passed).toBe(true);
  });

  it('only runs comparators for tables in scope', async () => {
    buildGroundTruthDb(producedDb, baseGt);
    const report = await compare({
      produced: producedDb,
      groundTruth: baseGt,
      scope: ['files'] as TableName[],
      judgeFn: async () => ({ similarity: 1, passed: true, reasoning: 'stub' }),
    });
    expect(report.tables).toHaveLength(1);
    expect(report.tables[0].table).toBe('files');
  });

  it('throws when scope includes a table with no implemented comparator', async () => {
    buildGroundTruthDb(producedDb, baseGt);
    await expect(
      compare({
        produced: producedDb,
        groundTruth: baseGt,
        // 'symbols' has no comparator yet — silently dropping it would mislead callers
        scope: ['files', 'symbols'] as TableName[],
        judgeFn: async () => ({ similarity: 1, passed: true, reasoning: 'stub' }),
      })
    ).rejects.toThrow(/comparator.*symbols/i);
  });

  it('records the duration in milliseconds', async () => {
    buildGroundTruthDb(producedDb, baseGt);
    const report = await compare({
      produced: producedDb,
      groundTruth: baseGt,
      scope: ['files'],
      judgeFn: async () => ({ similarity: 1, passed: true, reasoning: 'stub' }),
    });
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof report.durationMs).toBe('number');
  });

  describe('stub-judge guardrail', () => {
    it('allows stub judge when no prose-bearing tables are in scope', async () => {
      buildGroundTruthDb(producedDb, baseGt);
      const report = await compare({
        produced: producedDb,
        groundTruth: baseGt,
        scope: ['files', 'definitions'],
        judgeFn: makeStubJudge(),
      });
      expect(report.passed).toBe(true);
    });

    it('allows stub judge when prose-bearing scope has NO declared references', async () => {
      // 'modules' is a prose-bearing table but baseGt has no descriptionReference fields,
      // so the stub is harmless.
      buildGroundTruthDb(producedDb, baseGt);
      const report = await compare({
        produced: producedDb,
        groundTruth: baseGt,
        scope: ['modules'],
        judgeFn: makeStubJudge(),
      });
      expect(report.passed).toBe(true);
    });

    it('throws when stub judge would silently pass declared prose references', async () => {
      // Add a prose reference to baseGt's modules
      const gtWithProse: GroundTruth = {
        ...baseGt,
        modules: [
          {
            fullPath: 'project.controllers',
            name: 'C',
            members: [defKey('src/c.ts', 'ctrl')],
            descriptionReference: 'HTTP request handlers translating requests into service calls.',
          },
          { fullPath: 'project.services', name: 'S', members: [defKey('src/s.ts', 'svc')] },
        ],
      };
      buildGroundTruthDb(producedDb, gtWithProse);
      await expect(
        compare({
          produced: producedDb,
          groundTruth: gtWithProse,
          scope: ['modules'],
          judgeFn: makeStubJudge(),
        })
      ).rejects.toThrow(/stub judge is forbidden/i);
    });

    it('allows a real (non-stub) judge with declared prose references', async () => {
      const gtWithProse: GroundTruth = {
        ...baseGt,
        modules: [
          {
            fullPath: 'project.controllers',
            name: 'C',
            members: [defKey('src/c.ts', 'ctrl')],
            descriptionReference: 'reference text',
          },
          { fullPath: 'project.services', name: 'S', members: [defKey('src/s.ts', 'svc')] },
        ],
      };
      buildGroundTruthDb(producedDb, gtWithProse);
      // No STUB_JUDGE_MARKER set → treated as real
      const realJudge = async () => ({ similarity: 1, passed: true, reasoning: 'real' });
      const report = await compare({
        produced: producedDb,
        groundTruth: gtWithProse,
        scope: ['modules'],
        judgeFn: realJudge,
      });
      expect(report.passed).toBe(true);
    });
  });
});

describe('aggregateSummary — prose-check counting', () => {
  // Direct unit test of the summary logic without needing a real DB.
  // Imports the bare aggregator to verify counting rules in isolation.
  it('a single prose-drift minor diff increments proseChecks.failed but NOT minor', async () => {
    const { aggregateSummary } = await import('./index.js');
    const summary = aggregateSummary([
      {
        table: 'definition_metadata',
        passed: true, // table is fine; prose drift is informational
        expectedCount: 1,
        producedCount: 1,
        diffs: [
          {
            kind: 'prose-drift',
            severity: 'minor',
            naturalKey: 'src/foo.ts::bar',
            details: 'similarity 0.65 < 0.75',
          },
        ],
        proseChecks: { passed: 0, failed: 1 },
      },
    ]);
    expect(summary.proseChecks.failed).toBe(1);
    expect(summary.minor).toBe(0); // ← regression: was 1 (double count)
    expect(summary.proseChecks.passed).toBe(0);
  });

  it('passed prose checks roll up from per-table proseChecks counters', async () => {
    const { aggregateSummary } = await import('./index.js');
    const summary = aggregateSummary([
      {
        table: 'definition_metadata',
        passed: true,
        expectedCount: 5,
        producedCount: 5,
        diffs: [],
        proseChecks: { passed: 4, failed: 1 },
      },
      {
        table: 'modules',
        passed: true,
        expectedCount: 3,
        producedCount: 3,
        diffs: [],
        proseChecks: { passed: 2, failed: 0 },
      },
    ]);
    expect(summary.proseChecks.passed).toBe(6);
    expect(summary.proseChecks.failed).toBe(1);
  });

  it('regular minor diffs still increment summary.minor', async () => {
    const { aggregateSummary } = await import('./index.js');
    const summary = aggregateSummary([
      {
        table: 'definitions',
        passed: true,
        expectedCount: 1,
        producedCount: 1,
        diffs: [
          {
            kind: 'mismatch',
            severity: 'minor',
            naturalKey: 'src/foo.ts::bar',
            details: 'line drift',
          },
        ],
      },
    ]);
    expect(summary.minor).toBe(1);
    expect(summary.proseChecks.failed).toBe(0);
  });
});
