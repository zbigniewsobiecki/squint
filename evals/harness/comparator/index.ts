import type { IndexDatabase } from '../../../src/db/database-facade.js';
import {
  type DiffReport,
  type DiffSummary,
  type GroundTruth,
  PROSE_BEARING_TABLES,
  type ProseJudgeFn,
  STUB_JUDGE_MARKER,
  type TableDiff,
  type TableName,
} from '../types.js';
import {
  compareContracts,
  compareDefinitions,
  compareFiles,
  compareFlows,
  compareImports,
  compareInteractions,
  compareModuleMembers,
  compareModules,
} from './tables.js';

export interface CompareOptions {
  produced: IndexDatabase;
  groundTruth: GroundTruth;
  /** Tables the caller wants compared. Tables not listed are skipped. */
  scope: TableName[];
  /**
   * Pluggable prose-judge. Real implementation calls an LLM; tests inject a stub.
   * Currently used by definition_metadata, relationship_annotations, modules.description,
   * interactions.semantic, flows.description.
   */
  judgeFn: ProseJudgeFn;
  /** Optional git SHA of the squint commit producing the DB, embedded in the report. */
  squintCommit?: string;
}

/**
 * Top-level orchestrator. Dispatches per-table comparators based on scope,
 * aggregates per-row diffs into a DiffSummary, returns a DiffReport.
 *
 * Pass criteria: zero CRITICAL and zero MAJOR diffs across all in-scope tables.
 * Minor diffs (line drift, prose drift) only warn.
 */
export async function compare(opts: CompareOptions): Promise<DiffReport> {
  const start = Date.now();
  const { produced, groundTruth, scope, judgeFn } = opts;

  // Guardrail: refuse to silently pass real prose checks with a stub judge.
  // Iteration 1 has no prose references declared, so this is a no-op then.
  // The moment iteration 2 adds GT prose references, the harness fails loudly
  // unless the caller injects a real LLM judge.
  assertNoStubJudgeForProseChecks(judgeFn, scope, groundTruth);

  const tables: TableDiff[] = [];

  for (const tableName of scope) {
    tables.push(runComparator(tableName, produced, groundTruth));
  }

  const summary = aggregateSummary(tables);

  const passed = summary.critical === 0 && summary.major === 0;

  return {
    fixtureName: groundTruth.fixtureName,
    passed,
    scope,
    tables,
    summary,
    durationMs: Date.now() - start,
    squintCommit: opts.squintCommit,
  };
}

/**
 * Refuse to use a stub judge for any scope that actually contains declared
 * prose references. Catches the bug where iteration 2+ ships and the eval
 * file forgets to swap the stub judge for a real LLM call.
 */
function assertNoStubJudgeForProseChecks(judgeFn: ProseJudgeFn, scope: TableName[], gt: GroundTruth): void {
  const isStub = judgeFn[STUB_JUDGE_MARKER] === true;
  if (!isStub) return;

  const proseScopes = scope.filter((s) => PROSE_BEARING_TABLES.has(s));
  if (proseScopes.length === 0) return;

  // Stub judge IS allowed unless GT actually declares prose references in
  // an in-scope table. Walk the GT to check.
  const hasProseRefs = countDeclaredProseReferences(gt, proseScopes);
  if (hasProseRefs > 0) {
    throw new Error(
      `Stub judge is forbidden when prose checks are in scope and ground truth declares prose references. Scope contains ${proseScopes.length} prose-bearing table(s) (${proseScopes.join(', ')}) and ground truth declares ${hasProseRefs} prose reference(s). Inject a real LLM-backed judge instead of a stub.`
    );
  }
}

function countDeclaredProseReferences(gt: GroundTruth, scopes: TableName[]): number {
  let n = 0;
  if (scopes.includes('definition_metadata')) {
    n += (gt.definitionMetadata ?? []).filter((m) => m.proseReference != null).length;
  }
  if (scopes.includes('relationship_annotations')) {
    n += (gt.relationships ?? []).filter((r) => r.semanticReference != null).length;
  }
  if (scopes.includes('modules')) {
    n += (gt.modules ?? []).filter((m) => m.descriptionReference != null).length;
  }
  if (scopes.includes('interactions')) {
    n += (gt.interactions ?? []).filter((i) => i.semanticReference != null).length;
  }
  if (scopes.includes('flows')) {
    n += (gt.flows ?? []).filter((f) => f.descriptionReference != null).length;
  }
  if (scopes.includes('features')) {
    n += (gt.features ?? []).filter((f) => f.descriptionReference != null).length;
  }
  return n;
}

/**
 * Tables for which a comparator exists. Anything outside this set throws when
 * requested in scope — silently skipping is dangerous because the user could
 * believe they're checking a table when they're not.
 */
const IMPLEMENTED_COMPARATORS: ReadonlySet<TableName> = new Set([
  'files',
  'definitions',
  'imports',
  'modules',
  'module_members',
  'contracts',
  'interactions',
  'flows',
]);

function runComparator(table: TableName, produced: IndexDatabase, gt: GroundTruth): TableDiff {
  if (!IMPLEMENTED_COMPARATORS.has(table)) {
    throw new Error(
      `No comparator implemented for table '${table}'. Implemented: [${[...IMPLEMENTED_COMPARATORS].sort().join(', ')}]`
    );
  }
  switch (table) {
    case 'files':
      return compareFiles(produced, gt);
    case 'definitions':
      return compareDefinitions(produced, gt);
    case 'imports':
      return compareImports(produced, gt);
    case 'modules':
      return compareModules(produced, gt);
    case 'module_members':
      return compareModuleMembers(produced, gt);
    case 'contracts':
      return compareContracts(produced, gt);
    case 'interactions':
      return compareInteractions(produced, gt);
    case 'flows':
      return compareFlows(produced, gt);
    default:
      // Unreachable — IMPLEMENTED_COMPARATORS guard above ensures this branch can't fire.
      // Kept for exhaustiveness in case someone adds a TableName without updating both lists.
      throw new Error(`Unreachable: comparator dispatch fell through for '${table}'`);
  }
}

/**
 * Aggregate per-table diffs into a summary.
 *
 * Counting rules:
 * - Structural diffs (`missing`, `extra`, `mismatch`) increment critical/major/minor by severity.
 * - Prose drifts (`prose-drift` kind) ONLY increment `proseChecks.failed`. They do not
 *   double-count into `minor`. The minor counter is reserved for non-prose drifts (e.g.,
 *   line tolerance breaches).
 * - Passed prose checks come from each TableDiff's `proseChecks.passed` counter — they
 *   never generate RowDiffs because there's nothing to report.
 *
 * Exported for unit testing in isolation.
 */
export function aggregateSummary(tables: TableDiff[]): DiffSummary {
  const summary: DiffSummary = {
    critical: 0,
    major: 0,
    minor: 0,
    proseChecks: { passed: 0, failed: 0 },
  };
  for (const t of tables) {
    for (const d of t.diffs) {
      if (d.kind === 'prose-drift') {
        // Prose drifts are tracked only via proseChecks.failed.
        // Skip the severity counters to avoid double-counting.
        continue;
      }
      if (d.severity === 'critical') summary.critical += 1;
      else if (d.severity === 'major') summary.major += 1;
      else if (d.severity === 'minor') summary.minor += 1;
    }
    if (t.proseChecks) {
      summary.proseChecks.passed += t.proseChecks.passed;
      summary.proseChecks.failed += t.proseChecks.failed;
    }
  }
  return summary;
}
