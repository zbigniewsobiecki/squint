import fs from 'node:fs';
import path from 'node:path';

/**
 * Rotate eval result directories — keep only the N most recent runs.
 *
 * Each "run" is a sub-directory of `resultsRoot` whose name is an ISO timestamp
 * (e.g., `2026-04-07T20-45-29-454Z`). Non-directory entries and the `.gitkeep`
 * file are ignored. The newest `keep` directories are retained; the rest are
 * deleted recursively.
 *
 * Override with EVAL_KEEP_ALL=1 to disable rotation entirely.
 */
export function rotateResults(resultsRoot: string, keep = 10): { kept: string[]; removed: string[] } {
  if (process.env.EVAL_KEEP_ALL === '1') {
    return { kept: [], removed: [] };
  }
  if (!fs.existsSync(resultsRoot)) {
    return { kept: [], removed: [] };
  }

  const entries = fs
    .readdirSync(resultsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      mtimeMs: fs.statSync(path.join(resultsRoot, e.name)).mtimeMs,
    }))
    // Sort newest-first by mtime (timestamp dirs are also lexicographically sortable
    // but mtime is more robust against clock skew or manual edits).
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const kept = entries.slice(0, keep).map((e) => e.name);
  const toRemove = entries.slice(keep);

  for (const r of toRemove) {
    fs.rmSync(path.join(resultsRoot, r.name), { recursive: true, force: true });
  }

  return { kept, removed: toRemove.map((r) => r.name) };
}
