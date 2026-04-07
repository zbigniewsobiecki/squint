import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Compare the `contracts` table.
 *
 * Natural key: `(protocol, normalized_key)`. Missing = critical. Extra = major.
 * (Contract participants are not yet checked; they're a separate table.)
 */
export function compareContracts(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  const producedRows = conn.prepare('SELECT protocol, normalized_key AS normalizedKey FROM contracts').all() as Array<{
    protocol: string;
    normalizedKey: string;
  }>;
  const producedKeys = new Set(producedRows.map((r) => `${r.protocol}::${r.normalizedKey}`));
  const expected = gt.contracts ?? [];
  const expectedKeys = new Set(expected.map((c) => `${c.protocol}::${c.normalizedKey}`));

  const diffs: RowDiff[] = [];
  for (const e of expectedKeys) {
    if (!producedKeys.has(e)) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: e,
        details: `Contract '${e}' is in ground truth but missing from produced DB`,
      });
    }
  }
  for (const p of producedKeys) {
    if (!expectedKeys.has(p)) {
      diffs.push({
        kind: 'extra',
        severity: 'major',
        naturalKey: p,
        details: `Produced DB has contract '${p}' not declared in ground truth`,
      });
    }
  }

  return {
    table: 'contracts',
    passed: tableDiffPassed(diffs),
    expectedCount: expected.length,
    producedCount: producedRows.length,
    diffs,
  };
}
