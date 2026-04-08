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

  it('iteration 3.5: relationships-verify stage preserves relationship_annotations', async () => {
    // Regression detector for the relationships-verify stage. Mirrors iter 4.5
    // for modules-verify. Phase 1 (deterministic) checks ghost rows, type
    // mismatches, stale files, and PENDING_LLM_ANNOTATION leaks — all empty
    // for the well-formed iter-3 state on todo-api. Phase 2 (LLM coherence
    // verifier) re-annotates only edges flagged "wrong"; for a clean DB
    // it should mark every edge correct and write nothing.
    //
    // Iter 3's GT works unchanged here — we already proved iter 3 → iter 4
    // is byte-equivalent in `relationship_annotations` for this fixture.
    // If a future squint change makes relationships-verify start moving
    // things around, this iteration will go red and force a triage decision.
    await runIterationStep({
      fixture: TODO_API,
      groundTruth: todoApiGroundTruth,
      label: 'relationships-verify',
      toStage: 'relationships-verify',
      scope: ['files', 'definitions', 'imports', 'definition_metadata', 'relationship_annotations'],
      judgeFn: makeLlmProseJudge({ cachePath: TODO_API.judgeCachePath }),
      timeoutMs: 300_000,
      costBudgetUsd: 0.2,
    });
  }, 420_000);

  it('iteration 4: modules stage produces expected module cohesion', async () => {
    // Uses the cohesion rubric (`module_cohesion` virtual table) instead of
    // strict `modules`/`module_members` exact matching. The rubric verifies
    // that semantically related definitions land in the same module and that
    // module's name+description matches a hand-authored expected role —
    // robust to LLM tree-shape variation.
    await runIterationStep({
      fixture: TODO_API,
      groundTruth: todoApiGroundTruth,
      label: 'modules',
      toStage: 'modules',
      scope: ['files', 'definitions', 'imports', 'definition_metadata', 'relationship_annotations', 'module_cohesion'],
      judgeFn: makeLlmProseJudge({ cachePath: TODO_API.judgeCachePath }),
      timeoutMs: 360_000,
      costBudgetUsd: 0.2,
    });
  }, 480_000);

  it('iteration 4.5: modules-verify stage preserves cohesion', async () => {
    // Regression detector for the modules-verify stage. Same cohesion rubric
    // as iter 4 — verifies the verify stage doesn't degrade member grouping
    // or move definitions out of their semantic clusters.
    //
    // Cost budget bumped to 0.30 as defense in depth: if Phase 2 ever fires
    // a reassignment, the cascade regenerates interactions+flows which is
    // expensive. The cost guardrail will trip loudly instead of silently.
    await runIterationStep({
      fixture: TODO_API,
      groundTruth: todoApiGroundTruth,
      label: 'modules-verify',
      toStage: 'modules-verify',
      scope: ['files', 'definitions', 'imports', 'definition_metadata', 'relationship_annotations', 'module_cohesion'],
      judgeFn: makeLlmProseJudge({ cachePath: TODO_API.judgeCachePath }),
      timeoutMs: 420_000,
      costBudgetUsd: 0.3,
    });
  }, 540_000);
});
