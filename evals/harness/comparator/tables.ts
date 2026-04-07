import type { IndexDatabase } from '../../../src/db/database-facade.js';
import type { GroundTruth, RowDiff, TableDiff } from '../types.js';
import { tableDiffPassed } from './severity.js';

/**
 * Per-table comparator strategies. Every comparator returns a TableDiff
 * with structural diffs only — prose-judged fields are handled separately
 * by `prose-judge.ts` and merged in by the top-level `compare()` function.
 *
 * Key invariant: comparisons are ID-agnostic. Joins use natural keys
 * (file paths, definition names, module full_paths, contract protocol+key, etc.)
 */

const LINE_TOLERANCE = 2;

// ============================================================
// files
// ============================================================
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

// ============================================================
// definitions
// ============================================================
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

function parseJsonStringArray(value: string | null): string[] | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

function arraysEqualSorted(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

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

    // kind — major
    if (actual.kind !== expected.kind) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `kind: expected '${expected.kind}', produced '${actual.kind}'`,
      });
    }

    // line — minor (with tolerance)
    if (Math.abs(actual.line - expected.line) > LINE_TOLERANCE) {
      diffs.push({
        kind: 'mismatch',
        severity: 'minor',
        naturalKey: key,
        details: `line: expected ${expected.line} (±${LINE_TOLERANCE}), produced ${actual.line}`,
      });
    }

    // endLine — minor (only when GT declares it; ±2 tolerance same as line)
    if (expected.endLine != null && Math.abs(actual.endLine - expected.endLine) > LINE_TOLERANCE) {
      diffs.push({
        kind: 'mismatch',
        severity: 'minor',
        naturalKey: key,
        details: `endLine: expected ${expected.endLine} (±${LINE_TOLERANCE}), produced ${actual.endLine}`,
      });
    }

    // extendsName — major
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

    // implementsNames — major (only when GT declares it; order-independent)
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

    // extendsInterfaces — major (only when GT declares it; order-independent)
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

    // isExported — major
    if ((actual.isExported === 1) !== expected.isExported) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: key,
        details: `isExported: expected ${expected.isExported}, produced ${actual.isExported === 1}`,
      });
    }

    // isDefault — major (defaults to false in GT; only check when actual differs)
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

// ============================================================
// imports
// ============================================================
interface ProducedImportRow {
  importId: number;
  fromPath: string;
  source: string;
  type: string;
  isExternal: number;
  isTypeOnly: number;
  symbolNames: string; // pipe-joined sorted symbol names
}

export function compareImports(produced: IndexDatabase, gt: GroundTruth): TableDiff {
  const conn = produced.getConnection();
  // Collect imports with per-import symbol lists in a single query
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

    // isTypeOnly check
    const expectedTypeOnly = e.isTypeOnly === true;
    if (expectedTypeOnly !== (a.isTypeOnly === 1)) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: k,
        details: `isTypeOnly: expected ${expectedTypeOnly}, produced ${a.isTypeOnly === 1}`,
      });
    }

    // isExternal check (default false in GT)
    const expectedExternal = e.isExternal === true;
    if (expectedExternal !== (a.isExternal === 1)) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: k,
        details: `isExternal: expected ${expectedExternal}, produced ${a.isExternal === 1}`,
      });
    }

    // Symbol set check (when GT declares them)
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

// ============================================================
// modules
// ============================================================
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
  // Note: produced DB will always have auto-created intermediate ancestors and 'project' root.
  // We do NOT report those as 'extra' because the ground truth declares only meaningful leaves.
  // Only report extra if the produced module has NO descendants AND is not in expected.
  for (const p of producedRows) {
    if (expectedSet.has(p.fullPath)) continue;
    if (p.fullPath === 'project') continue;
    // Is it an ancestor of any expected module? If so, ignore.
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

// ============================================================
// module_members
// ============================================================
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

// ============================================================
// contracts
// ============================================================
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

// ============================================================
// interactions
// ============================================================
interface ProducedInteractionRow {
  fromPath: string;
  toPath: string;
  pattern: string | null;
  source: string;
}

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

// ============================================================
// flows
// ============================================================
interface ProducedFlowRow {
  slug: string;
  name: string;
  stakeholder: string | null;
  entryPath: string | null;
}

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
