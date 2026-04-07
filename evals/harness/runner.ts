import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as defaultSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Pipeline stage IDs accepted by `squint ingest --from-stage / --to-stage`.
 * Mirrors STAGE_IDS in src/commands/ingest.ts:27-43.
 */
export type StageId =
  | 'parse'
  | 'symbols'
  | 'symbols-verify'
  | 'domains-consolidate'
  | 'relationships'
  | 'relationships-verify'
  | 'modules'
  | 'modules-verify'
  | 'contracts'
  | 'interactions'
  | 'interactions-validate'
  | 'interactions-verify'
  | 'flows'
  | 'flows-verify'
  | 'features';

export interface RunOptions {
  fixtureDir: string;
  outputDb: string;
  fromStage?: StageId;
  toStage?: StageId;
  model?: string;
  force?: boolean;
  /** Hard timeout in milliseconds. Default 600_000 (10 minutes). */
  timeoutMs?: number;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when forcibly stopping a
   * child that exceeded the timeout. Default 5_000. Tests use a small value.
   */
  sigkillGraceMs?: number;
  /** Where to write captured stdout. */
  stdoutPath: string;
  /** Where to write captured stderr. */
  stderrPath: string;
  /** Tee child stdout/stderr to current process? Default false. */
  showOutput?: boolean;
  /** Override the squint dev binary path (for tests). */
  squintBin?: string;
}

export interface RunResult {
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
  durationMs: number;
  /** Sum of all `cost: $X` lines parsed from stdout. */
  costEstimate?: number;
}

/**
 * Narrow spawn signature — only the overload the runner actually uses.
 * Easier to substitute in tests than `typeof child_process.spawn`.
 */
export type SpawnFn = (command: string, args: readonly string[], options?: SpawnOptions) => ChildProcess;

/**
 * Spawn dependency injection — tests pass a fake spawn.
 */
export interface RunnerDeps {
  spawn?: SpawnFn;
}

/**
 * Build the argv that will be passed to `node bin/dev.js`.
 * Pure function — no side effects, easy to test.
 */
export function buildIngestArgv(opts: {
  fixtureDir: string;
  outputDb: string;
  fromStage?: StageId;
  toStage?: StageId;
  model?: string;
  force?: boolean;
}): string[] {
  const argv: string[] = ['ingest', opts.fixtureDir, '-o', opts.outputDb];
  if (opts.fromStage) argv.push('--from-stage', opts.fromStage);
  if (opts.toStage) argv.push('--to-stage', opts.toStage);
  if (opts.model) argv.push('-m', opts.model);
  if (opts.force) argv.push('--force');
  return argv;
}

/**
 * Parse a single stdout line for a USD cost. Returns null on no match.
 *
 * Matches three formats:
 *   1. "← LLM  4.6s  in: 2,930  out: 603  cached: 0  $0.0024  [2/200]"
 *      — squint's actual per-call summary line (the format that matters
 *        in production; see src/commands/llm/_shared/llm-utils.ts:310-318)
 *   2. "Total cost: $0.0123" — aggregate summary
 *   3. "cost: $0.05" — generic
 *
 * Order of matching: explicit "cost" prefix wins (more specific). Fall back
 * to the LLM-summary-line shape (a $X.XX trailing a "← LLM" prefix).
 */
export function parseCostLine(line: string): number | null {
  // Format 2 & 3: explicit "cost" prefix
  const costPrefixed = line.match(/cost[: ]\s*\$([0-9]+\.?[0-9]*)/i);
  if (costPrefixed) return toFiniteNumber(costPrefixed[1]);

  // Format 1: squint's "← LLM ... $X.XXXX" summary. Anchor on the LLM
  // summary marker so we don't accidentally match dollar signs in other
  // contexts (e.g. user prompts that contain "$10" string literals).
  const llmSummary = line.match(/←\s*LLM\b.*\$([0-9]+\.?[0-9]*)/);
  if (llmSummary) return toFiniteNumber(llmSummary[1]);

  return null;
}

