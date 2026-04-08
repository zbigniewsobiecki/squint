/**
 * Vitest setup for the eval harness.
 *
 * Loaded via `setupFiles` in `vitest.eval.config.ts` so it runs ONCE in each
 * vitest worker before any test code is imported.
 *
 * Sole responsibility: force-load `.env` with `override: true` so the
 * `OPENROUTER_API_KEY` (and any other secrets) used by the in-process LLM
 * judge AND by spawned `squint ingest` subprocesses always come from the
 * project-local `.env` file. Without `override`, dotenv keeps any shell-level
 * env var, which can drift (stale credits, wrong account, etc.) and lead to
 * confusing eval failures.
 *
 * The spawned subprocess inherits the worker's env, so loading here is
 * sufficient — no separate dotenv call inside the squint binary is needed
 * for the eval-harness flow.
 */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({
  path: path.resolve(process.cwd(), '.env'),
  override: true,
});
