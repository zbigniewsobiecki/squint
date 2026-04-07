import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-fixture path layout. One `defineFixture()` call replaces ~10 hardcoded
 * path constants in each eval test file. New fixtures get the same layout for free.
 */
export interface FixtureConfig {
  /** Short name (matches fixture directory and baseline filename). */
  name: string;
  /** Absolute path to the squint repo root. */
  repoRoot: string;
  /** Absolute path to the fixture sources (evals/fixtures/<name>). */
  fixtureDir: string;
  /** Absolute path to the per-run results directory (evals/results). */
  resultsRoot: string;
  /** Absolute path to the persisted baseline JSON (evals/baselines/<name>.json). */
  baselinePath: string;
  /** Absolute path to the squint dev binary. */
  squintBin: string;
  /**
   * Absolute path to the LLM judge cache. Lives OUTSIDE evals/results/ so the
   * results-rotation cleanup cannot delete it. Gitignored.
   */
  judgeCachePath: string;
  /** Resolve the current squint git short SHA, or 'unknown' on failure. */
  squintCommit: () => string;
}

export function defineFixture(name: string): FixtureConfig {
  // __dirname for this file is evals/harness/. Repo root is two levels up.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '..', '..');

  return {
    name,
    repoRoot,
    fixtureDir: path.resolve(repoRoot, 'evals/fixtures', name),
    resultsRoot: path.resolve(repoRoot, 'evals/results'),
    baselinePath: path.resolve(repoRoot, 'evals/baselines', `${name}.json`),
    squintBin: path.resolve(repoRoot, 'bin/dev.js'),
    judgeCachePath: path.resolve(repoRoot, 'evals/.judge-cache.json'),
    squintCommit: () => {
      try {
        return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim();
      } catch {
        return 'unknown';
      }
    },
  };
}
