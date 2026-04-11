import type { RowDiff } from '../types.js';

/**
 * Single source of truth for "how many of each severity" in a list of diffs.
 * Used by aggregateSummary, baseline scoring, and per-table passed checks.
 */
export function countDiffsBySeverity(diffs: RowDiff[]): {
  critical: number;
  major: number;
  minor: number;
} {
  let critical = 0;
  let major = 0;
  let minor = 0;
  for (const d of diffs) {
    if (d.kind === 'prose-drift') continue; // tracked separately via TableDiff.proseChecks
    if (d.severity === 'critical') critical += 1;
    else if (d.severity === 'major') major += 1;
    else if (d.severity === 'minor') minor += 1;
  }
  return { critical, major, minor };
}

/**
 * Single source of truth for "did this table pass?".
 *
 * Pass criteria: zero critical AND zero major. Minor diffs (line drift, prose
 * drift) are informational only and do NOT flip passed. Same rule across every
 * table — no per-comparator policy drift.
 */
export function tableDiffPassed(diffs: RowDiff[]): boolean {
  const counts = countDiffsBySeverity(diffs);
  return counts.critical === 0 && counts.major === 0;
}
