import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

interface ProducedInteractionRow {
  fromPath: string;
  toPath: string;
  pattern: string | null;
  source: string;
}

/**
 * Compare the `interactions` table.
 *
 * Natural key: `(fromModulePath, toModulePath)`. Checks `source` and `pattern`
 * exactly. Missing or extra interactions and any field mismatch are major.
 */
export function compareInteractions(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  const producedRows = conn
    .prepare(
      `SELECT from_m.full_path AS fromPath, to_m.full_path AS toPath,
              i.pattern AS pattern, i.source AS source
       FROM interactions i
       JOIN modules from_m ON i.from_module_id = from_m.id
       JOIN modules to_m ON i.to_module_id = to_m.id`
    )
    .all() as ProducedInteractionRow[];

  const producedMap = new Map<string, ProducedInteractionRow>();
  for (const r of producedRows) {
    producedMap.set(`${r.fromPath}->${r.toPath}`, r);
  }

  const expected = gt.interactions ?? [];
  const expectedMap = new Map(expected.map((i) => [`${i.fromModulePath}->${i.toModulePath}`, i]));

  const diffs: RowDiff[] = [];

  for (const [key, e] of expectedMap) {
    const a = producedMap.get(key);
    if (!a) {
      diffs.push({
        kind: 'missing',
        severity: 'major',
        naturalKey: key,
        details: `Interaction '${key}' is in ground truth but missing from produced DB`,
      });
      continue;
    }
    if (a.source !== e.source) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `source: expected '${e.source}', produced '${a.source}'`,
      });
    }
    if ((e.pattern ?? null) !== (a.pattern ?? null)) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `pattern: expected ${JSON.stringify(e.pattern)}, produced ${JSON.stringify(a.pattern)}`,
      });
    }
  }

  for (const [key] of producedMap) {
    if (!expectedMap.has(key)) {
      diffs.push({
        kind: 'extra',
        severity: 'major',
        naturalKey: key,
        details: `Produced DB has interaction '${key}' not declared in ground truth`,
      });
    }
  }

  return {
    table: 'interactions',
    passed: tableDiffPassed(diffs),
    expectedCount: expected.length,
    producedCount: producedRows.length,
    diffs,
  };
}
