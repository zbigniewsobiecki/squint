import { describe, it } from 'vitest';
import { todoApiGroundTruth } from './ground-truth/todo-api/index.js';
import { makeLlmProseJudge } from './harness/comparator/llm-prose-judge.js';
import { defineFixture } from './harness/fixture-config.js';
import { runIterationStep } from './harness/iteration.js';

const TODO_API = defineFixture('todo-api');

describe('todo-api eval', () => {
  it('iteration 1: parse stage produces expected files, definitions, and imports', async () => {
    await runIterationStep({
      fixture: TODO_API,
      groundTruth: todoApiGroundTruth,
      label: 'parse',
      toStage: 'parse',
      scope: ['files', 'definitions', 'imports'],
      timeoutMs: 60_000,
    });
  }, 120_000);

  it('iteration 2: symbols stage produces expected definition_metadata', async () => {
    await runIterationStep({
      fixture: TODO_API,
      groundTruth: todoApiGroundTruth,
      label: 'symbols',
      toStage: 'symbols',
      scope: ['files', 'definitions', 'imports', 'definition_metadata'],
      // Real LLM judge — uses gemini-2.5-flash by default (override via EVAL_JUDGE_MODEL).
      // Cache lives at evals/.judge-cache.json (gitignored). Re-runs with the same
      // (model, reference, candidate) tuples cost $0.
      judgeFn: makeLlmProseJudge({ cachePath: TODO_API.judgeCachePath }),
      timeoutMs: 180_000,
    });
  }, 300_000);

  it('iteration 3: relationships stage produces expected relationship_annotations', async () => {
    await runIterationStep({
      fixture: TODO_API,
      groundTruth: todoApiGroundTruth,
      label: 'relationships',
      toStage: 'relationships',
      // Scope includes definition_metadata as a regression check on iteration 2 —
      // running --to-stage relationships also runs symbols, so any vocabulary
      // drift in symbols would surface here too.
      scope: ['files', 'definitions', 'imports', 'definition_metadata', 'relationship_annotations'],
      judgeFn: makeLlmProseJudge({ cachePath: TODO_API.judgeCachePath }),
      timeoutMs: 240_000,
    });
  }, 360_000);

  it('iteration 4: modules stage produces expected modules + module_members', async () => {
    await runIterationStep({
      fixture: TODO_API,
      groundTruth: todoApiGroundTruth,
      label: 'modules',
      toStage: 'modules',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'modules',
        'module_members',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: TODO_API.judgeCachePath }),
      timeoutMs: 360_000,
      costBudgetUsd: 0.2,
    });
  }, 480_000);

  it('iteration 4.5: modules-verify stage leaves modules + module_members unchanged', async () => {
    // Regression detector for the modules-verify stage. Phase 1 is deterministic
    // (test-in-production, ghost rows, unassigned defs) and finds nothing on
    // todo-api (no test files, full coverage). Phase 2 is an LLM coherence check
    // that should mark every assignment 'correct' for the well-formed iter-4
    // module tree. Expected: byte-identical produced state vs iter 4, so the
    // same GT objects work unchanged.
    //
    // Cost budget bumped to 0.30 as defense in depth: if Phase 2 ever fires
    // a reassignment, the cascade regenerates interactions+flows which is
    // expensive. The cost guardrail will trip loudly instead of silently.
    await runIterationStep({
      fixture: TODO_API,
      groundTruth: todoApiGroundTruth,
      label: 'modules-verify',
      toStage: 'modules-verify',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'modules',
        'module_members',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: TODO_API.judgeCachePath }),
      timeoutMs: 420_000,
      costBudgetUsd: 0.3,
    });
  }, 540_000);
});
