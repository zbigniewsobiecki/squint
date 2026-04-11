import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';
import { LINE_TOLERANCE, arraysEqualSorted, parseJsonStringArray } from './shared.js';

interface ProducedDefRow {
  path: string;
  name: string;
  kind: string;
  isExported: number;
  isDefault: number;
  line: number;
  endLine: number;
  extendsName: string | null;
  implementsNames: string | null; // JSON
  extendsInterfaces: string | null; // JSON
}

/**
 * Compare the `definitions` table.
 *
 * Natural key: `(file_path, name)`. Checks (in order, with their severity):
 * - missing/extra → critical / major
 * - kind mismatch → major
 * - line drift > tolerance → minor
 * - endLine drift > tolerance → minor (only when GT declares endLine)
 * - extendsName → major
 * - implementsNames (set) → major (only when GT declares it)
 * - extendsInterfaces (set) → major (only when GT declares it)
 * - isExported → major
 * - isDefault → major
 */
export function compareDefinitions(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  const producedRows = conn
    .prepare(
      `SELECT f.path AS path, d.name AS name, d.kind AS kind,
              d.is_exported AS isExported, d.is_default AS isDefault,
              d.line AS line, d.end_line AS endLine,
              d.extends_name AS extendsName,
              d.implements_names AS implementsNames,
              d.extends_interfaces AS extendsInterfaces
       FROM definitions d
       JOIN files f ON d.file_id = f.id`
    )
    .all() as ProducedDefRow[];

  const producedByKey = new Map<string, ProducedDefRow>();
  for (const r of producedRows) {
    producedByKey.set(`${r.path}::${r.name}`, r);
  }

  const expectedByKey = new Map(gt.definitions.map((d) => [`${d.file}::${d.name}`, d]));

  const diffs: RowDiff[] = [];

  for (const [key, expected] of expectedByKey) {
    const actual = producedByKey.get(key);
    if (!actual) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: key,
        details: `Definition '${expected.name}' (${expected.kind}) is in ground truth but missing from produced DB`,
      });
      continue;
    }

    if (actual.kind !== expected.kind) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `kind: expected '${expected.kind}', produced '${actual.kind}'`,
      });
    }

    if (Math.abs(actual.line - expected.line) > LINE_TOLERANCE) {
      diffs.push({
        kind: 'mismatch',
        severity: 'minor',
        naturalKey: key,
        details: `line: expected ${expected.line} (±${LINE_TOLERANCE}), produced ${actual.line}`,
      });
    }

    if (expected.endLine != null && Math.abs(actual.endLine - expected.endLine) > LINE_TOLERANCE) {
      diffs.push({
        kind: 'mismatch',
        severity: 'minor',
        naturalKey: key,
        details: `endLine: expected ${expected.endLine} (±${LINE_TOLERANCE}), produced ${actual.endLine}`,
      });
    }

    const expectedExtends = expected.extendsName ?? null;
    const actualExtends = actual.extendsName ?? null;
    if (expectedExtends !== actualExtends) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `extendsName: expected ${JSON.stringify(expectedExtends)}, produced ${JSON.stringify(actualExtends)}`,
      });
    }

    if (expected.implementsNames !== undefined) {
      const actualImpl = parseJsonStringArray(actual.implementsNames);
      const expectedImpl = expected.implementsNames;
      if (!arraysEqualSorted(actualImpl, expectedImpl)) {
        diffs.push({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: key,
          details: `implementsNames: expected ${JSON.stringify(expectedImpl)}, produced ${JSON.stringify(actualImpl)}`,
        });
      }
    }

    if (expected.extendsInterfaces !== undefined) {
      const actualExt = parseJsonStringArray(actual.extendsInterfaces);
      const expectedExt = expected.extendsInterfaces;
      if (!arraysEqualSorted(actualExt, expectedExt)) {
        diffs.push({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: key,
          details: `extendsInterfaces: expected ${JSON.stringify(expectedExt)}, produced ${JSON.stringify(actualExt)}`,
        });
      }
    }

    if ((actual.isExported === 1) !== expected.isExported) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `isExported: expected ${expected.isExported}, produced ${actual.isExported === 1}`,
      });
    }

    const expectedDefault = expected.isDefault ?? false;
    if ((actual.isDefault === 1) !== expectedDefault) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `isDefault: expected ${expectedDefault}, produced ${actual.isDefault === 1}`,
      });
    }
  }

  for (const [key] of producedByKey) {
    if (!expectedByKey.has(key)) {
      diffs.push({
        kind: 'extra',
        severity: 'major',
        naturalKey: key,
        details: `Produced DB has definition '${key}' not declared in ground truth`,
      });
    }
  }

  return {
    table: 'definitions',
    passed: tableDiffPassed(diffs),
    expectedCount: expectedByKey.size,
    producedCount: producedByKey.size,
    diffs,
  };
}
