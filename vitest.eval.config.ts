import { defineConfig } from 'vitest/config';

/**
 * Vitest config for LLM-driven evaluation SCENARIOS only.
 *
 * Run via: `npm run eval`.
 *
 * Scope:
 *   evals/**\/*.eval.ts — real squint ingestion as a subprocess, real LLM calls,
 *   real money. Manually invoked.
 *
 * NOT here:
 *   evals/harness/**\/*.test.ts — these are free unit tests with zero subprocess
 *   and zero LLM calls. They live in the MAIN vitest.config.ts so every CI run
 *   exercises them.
 */
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    // Eval scenarios can take minutes (subprocess + LLM). Default per-test timeout high.
    testTimeout: 600_000,
    hookTimeout: 60_000,
    // Run sequentially — multiple subprocesses fighting for the same fixture dir is bad.
    fileParallelism: false,
    // Force-load .env with override BEFORE any test code is imported so the
    // OPENROUTER_API_KEY (and similar) used by the in-process judge AND by
    // spawned squint subprocesses always comes from the project-local .env
    // file, never a stale shell-level env var.
    setupFiles: ['./evals/setup.ts'],
  },
});
