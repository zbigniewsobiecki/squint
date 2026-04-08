import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Compare the `contracts` table.
 *
 * Natural key: `(protocol, normalized_key)`.
 *
 * Severity matrix:
 *   - Missing GT contract (required) → CRITICAL
 *   - Missing GT contract (optional)  → MINOR (LLM legitimately misses some)
 *   - Extra produced contract         → MINOR (the LLM may detect more than
 *                                       we enumerate; the GT is an existence
 *                                       claim, not strict equality)
 *
 * Contract participants are not yet checked; they're a separate concern.
 */
export function compareContracts(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  const producedRows = conn.prepare('SELECT protocol, normalized_key AS normalizedKey FROM contracts').all() as Array<{
    protocol: string;
    normalizedKey: string;
  }>;
  const producedKeys = new Set(producedRows.map((r) => `${r.protocol}::${r.normalizedKey}`));
  const expected = gt.contracts ?? [];

  // Build map keyed on natural key → optional flag
  const expectedMap = new Map<string, { optional: boolean }>();
  for (const c of expected) {
    expectedMap.set(`${c.protocol}::${c.normalizedKey}`, { optional: c.optional === true });
  }

  const diffs: RowDiff[] = [];
  for (const [key, meta] of expectedMap) {
    if (!producedKeys.has(key)) {
      diffs.push({
        kind: 'missing',
        severity: meta.optional ? 'minor' : 'critical',
        naturalKey: key,
        details: `Contract '${key}' is in ground truth but missing from produced DB${meta.optional ? ' (optional)' : ''}`,
      });
    }
  }
  for (const p of producedKeys) {
    if (!expectedMap.has(p)) {
      diffs.push({
        kind: 'extra',
        severity: 'minor',
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
