import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Compare the `files` table.
 * Natural key: `path`. Mismatch policy: missing = critical, extra = major.
 */
export function compareFiles(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  const producedRows = conn.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
  const producedSet = new Set(producedRows.map((r) => r.path));
  const expectedSet = new Set(gt.files.map((f) => f.path));

  const diffs: RowDiff[] = [];
  for (const expected of expectedSet) {
    if (!producedSet.has(expected)) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: expected,
        details: `File '${expected}' is in ground truth but missing from produced DB`,
      });
    }
  }
  for (const producedPath of producedSet) {
    if (!expectedSet.has(producedPath)) {
      diffs.push({
        kind: 'extra',
        severity: 'major',
        naturalKey: producedPath,
        details: `Produced DB has file '${producedPath}' not declared in ground truth`,
      });
    }
  }

  return {
    table: 'files',
    passed: tableDiffPassed(diffs),
    expectedCount: expectedSet.size,
    producedCount: producedSet.size,
    diffs,
  };
}