function toFiniteNumber(s: string): number | null {
  const value = Number.parseFloat(s);
  return Number.isFinite(value) ? value : null;
}

/**
 * Run squint ingest as a subprocess. Streams stdout/stderr to log files,
 * enforces a hard timeout, parses cost lines into a running total.
 */
export async function runIngest(opts: RunOptions, deps: RunnerDeps = {}): Promise<RunResult> {
  const spawnFn: SpawnFn = deps.spawn ?? (defaultSpawn as unknown as SpawnFn);
  const start = Date.now();

  const argv = buildIngestArgv(opts);
  const squintBin = opts.squintBin ?? path.resolve(process.cwd(), 'bin', 'dev.js');

  // Ensure log directories exist
  fs.mkdirSync(path.dirname(opts.stdoutPath), { recursive: true });
  fs.mkdirSync(path.dirname(opts.stderrPath), { recursive: true });
  const stdoutStream = fs.createWriteStream(opts.stdoutPath);
  const stderrStream = fs.createWriteStream(opts.stderrPath);

  // Surface stream errors instead of letting them become unhandled rejections.
  // Disk-full / permission errors should fail loudly, not silently.
  let streamError: Error | undefined;
  stdoutStream.on('error', (err) => {
    streamError = err;
  });
  stderrStream.on('error', (err) => {
    streamError = err;
  });

  const spawnOpts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] };
  const child = spawnFn('node', [squintBin, ...argv], spawnOpts);

  let costEstimate: number | undefined;
  let stdoutBuffer = '';

  const handleStdoutChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8');
    stdoutStream.write(text);
    if (opts.showOutput) process.stdout.write(text);
    // Parse cost lines (line-buffered)
    stdoutBuffer += text;
    let nl = stdoutBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      const cost = parseCostLine(line);
      if (cost !== null) {
        costEstimate = (costEstimate ?? 0) + cost;
      }
      nl = stdoutBuffer.indexOf('\n');
    }
  };

  const handleStderrChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8');
    stderrStream.write(text);
    if (opts.showOutput) process.stderr.write(text);
  };

  child.stdout?.on('data', handleStdoutChunk);
  child.stderr?.on('data', handleStderrChunk);

  // Wait for a write stream to fully flush before resolving — otherwise readers
  // race the buffered file content.
  const closeStream = (stream: fs.WriteStream): Promise<void> =>
    new Promise((res) => {
      if (stream.writableEnded) {
        res();
        return;
      }
      stream.end(() => res());
    });

  return new Promise<RunResult>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 600_000;
    const sigkillGraceMs = opts.sigkillGraceMs ?? 5_000;
    let timedOut = false;
    let sigkillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate to SIGKILL if the child ignores SIGTERM (stuck event loop, etc.)
      sigkillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // child may have already exited between SIGTERM and the grace timer
        }
      }, sigkillGraceMs);
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    };

    const finalize = async (): Promise<{ stdoutPath: string; stderrPath: string }> => {
      await Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]);
      return { stdoutPath: opts.stdoutPath, stderrPath: opts.stderrPath };
    };

    child.on('error', (err) => {
      cleanup();
      void finalize().then(() => {
        if (streamError) reject(streamError);
        else if (timedOut) reject(new Error(`squint ingest timeout after ${timeoutMs}ms`));
        else reject(err);
      });
    });

    child.on('close', (code) => {
      cleanup();
      void finalize().then(() => {
        if (streamError) {
          reject(streamError);
          return;
        }
        if (timedOut) {
          reject(new Error(`squint ingest timeout after ${timeoutMs}ms`));
          return;
        }
        // Final flush of any pending cost line in the buffer
        if (stdoutBuffer.length > 0) {
          const cost = parseCostLine(stdoutBuffer);
          if (cost !== null) costEstimate = (costEstimate ?? 0) + cost;
        }
        resolve({
          exitCode: code ?? 0,
          stdoutPath: opts.stdoutPath,
          stderrPath: opts.stderrPath,
          durationMs: Date.now() - start,
          costEstimate,
        });
      });
    });
  });
}
