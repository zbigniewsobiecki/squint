import type { IndexDatabase } from '../../../src/db/database-facade.js';
import {
  type DiffReport,
  type DiffSummary,
  type GroundTruth,
  PROSE_BEARING_TABLES,
  PROSE_REFERENCE_COUNTERS,
  type ProseJudgeFn,
  STUB_JUDGE_MARKER,
  type TableDiff,
  type TableName,
} from '../types.js';
import {
  compareContracts,
  compareDefinitionMetadata,
  compareDefinitions,
  compareFiles,
  compareFlows,
  compareImports,
  compareInteractions,
  compareModuleCohesion,
  compareModuleMembers,
  compareModules,
  compareRelationshipAnnotations,
} from './tables/index.js';

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
    // Some comparators are async (those that call the LLM judge); awaited uniformly here.
    tables.push(await runComparator(tableName, produced, groundTruth, judgeFn));
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
 *
 * When the guardrail is checked but does NOT fire (the common, healthy case),
 * a single line is logged via console.debug so CI logs visibly confirm the
 * guardrail is alive. Set EVAL_DEBUG=1 to see these lines locally.
 */
function assertNoStubJudgeForProseChecks(judgeFn: ProseJudgeFn, scope: TableName[], gt: GroundTruth): void {
  const isStub = judgeFn[STUB_JUDGE_MARKER] === true;
  if (!isStub) {
    debugLog(`stub-judge guardrail: real judge in use; no check needed (scope=[${scope.join(', ')}])`);
    return;
  }

  const proseScopes = scope.filter((s) => PROSE_BEARING_TABLES.has(s));
  if (proseScopes.length === 0) {
    debugLog(`stub-judge guardrail: stub OK; no prose-bearing tables in scope (scope=[${scope.join(', ')}])`);
    return;
  }

  // Stub judge IS allowed unless GT actually declares prose references in
  // an in-scope table. Walk the GT to check.
  const hasProseRefs = countDeclaredProseReferences(gt, proseScopes);
  if (hasProseRefs > 0) {
    throw new Error(
      `Stub judge is forbidden when prose checks are in scope and ground truth declares prose references. Scope contains ${proseScopes.length} prose-bearing table(s) (${proseScopes.join(', ')}) and ground truth declares ${hasProseRefs} prose reference(s). Inject a real LLM-backed judge instead of a stub.`
    );
  }
  debugLog(
    `stub-judge guardrail: stub OK; ${proseScopes.length} prose-bearing scope(s) but GT declares 0 prose references (proseScopes=[${proseScopes.join(', ')}])`
  );
}

/**
 * Single-line trace channel for the eval harness. Off by default; turn on
 * with EVAL_DEBUG=1. Goes to stderr to avoid polluting the eval's stdout
 * report log lines.
 */
function debugLog(message: string): void {
  if (process.env.EVAL_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(`[eval debug] ${message}`);
  }
}

function countDeclaredProseReferences(gt: GroundTruth, scopes: TableName[]): number {
  let n = 0;
  for (const scope of scopes) {
    const counter = PROSE_REFERENCE_COUNTERS[scope];
    if (counter) n += counter(gt);
  }
  return n;
}

/**
 * Comparator function signature. Some comparators need the prose judge,
 * some don't — both shapes are accepted (the dispatcher passes judgeFn
 * unconditionally).
 */
type ComparatorFn = (produced: IndexDatabase, gt: GroundTruth, judgeFn: ProseJudgeFn) => TableDiff | Promise<TableDiff>;

/**
 * Single source of truth for which tables have a comparator implementation.
 * Adding a new table = one entry here. The dispatcher and the
 * "no comparator implemented" guard both read from this map.
 */
const COMPARATORS: Partial<Record<TableName, ComparatorFn>> = {
  files: (p, g) => compareFiles(p, g),
  definitions: (p, g) => compareDefinitions(p, g),
  imports: (p, g) => compareImports(p, g),
  modules: (p, g, j) => compareModules(p, g, j),
  module_members: (p, g) => compareModuleMembers(p, g),
  contracts: (p, g) => compareContracts(p, g),
  interactions: (p, g) => compareInteractions(p, g),
  flows: (p, g) => compareFlows(p, g),
  definition_metadata: (p, g, j) => compareDefinitionMetadata(p, g, j),
  relationship_annotations: (p, g, j) => compareRelationshipAnnotations(p, g, j),
  module_cohesion: (p, g, j) => compareModuleCohesion(p, g, j),
};

async function runComparator(
  table: TableName,
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const fn = COMPARATORS[table];
  if (!fn) {
    const implemented = (Object.keys(COMPARATORS) as TableName[]).sort().join(', ');
    throw new Error(`No comparator implemented for table '${table}'. Implemented: [${implemented}]`);
  }
  return fn(produced, gt, judgeFn);
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
