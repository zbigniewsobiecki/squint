import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Compare the `module_members` table.
 *
 * Natural key: definition `defKey` (file::name). Each definition must be
 * assigned to its expected module. Missing assignment = major. Wrong module = major.
 */
export function compareModuleMembers(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  // Map: defKey -> module fullPath assigned in produced DB
  const producedMap = new Map<string, string>();
  const rows = conn
    .prepare(
      `SELECT f.path || '::' || d.name AS defKey, m.full_path AS fullPath
       FROM module_members mm
       JOIN definitions d ON mm.definition_id = d.id
       JOIN files f ON d.file_id = f.id
       JOIN modules m ON mm.module_id = m.id`
    )
    .all() as Array<{ defKey: string; fullPath: string }>;
  for (const r of rows) {
    producedMap.set(r.defKey, r.fullPath);
  }

  // Build expected map from gt.modules
  const expectedMap = new Map<string, string>();
  for (const m of gt.modules ?? []) {
    for (const memberKey of m.members ?? []) {
      expectedMap.set(memberKey, m.fullPath);
    }
  }

  const diffs: RowDiff[] = [];
  for (const [key, expectedPath] of expectedMap) {
    const actualPath = producedMap.get(key);
    if (!actualPath) {
      diffs.push({
        kind: 'missing',
        severity: 'major',
        naturalKey: key,
        details: `Definition '${key}' is unassigned in produced DB; expected module '${expectedPath}'`,
      });
      continue;
    }
    if (actualPath !== expectedPath) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `module assignment: expected '${expectedPath}', produced '${actualPath}'`,
      });
    }
  }

  return {
    table: 'module_members',
    passed: tableDiffPassed(diffs),
    expectedCount: expectedMap.size,
    producedCount: producedMap.size,
    diffs,
  };
}
