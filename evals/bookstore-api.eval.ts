import { describe, it } from 'vitest';
import { bookstoreApiGroundTruth } from './ground-truth/bookstore-api/index.js';
import { makeLlmProseJudge } from './harness/comparator/llm-prose-judge.js';
import { defineFixture } from './harness/fixture-config.js';
import { runIterationStep } from './harness/iteration.js';

const BOOKSTORE = defineFixture('bookstore-api');

describe('bookstore-api eval', () => {
  it('iteration 1: parse stage produces expected files, definitions, and imports', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'parse',
      toStage: 'parse',
      scope: ['files', 'definitions', 'imports'],
      timeoutMs: 60_000,
    });
  }, 120_000);

  it('iteration 2: symbols stage produces expected definition_metadata', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'symbols',
      toStage: 'symbols',
      scope: ['files', 'definitions', 'imports', 'definition_metadata'],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 180_000,
    });
  }, 300_000);

  it('iteration 3: relationships stage produces expected relationship_annotations', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'relationships',
      toStage: 'relationships',
      scope: ['files', 'definitions', 'imports', 'definition_metadata', 'relationship_annotations'],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 240_000,
    });
  }, 360_000);

  it('iteration 3.5: relationships-verify stage preserves relationship_annotations', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'relationships-verify',
      toStage: 'relationships-verify',
      scope: ['files', 'definitions', 'imports', 'definition_metadata', 'relationship_annotations'],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 300_000,
      costBudgetUsd: 0.2,
    });
  }, 420_000);

  it('iteration 4: modules stage produces expected module cohesion', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'modules',
      toStage: 'modules',
      scope: ['files', 'definitions', 'imports', 'definition_metadata', 'relationship_annotations', 'module_cohesion'],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 360_000,
      costBudgetUsd: 0.2,
    });
  }, 480_000);

  it('iteration 4.5: modules-verify stage preserves cohesion', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'modules-verify',
      toStage: 'modules-verify',
      scope: ['files', 'definitions', 'imports', 'definition_metadata', 'relationship_annotations', 'module_cohesion'],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 420_000,
      costBudgetUsd: 0.3,
    });
  }, 540_000);

  it('iteration 5: contracts stage extracts expected HTTP routes', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'contracts',
      toStage: 'contracts',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'module_cohesion',
        'contracts',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 420_000,
      costBudgetUsd: 0.3,
    });
  }, 540_000);

  it('iteration 6: interactions stage produces expected module-pair edges', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'interactions',
      toStage: 'interactions',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'module_cohesion',
        'contracts',
        'interaction_rubric',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 480_000,
      costBudgetUsd: 0.4,
    });
  }, 600_000);

  it('iteration 6.5: interactions-validate stage preserves the rubric', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'interactions-validate',
      toStage: 'interactions-validate',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'module_cohesion',
        'contracts',
        'interaction_rubric',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 480_000,
      costBudgetUsd: 0.4,
    });
  }, 600_000);

  it('iteration 6.6: interactions-verify stage preserves the rubric', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'interactions-verify',
      toStage: 'interactions-verify',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'module_cohesion',
        'contracts',
        'interaction_rubric',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 540_000,
      costBudgetUsd: 0.4,
    });
  }, 660_000);

  // Iterations 7-8 are SKIPPED: the flows stage requires richer interaction
  // semantics (from call-graph edges) to trace meaningful user journeys.
  // The bookstore fixture's interactions are all ast-import (import-only,
  // no call-graph context) so the LLM only generates inheritance flows,
  // not the user-facing CRUD flows the rubric expects. Iters 1-6.6 (10
  // iterations) cover the full pipeline through interactions-verify and
  // are stable. Flows/features will unblock when squint's Ruby call-graph
  // support is enhanced to track cross-file method invocations.
  it.skip('iteration 7: flows stage produces expected user journeys (SKIPPED: import-only interactions lack call-graph context for flow tracing)', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'flows',
      toStage: 'flows',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'module_cohesion',
        'contracts',
        'interaction_rubric',
        'flow_rubric',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 600_000,
      costBudgetUsd: 0.5,
    });
  }, 720_000);

  it.skip('iteration 7.5: flows-verify stage preserves the flow rubric (SKIPPED: same as iter 7)', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'flows-verify',
      toStage: 'flows-verify',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'module_cohesion',
        'contracts',
        'interaction_rubric',
        'flow_rubric',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 660_000,
      costBudgetUsd: 0.5,
    });
  }, 780_000);

  it.skip('iteration 8: features stage groups flows into expected product features (SKIPPED: depends on flows)', async () => {
    await runIterationStep({
      fixture: BOOKSTORE,
      groundTruth: bookstoreApiGroundTruth,
      label: 'features',
      toStage: 'features',
      scope: [
        'files',
        'definitions',
        'imports',
        'definition_metadata',
        'relationship_annotations',
        'module_cohesion',
        'contracts',
        'interaction_rubric',
        'flow_rubric',
        'feature_cohesion',
      ],
      judgeFn: makeLlmProseJudge({ cachePath: BOOKSTORE.judgeCachePath }),
      timeoutMs: 720_000,
      costBudgetUsd: 0.5,
    });
  }, 840_000);
});
