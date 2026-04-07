import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

interface ProducedImportRow {
  importId: number;
  fromPath: string;
  source: string;
  type: string;
  isExternal: number;
  isTypeOnly: number;
  /** Pipe-joined sorted symbol names from the symbols table. */
  symbolNames: string;
}

/**
 * Compare the `imports` table together with its symbol child rows.
 *
 * Natural key: `(fromFile, type, source)`. Joins to `symbols` to verify the
 * imported symbol set matches when the GT declares it. Checks isTypeOnly and
 * isExternal flags. All mismatches are major.
 */
export function compareImports(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  const rows = conn
    .prepare(
      `SELECT i.id AS importId, f.path AS fromPath, i.source AS source, i.type AS type,
              i.is_external AS isExternal, i.is_type_only AS isTypeOnly,
              s.name AS symbolName
       FROM imports i
       JOIN files f ON i.from_file_id = f.id
       LEFT JOIN symbols s ON s.reference_id = i.id
       ORDER BY i.id`
    )
    .all() as Array<{
    importId: number;
    fromPath: string;
    source: string;
    type: string;
    isExternal: number;
    isTypeOnly: number;
    symbolName: string | null;
  }>;

  // Group symbol rows by their parent import (LEFT JOIN explodes 1 import × N symbols).
  const grouped = new Map<number, ProducedImportRow>();
  for (const r of rows) {
    let entry = grouped.get(r.importId);
    if (!entry) {
      entry = {
        importId: r.importId,
        fromPath: r.fromPath,
        source: r.source,
        type: r.type,
        isExternal: r.isExternal,
        isTypeOnly: r.isTypeOnly,
        symbolNames: '',
      };
      grouped.set(r.importId, entry);
    }
    if (r.symbolName) {
      entry.symbolNames = entry.symbolNames ? `${entry.symbolNames}|${r.symbolName}` : r.symbolName;
    }
  }
  const producedRows = Array.from(grouped.values()).map((r) => ({
    ...r,
    // Sort symbol names so equality is order-independent
    symbolNames: r.symbolNames.split('|').filter(Boolean).sort().join('|'),
  }));

  const importKey = (r: { fromPath: string; type: string; source: string }) => `${r.fromPath}|${r.type}|${r.source}`;

  const producedByKey = new Map(producedRows.map((r) => [importKey(r), r]));
  const expected = gt.imports ?? [];

  const diffs: RowDiff[] = [];

  for (const e of expected) {
    const k = importKey({ fromPath: e.fromFile, type: e.type, source: e.source });
    const a = producedByKey.get(k);
    if (!a) {
      diffs.push({
        kind: 'missing',
        severity: 'major',
        naturalKey: k,
        details: `Import '${e.source}' (${e.type}) from '${e.fromFile}' is in ground truth but missing from produced DB`,
      });
      continue;
    }

    const expectedTypeOnly = e.isTypeOnly === true;
    if (expectedTypeOnly !== (a.isTypeOnly === 1)) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: k,
        details: `isTypeOnly: expected ${expectedTypeOnly}, produced ${a.isTypeOnly === 1}`,
      });
    }

    const expectedExternal = e.isExternal === true;
    if (expectedExternal !== (a.isExternal === 1)) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: k,
        details: `isExternal: expected ${expectedExternal}, produced ${a.isExternal === 1}`,
      });
    }

    if (e.symbols && e.symbols.length > 0) {
      const expectedSymbols = e.symbols
        .map((s) => s.name)
        .sort()
        .join('|');
      if (expectedSymbols !== a.symbolNames) {
        diffs.push({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: k,
          details: `symbols: expected [${expectedSymbols}], produced [${a.symbolNames}]`,
        });
      }
    }
  }

  for (const [k] of producedByKey) {
    if (!expected.some((e) => importKey({ fromPath: e.fromFile, type: e.type, source: e.source }) === k)) {
      diffs.push({
        kind: 'extra',
        severity: 'major',
        naturalKey: k,
        details: `Produced DB has import '${k}' not declared in ground truth`,
      });
    }
  }

  return {
    table: 'imports',
    passed: tableDiffPassed(diffs),
    expectedCount: expected.length,
    producedCount: producedRows.length,
    diffs,
  };
}
