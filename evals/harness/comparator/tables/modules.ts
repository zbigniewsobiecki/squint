import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Compare the `modules` table.
 *
 * Natural key: `full_path`. Missing module = major. Extra module = minor
 * UNLESS it's an auto-created intermediate ancestor (those are expected and
 * don't trigger any diff).
 *
 * Note: 'project' root is always present and never reported.
 */
export function compareModules(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  const producedRows = conn.prepare('SELECT full_path AS fullPath FROM modules').all() as Array<{
    fullPath: string;
  }>;
  const producedSet = new Set(producedRows.map((r) => r.fullPath));

  const expected = gt.modules ?? [];
  const expectedSet = new Set(expected.map((m) => m.fullPath));

  const diffs: RowDiff[] = [];
  for (const e of expected) {
    if (!producedSet.has(e.fullPath)) {
      diffs.push({
        kind: 'missing',
        severity: 'major',
        naturalKey: e.fullPath,
        details: `Module '${e.fullPath}' is in ground truth but missing from produced DB`,
      });
    }
  }
  // Produced DB will always have auto-created intermediate ancestors and the
  // 'project' root. Don't report those — only report extras with no descendants.
  for (const p of producedRows) {
    if (expectedSet.has(p.fullPath)) continue;
    if (p.fullPath === 'project') continue;
    const isAncestor = expected.some((e) => e.fullPath.startsWith(`${p.fullPath}.`));
    if (isAncestor) continue;
    diffs.push({
      kind: 'extra',
      severity: 'minor',
      naturalKey: p.fullPath,
      details: `Produced DB has module '${p.fullPath}' not declared in ground truth`,
    });
  }

  return {
    table: 'modules',
    passed: tableDiffPassed(diffs),
    expectedCount: expected.length,
    producedCount: producedRows.length,
    diffs,
  };
}
