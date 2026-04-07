import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIngestArgv, parseCostLine, runIngest } from './runner.js';

/**
 * The runner spawns `squint ingest` as a subprocess. Tests cover:
 * - argv shape (no real subprocess needed — pure function)
 * - cost line parsing (pure function)
 * - timeout / exit code handling (with a fake spawn)
 *
 * No real subprocess is launched in this test file.
 */
describe('runner — buildIngestArgv', () => {
  it('emits the minimal required argv', () => {
    const argv = buildIngestArgv({
      fixtureDir: '/abs/fixture',
      outputDb: '/abs/produced.db',
    });
    expect(argv).toEqual(['ingest', '/abs/fixture', '-o', '/abs/produced.db']);
  });

  it('passes --from-stage and --to-stage when provided', () => {
    const argv = buildIngestArgv({
      fixtureDir: '/f',
      outputDb: '/p.db',
      fromStage: 'parse',
      toStage: 'parse',
    });
    expect(argv).toContain('--from-stage');
    expect(argv).toContain('parse');
    expect(argv).toContain('--to-stage');
    // both occurrences of 'parse' present
    expect(argv.filter((x) => x === 'parse')).toHaveLength(2);
  });

  it('passes -m model when provided', () => {
    const argv = buildIngestArgv({
      fixtureDir: '/f',
      outputDb: '/p.db',
      model: 'openrouter:google/gemini-2.5-flash',
    });
    expect(argv).toContain('-m');
    expect(argv).toContain('openrouter:google/gemini-2.5-flash');
  });

  it('passes --force when requested', () => {
    const argv = buildIngestArgv({ fixtureDir: '/f', outputDb: '/p.db', force: true });
    expect(argv).toContain('--force');
  });
});

describe('runner — parseCostLine', () => {
  it('parses a "Total cost: $X" line', () => {
    expect(parseCostLine('  Total cost: $0.0123')).toBe(0.0123);
    expect(parseCostLine('Total cost: $0.50')).toBe(0.5);
  });

  it('parses a "cost: $X" line', () => {
    expect(parseCostLine('cost: $0.05')).toBe(0.05);
  });

  it('parses squint\'s actual "← LLM" summary line format (the format that matters in production)', () => {
    // This is what squint actually emits — captured from a real run.
    // See src/commands/llm/_shared/llm-utils.ts:310-318 (formatCost + parts.join).
    expect(parseCostLine('  ← LLM  4.6s  in: 2,930  out: 603  cached: 0  $0.0024  [2/200]')).toBe(0.0024);
    expect(parseCostLine('  ← LLM  2.2s  in: 3,010  out: 397  cached: 0  $0.0019')).toBe(0.0019);
    expect(parseCostLine('  ← LLM  1.6s  in: 1,720  out: 194  cached: 0  $0.0010  [5/200]')).toBe(0.001);
    // Larger amounts (≥$0.01) — squint formats them with two decimals
    expect(parseCostLine('  ← LLM  5s  in: 100  out: 100  cached: 0  $0.50')).toBe(0.5);
  });

  it('returns null for non-cost lines', () => {
    expect(parseCostLine('parsing files...')).toBeNull();
    expect(parseCostLine('')).toBeNull();
    expect(parseCostLine('  → LLM  openrouter:google/gemini-2.5-flash  ~3,500 tok')).toBeNull();
  });
});

