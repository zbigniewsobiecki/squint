import fs from 'node:fs';
import path from 'node:path';
import { IndexDatabase } from '../../src/db/database-facade.js';
import { compare } from './comparator/index.js';
import type { FixtureConfig } from './fixture-config.js';
import { updateBaseline } from './reporter/baseline.js';
import { renderJsonReport, renderMarkdownReport } from './reporter/index.js';
import { rotateResults } from './results-rotation.js';
import { type RunResult, type StageId, runIngest } from './runner.js';
import { type ProseJudgeFn, type TableName, makeStubJudge } from './types.js';
import type { DiffReport, GroundTruth } from './types.js';

/**
 * One end-to-end iteration of the eval loop:
 *   1. Spawn `squint ingest --to-stage <stage>` against the fixture
 *   2. Cost guardrail (refuses to run if estimated cost exceeds budget)
 *   3. Open the produced DB and call compare()
 *   4. Persist diff.md + diff.json + baseline + rotate
 *   5. Echo a one-line summary to stdout
 *   6. Throw on critical/major diffs (test framework picks it up)
 *
 * Replaces the ~80 LOC of boilerplate that was duplicated between
 * iteration 1 and 2 blocks in todo-api.eval.ts. New iterations are now
 * ~10 lines.
 */

export interface IterationStepOptions {
  /** Fixture paths and metadata. */
  fixture: FixtureConfig;
  /** Ground truth for this fixture (the same object across iterations). */
  groundTruth: GroundTruth;
  /** Human-readable label for logging (e.g. "parse", "symbols"). */
  label: string;
  /** Last pipeline stage to run via `squint ingest --to-stage`. */
  toStage: StageId;
  /** Tables to compare against ground truth. */
  scope: TableName[];
  /**
   * Prose judge. Default: makeStubJudge() — fine for parse-only iterations.
   * For LLM stages with prose references, pass `makeLlmProseJudge({...})`.
   */
  judgeFn?: ProseJudgeFn;
  /** Per-stage timeout in ms. Default 60s. */
  timeoutMs?: number;
  /**
   * Cost budget in USD. Default reads EVAL_COST_BUDGET_USD env var or 0.10.
   * If the squint subprocess reports a higher running cost, the eval throws.
   */
  costBudgetUsd?: number;
  /**
   * Inject `runIngest` (for tests). Defaults to the real subprocess runner.
   */
  runIngestFn?: typeof runIngest;
}

export interface IterationStepResult {
  report: DiffReport;
  runResult: RunResult;
  runDir: string;
}

export async function runIterationStep(opts: IterationStepOptions): Promise<IterationStepResult> {
  const { fixture, groundTruth, label, toStage, scope } = opts;
  const judgeFn = opts.judgeFn ?? makeStubJudge();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const budget = opts.costBudgetUsd ?? Number(process.env.EVAL_COST_BUDGET_USD ?? '0.10');
  const runIngestImpl = opts.runIngestFn ?? runIngest;

  // ----------------------------------------------------------
  // 1. Per-run results directory
  // ----------------------------------------------------------
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(fixture.resultsRoot, ts);
  fs.mkdirSync(runDir, { recursive: true });
  const producedDbPath = path.join(runDir, 'produced.db');

  // ----------------------------------------------------------
  // 2. Run squint ingest --to-stage <stage>
  // ----------------------------------------------------------
  const runResult = await runIngestImpl({
    fixtureDir: fixture.fixtureDir,
    outputDb: producedDbPath,
    toStage,
    timeoutMs,
    stdoutPath: path.join(runDir, 'stdout.log'),
    stderrPath: path.join(runDir, 'stderr.log'),
    squintBin: fixture.squintBin,
  });

  if (runResult.exitCode !== 0) {
    throw new Error(
      `squint ingest --to-stage ${toStage} failed (exit ${runResult.exitCode}); see ${runResult.stderrPath}`
    );
  }
  if (!fs.existsSync(producedDbPath)) {
    throw new Error(`squint ingest succeeded but produced DB is missing at ${producedDbPath}`);
  }

  // Cost guardrail — only enforces when squint actually reported a cost.
  // (Stages with no LLM calls return undefined; that's fine.)
  if (runResult.costEstimate != null && runResult.costEstimate > budget) {
    throw new Error(
      `squint ingest cost $${runResult.costEstimate.toFixed(4)} exceeded budget $${budget.toFixed(2)} (override via EVAL_COST_BUDGET_USD)`
    );
  }

  // ----------------------------------------------------------
  // 3. Compare produced vs ground truth
  // ----------------------------------------------------------
  const produced = new IndexDatabase(producedDbPath);
  let report: DiffReport;
  try {
    report = await compare({
      produced,
      groundTruth,
      scope,
      judgeFn,
      squintCommit: fixture.squintCommit(),
    });
  } finally {
    produced.close();
  }

  // ----------------------------------------------------------
  // 4. Persist diff report + update baseline + rotate
  // ----------------------------------------------------------
  fs.writeFileSync(path.join(runDir, 'diff.md'), renderMarkdownReport(report));
  fs.writeFileSync(path.join(runDir, 'diff.json'), renderJsonReport(report));
  const baselineUpdate = updateBaseline(fixture.baselinePath, report);
  rotateResults(fixture.resultsRoot, 10);

  // ----------------------------------------------------------
  // 5. Echo summary
  // ----------------------------------------------------------
  const proseTotal = report.summary.proseChecks.passed + report.summary.proseChecks.failed;
  const proseStr = proseTotal > 0 ? ` prose=${report.summary.proseChecks.passed}/${proseTotal}` : '';
  const costStr = runResult.costEstimate != null ? ` cost=$${runResult.costEstimate.toFixed(4)}` : '';
  // eslint-disable-next-line no-console
  console.log(
    `[eval] ${fixture.name} ${label} → critical=${report.summary.critical} major=${report.summary.major} minor=${report.summary.minor}${proseStr}${costStr} (report: ${path.relative(fixture.repoRoot, runDir)})`
  );
  for (const reg of baselineUpdate.regressions) {
    // eslint-disable-next-line no-console
    console.log(`[eval] regression: ${reg}`);
  }
  for (const imp of baselineUpdate.improvements) {
    // eslint-disable-next-line no-console
    console.log(`[eval] improvement: ${imp}`);
  }

  // ----------------------------------------------------------
  // 6. Throw on critical/major diffs (test framework picks up)
  // ----------------------------------------------------------
  if (!report.passed) {
    throw new Error(
      `Iteration '${label}' failed: see ${path.relative(fixture.repoRoot, path.join(runDir, 'diff.md'))}`
    );
  }

  return { report, runResult, runDir };
}
