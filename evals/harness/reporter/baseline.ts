import fs from 'node:fs';
import { countDiffsBySeverity } from '../comparator/severity.js';
import type { DiffReport, TableName } from '../types.js';

/**
 * Per-table scoreboard within a baseline.
 *
 * PR2: `proseChecks` mirrors `TableDiff.proseChecks` so the persisted baseline
 * can ratchet prose drift down across runs. The structural counters
 * (critical/major/minor) deliberately do NOT include prose-drift kinds — those
 * are tracked here separately so a fixture can hit drift-zero on the prose
 * axis even when LLM noise momentarily flickers.
 */
export interface TableScore {
  passed: boolean;
  expected: number;
  produced: number;
  critical: number;
  major: number;
  minor: number;
  proseChecks?: { passed: number; failed: number };
}

/**
 * Persisted scoreboard per fixture, committed to git so PR review can see
 * the eval delta at a glance.
 */
export interface Baseline {
  fixture: string;
  lastRun: string; // ISO timestamp
  squintCommit?: string;
  tableScores: Partial<Record<TableName, TableScore>>;
}

export interface BaselineUpdateResult {
  improvements: string[];
  regressions: string[];
  baseline: Baseline;
}

/**
 * Compute a baseline scorecard from a single DiffReport.
 */
export function computeBaselineFromReport(report: DiffReport): Baseline {
  const tableScores: Partial<Record<TableName, TableScore>> = {};
  for (const t of report.tables) {
    const counts = countDiffsBySeverity(t.diffs);
    const score: TableScore = {
      passed: t.passed,
      expected: t.expectedCount,
      produced: t.producedCount,
      ...counts,
    };
    // PR2: copy prose-check counters when the table tracked any. Tables
    // without prose-bearing entries (files, definitions, imports, contracts)
    // don't get a proseChecks field — keeps the persisted JSON minimal.
    if (t.proseChecks) {
      score.proseChecks = { passed: t.proseChecks.passed, failed: t.proseChecks.failed };
    }
    tableScores[t.table] = score;
  }

  return {
    fixture: report.fixtureName,
    lastRun: new Date().toISOString(),
    squintCommit: report.squintCommit,
    tableScores,
  };
}

/**
 * Load a baseline JSON file from disk. Returns null if it does not exist.
 */
export function loadBaseline(filePath: string): Baseline | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Baseline;
}

/**
 * Update a baseline file with the new report. Computes a delta vs the prior
 * baseline (if any), writes the new baseline to disk, and returns the delta.
 */
export function updateBaseline(filePath: string, report: DiffReport): BaselineUpdateResult {
  const prior = loadBaseline(filePath);
  const next = computeBaselineFromReport(report);

  const improvements: string[] = [];
  const regressions: string[] = [];

  if (prior) {
    for (const [table, nextScore] of Object.entries(next.tableScores)) {
      const priorScore = prior.tableScores[table as TableName];
      if (!priorScore || !nextScore) continue;
      if (priorScore.passed && !nextScore.passed) {
        regressions.push(`${table}: pass → fail`);
      } else if (!priorScore.passed && nextScore.passed) {
        improvements.push(`${table}: fail → pass`);
      } else if (!nextScore.passed && !priorScore.passed) {
        // Both failing — measure severity counts
        const priorTotal = priorScore.critical + priorScore.major;
        const nextTotal = nextScore.critical + nextScore.major;
        if (nextTotal > priorTotal) {
          regressions.push(`${table}: ${priorTotal} → ${nextTotal} blocking diffs`);
        } else if (nextTotal < priorTotal) {
          improvements.push(`${table}: ${priorTotal} → ${nextTotal} blocking diffs`);
        }
      }

      // PR2: prose drift delta. Only fires when BOTH baselines have a
      // proseChecks field (legacy baselines without it produce no delta).
      const nextProse = nextScore.proseChecks?.failed;
      const priorProse = priorScore.proseChecks?.failed;
      if (nextProse != null && priorProse != null) {
        if (nextProse > priorProse) {
          regressions.push(`${table}: ${priorProse} → ${nextProse} prose drifts`);
        } else if (nextProse < priorProse) {
          improvements.push(`${table}: ${priorProse} → ${nextProse} prose drifts`);
        }
      }
    }
  }

  // Trailing newline keeps biome's default JSON formatter happy on every
  // commit (it would otherwise re-flag the auto-updated baseline forever).
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);

  return { improvements, regressions, baseline: next };
}