describe('runner — runIngest with stubbed spawn', () => {
  let logDir: string;
  let stdoutPath: string;
  let stderrPath: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-runner-test-'));
    stdoutPath = path.join(logDir, 'stdout.log');
    stderrPath = path.join(logDir, 'stderr.log');
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  const baseOpts = (): { fixtureDir: string; outputDb: string; stdoutPath: string; stderrPath: string } => ({
    fixtureDir: '/f',
    outputDb: '/p.db',
    stdoutPath,
    stderrPath,
  });

  it('returns exitCode 0 on a successful child', async () => {
    const fakeSpawn = makeFakeSpawn({ exitCode: 0, stdout: 'parse complete\nTotal cost: $0.02\n' });
    const result = await runIngest({ ...baseOpts(), fromStage: 'parse', toStage: 'parse' }, { spawn: fakeSpawn });
    expect(result.exitCode).toBe(0);
    expect(result.costEstimate).toBe(0.02);
  });

  it('returns the non-zero exit code on failure', async () => {
    const fakeSpawn = makeFakeSpawn({ exitCode: 1, stdout: '', stderr: 'boom' });
    const result = await runIngest(baseOpts(), { spawn: fakeSpawn });
    expect(result.exitCode).toBe(1);
  });

  it('rejects when child exceeds timeout — production close-handler path', async () => {
    // Simulates the REAL production path: child does NOT emit 'error' on kill,
    // it just emits 'close' with a non-zero/null exit code. This catches
    // regressions where the error-path masks the close-path.
    const fakeSpawn = makeFakeSpawn({
      exitCode: 0,
      stdout: '',
      delayMs: 100,
      closeOnKill: true, // emit 'close' (not 'error') when kill() is called
    });
    await expect(runIngest({ ...baseOpts(), timeoutMs: 10 }, { spawn: fakeSpawn })).rejects.toThrow(/timeout/i);
  });

  it('aggregates multiple cost lines into a total', async () => {
    const fakeSpawn = makeFakeSpawn({
      exitCode: 0,
      stdout: 'symbols complete\ncost: $0.03\nrelationships complete\ncost: $0.04\n',
    });
    const result = await runIngest(baseOpts(), { spawn: fakeSpawn });
    expect(result.costEstimate).toBeCloseTo(0.07, 5);
  });

  it('streams stdout to the configured log file', async () => {
    const fakeSpawn = makeFakeSpawn({ exitCode: 0, stdout: 'hello world\n' });
    const result = await runIngest(baseOpts(), { spawn: fakeSpawn });
    expect(fs.readFileSync(result.stdoutPath, 'utf-8')).toBe('hello world\n');
  });

  it('escalates to SIGKILL when child ignores SIGTERM', async () => {
    // Child never emits 'close' even after kill('SIGTERM'). The runner must
    // escalate to SIGKILL after the grace period and force-resolve via 'close'.
    const fakeSpawn = makeFakeSpawn({
      exitCode: 0,
      stdout: '',
      delayMs: 10_000, // would never finish in time
      ignoreSigterm: true,
    });
    const start = Date.now();
    await expect(runIngest({ ...baseOpts(), timeoutMs: 20, sigkillGraceMs: 30 }, { spawn: fakeSpawn })).rejects.toThrow(
      /timeout/i
    );
    // Should reject within timeout + grace + small slack, not 10s
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// ============================================================
// Test helpers
// ============================================================

interface FakeSpawnOpts {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
  /** When true, kill() emits 'close' with exit code 143 (SIGTERM), like a real child. */
  closeOnKill?: boolean;
  /** When true, the child ignores SIGTERM and only responds to SIGKILL. */
  ignoreSigterm?: boolean;
}

function makeFakeSpawn(opts: FakeSpawnOpts) {
  return vi.fn(() => {
    const stdoutListeners: Array<(chunk: Buffer) => void> = [];
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const closeListeners: Array<(code: number) => void> = [];
    const errorListeners: Array<(err: Error) => void> = [];

    let scheduledFire: NodeJS.Timeout | undefined;
    let alreadyClosed = false;

    const fireClose = (code: number) => {
      if (alreadyClosed) return;
      alreadyClosed = true;
      for (const fn of closeListeners) fn(code);
    };

    const child = {
      stdout: {
        on(event: string, fn: (chunk: Buffer) => void) {
          if (event === 'data') stdoutListeners.push(fn);
        },
      },
      stderr: {
        on(event: string, fn: (chunk: Buffer) => void) {
          if (event === 'data') stderrListeners.push(fn);
        },
      },
      on(event: string, fn: (...args: unknown[]) => void) {
        if (event === 'close') closeListeners.push(fn as (code: number) => void);
        if (event === 'error') errorListeners.push(fn as (err: Error) => void);
      },
      kill(signal?: string) {
        if (signal === 'SIGKILL' || !opts.ignoreSigterm) {
          if (scheduledFire) clearTimeout(scheduledFire);
          if (opts.closeOnKill || opts.ignoreSigterm) {
            fireClose(143);
          } else {
            for (const fn of errorListeners) fn(new Error('killed'));
          }
        }
        // SIGTERM with ignoreSigterm: do nothing — child stays alive
      },
    };

    const fire = () => {
      if (alreadyClosed) return;
      if (opts.stdout) {
        for (const fn of stdoutListeners) fn(Buffer.from(opts.stdout));
      }
      if (opts.stderr) {
        for (const fn of stderrListeners) fn(Buffer.from(opts.stderr));
      }
      fireClose(opts.exitCode);
    };

    if (opts.delayMs) {
      scheduledFire = setTimeout(fire, opts.delayMs);
    } else {
      // Defer to next tick so listeners can attach
      setImmediate(fire);
    }

    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  });
}
