import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

interface ProducedFlowRow {
  slug: string;
  name: string;
  stakeholder: string | null;
  entryPath: string | null;
}

/**
 * Compare the `flows` table.
 *
 * Natural key: `slug`. Missing flow = critical. Wrong stakeholder or entryPath
 * = major. (flow_steps and flow_definition_steps are separate tables.)
 */
export function compareFlows(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  const producedRows = conn
    .prepare('SELECT slug, name, stakeholder, entry_path AS entryPath FROM flows')
    .all() as ProducedFlowRow[];

  const producedMap = new Map(producedRows.map((r) => [r.slug, r]));
  const expected = gt.flows ?? [];
  const expectedMap = new Map(expected.map((f) => [f.slug, f]));

  const diffs: RowDiff[] = [];

  for (const [slug, e] of expectedMap) {
    const a = producedMap.get(slug);
    if (!a) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: slug,
        details: `Flow '${slug}' is in ground truth but missing from produced DB`,
      });
      continue;
    }
    if (a.stakeholder !== e.stakeholder) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: slug,
        details: `stakeholder: expected '${e.stakeholder}', produced '${a.stakeholder}'`,
      });
    }
    if (e.entryPath != null && a.entryPath !== e.entryPath) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: slug,
        details: `entryPath: expected '${e.entryPath}', produced '${a.entryPath}'`,
      });
    }
  }

  for (const [slug] of producedMap) {
    if (!expectedMap.has(slug)) {
      diffs.push({
        kind: 'extra',
        severity: 'major',
        naturalKey: slug,
        details: `Produced DB has flow '${slug}' not declared in ground truth`,
      });
    }
  }

  return {
    table: 'flows',
    passed: tableDiffPassed(diffs),
    expectedCount: expected.length,
    producedCount: producedRows.length,
    diffs,
  };
}
