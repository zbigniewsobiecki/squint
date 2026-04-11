import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateResults } from './results-rotation.js';

describe('rotateResults', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-eval-rotate-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.env.EVAL_KEEP_ALL = undefined;
  });

  function makeRun(name: string, mtimeOffsetMs: number): void {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    // Touch a file inside so the dir mtime is meaningful
    fs.writeFileSync(path.join(dir, 'diff.md'), 'x');
    const t = new Date(Date.now() + mtimeOffsetMs);
    fs.utimesSync(dir, t, t);
  }

  it('keeps the N most recent run directories', () => {
    makeRun('run-1', -5000);
    makeRun('run-2', -4000);
    makeRun('run-3', -3000);
    makeRun('run-4', -2000);
    makeRun('run-5', -1000);

    const result = rotateResults(root, 3);

    expect(result.kept.sort()).toEqual(['run-3', 'run-4', 'run-5']);
    expect(result.removed.sort()).toEqual(['run-1', 'run-2']);
    expect(fs.existsSync(path.join(root, 'run-1'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'run-5'))).toBe(true);
  });

  it('keeps everything when total runs <= keep', () => {
    makeRun('a', -1000);
    makeRun('b', 0);
    const result = rotateResults(root, 5);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(root, 'a'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'b'))).toBe(true);
  });

  it('ignores non-directory entries (e.g. .gitkeep)', () => {
    makeRun('run-1', 0);
    fs.writeFileSync(path.join(root, '.gitkeep'), '');
    const result = rotateResults(root, 1);
    expect(result.kept).toEqual(['run-1']);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(root, '.gitkeep'))).toBe(true);
  });

  it('is a no-op when EVAL_KEEP_ALL=1', () => {
    makeRun('a', -3000);
    makeRun('b', -2000);
    makeRun('c', -1000);
    process.env.EVAL_KEEP_ALL = '1';
    const result = rotateResults(root, 1);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(root, 'a'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'b'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'c'))).toBe(true);
  });

  it('handles a missing results directory gracefully', () => {
    const nonExistent = path.join(root, 'never-created');
    const result = rotateResults(nonExistent, 5);
    expect(result).toEqual({ kept: [], removed: [] });
  });
});
