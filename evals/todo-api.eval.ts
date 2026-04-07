import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexDatabase } from '../src/db/database-facade.js';
import { todoApiGroundTruth } from './ground-truth/todo-api/index.js';
import { compare } from './harness/comparator/index.js';
import { updateBaseline } from './harness/reporter/baseline.js';
import { renderJsonReport, renderMarkdownReport } from './harness/reporter/index.js';
import { rotateResults } from './harness/results-rotation.js';
import { runIngest } from './harness/runner.js';
import { type TableName, makeStubJudge } from './harness/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.resolve(REPO_ROOT, 'evals/fixtures/todo-api');
const RESULTS_ROOT = path.resolve(REPO_ROOT, 'evals/results');
const BASELINE_PATH = path.resolve(REPO_ROOT, 'evals/baselines/todo-api.json');
const SQUINT_BIN = path.resolve(REPO_ROOT, 'bin/dev.js');

/** Resolve current squint git SHA for the baseline header. */
function squintCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

describe('todo-api eval', () => {
  it('iteration 1: parse stage produces expected files, definitions, and imports', async () => {
    // ----------------------------------------------------------
    // Setup: per-run results directory
    // ----------------------------------------------------------
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = path.join(RESULTS_ROOT, ts);
    fs.mkdirSync(runDir, { recursive: true });
    const producedDbPath = path.join(runDir, 'produced.db');

    // ----------------------------------------------------------
    // Run squint ingest --to-stage parse
    // ----------------------------------------------------------
    const runResult = await runIngest({
      fixtureDir: FIXTURE_DIR,
      outputDb: producedDbPath,
      toStage: 'parse',
      timeoutMs: 60_000,
      stdoutPath: path.join(runDir, 'stdout.log'),
      stderrPath: path.join(runDir, 'stderr.log'),
      // Absolute path — works regardless of test cwd, so the eval can be
      // invoked from any subdirectory.
      squintBin: SQUINT_BIN,
    });

    expect(runResult.exitCode, `squint ingest failed; see ${runResult.stderrPath}`).toBe(0);
    expect(fs.existsSync(producedDbPath), `produced DB missing at ${producedDbPath}`).toBe(true);

    // ----------------------------------------------------------
    // Compare produced vs ground truth
    // ----------------------------------------------------------
    const produced = new IndexDatabase(producedDbPath);
    const scope: TableName[] = ['files', 'definitions', 'imports'];

    try {
      // Iteration 1 has zero prose references in scope, so the stub judge is
      // safe. The compare() guardrail will throw if a future iteration adds
      // prose references but forgets to swap in a real LLM judge.
      const report = await compare({
        produced,
        groundTruth: todoApiGroundTruth,
        scope,
        judgeFn: makeStubJudge(),
        squintCommit: squintCommit(),
      });

      // Persist diff report (markdown + json) and update baseline
      fs.writeFileSync(path.join(runDir, 'diff.md'), renderMarkdownReport(report));
      fs.writeFileSync(path.join(runDir, 'diff.json'), renderJsonReport(report));
      const baselineUpdate = updateBaseline(BASELINE_PATH, report);

      // Rotate old result directories — keep last 10 by default, override with EVAL_KEEP_ALL=1
      rotateResults(RESULTS_ROOT, 10);

      // Echo a short summary so vitest output is informative without dumping the whole report
      // eslint-disable-next-line no-console
      console.log(
        `[eval] todo-api parse → critical=${report.summary.critical} major=${report.summary.major} minor=${report.summary.minor} (report: ${path.relative(REPO_ROOT, runDir)})`
      );
      if (baselineUpdate.regressions.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[eval] regressions: ${baselineUpdate.regressions.join(', ')}`);
      }
      if (baselineUpdate.improvements.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[eval] improvements: ${baselineUpdate.improvements.join(', ')}`);
      }

      // Fail loudly if any critical/major diffs — point user at the report
      expect(report.passed, `Eval failed: see ${path.relative(REPO_ROOT, path.join(runDir, 'diff.md'))}`).toBe(true);
    } finally {
      produced.close();
    }
  }, 120_000);
});
