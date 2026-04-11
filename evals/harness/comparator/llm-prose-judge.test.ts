import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUB_JUDGE_MARKER } from '../types.js';
import { makeLlmProseJudge } from './llm-prose-judge.js';

/**
 * Tests for the LLM-backed prose judge.
 *
 * Strategy: pass an injected llmCall stub instead of mocking llmist at the
 * module level. This is simpler than vi.mock and lets us assert exact
 * call counts without race conditions across test files.
 */
describe('makeLlmProseJudge', () => {
  let cacheDir: string;
  let cachePath: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-judge-cache-'));
    cachePath = path.join(cacheDir, 'judge-cache.json');
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function fakeLlmCall(responses: string[]): {
    fn: (opts: { systemPrompt: string; userPrompt: string }) => Promise<string>;
    callCount: () => number;
    lastUserPrompt: () => string | undefined;
  } {
    let i = 0;
    let lastUserPrompt: string | undefined;
    const fn = vi.fn(async (opts: { systemPrompt: string; userPrompt: string }) => {
      lastUserPrompt = opts.userPrompt;
      if (i >= responses.length) throw new Error(`fake llm call ${i + 1} has no canned response`);
      return responses[i++];
    });
    return {
      fn: fn as unknown as (opts: { systemPrompt: string; userPrompt: string }) => Promise<string>,
      callCount: () => fn.mock.calls.length,
      lastUserPrompt: () => lastUserPrompt,
    };
  }

  it('returns the LLM similarity score on the happy path', async () => {
    const llm = fakeLlmCall(['{"similarity": 0.92, "reasoning": "very close"}']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    const result = await judge({
      field: 'definition_metadata.purpose for src/foo.ts::bar',
      reference: 'Authenticate a user.',
      candidate: 'Verifies user credentials and signs a token.',
      minSimilarity: 0.75,
    });

    expect(result.similarity).toBeCloseTo(0.92, 5);
    expect(result.passed).toBe(true);
    expect(result.reasoning).toBe('very close');
    expect(llm.callCount()).toBe(1);
  });

  it('marks passed=false when similarity is below the threshold', async () => {
    const llm = fakeLlmCall(['{"similarity": 0.5, "reasoning": "missing key concept"}']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    const result = await judge({
      field: 'test',
      reference: 'A',
      candidate: 'B',
      minSimilarity: 0.75,
    });

    expect(result.similarity).toBe(0.5);
    expect(result.passed).toBe(false);
  });

  it('caches successful judgments — second call with same args makes no LLM call', async () => {
    const llm = fakeLlmCall(['{"similarity": 0.85, "reasoning": "fine"}']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    const req = { field: 't', reference: 'ref', candidate: 'cand', minSimilarity: 0.7 };
    await judge(req);
    await judge(req);

    expect(llm.callCount()).toBe(1);
  });

  it('cache key does not include minSimilarity — same (model,ref,cand) reuses across thresholds', async () => {
    const llm = fakeLlmCall(['{"similarity": 0.8, "reasoning": "ok"}']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    const r1 = await judge({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.7 });
    const r2 = await judge({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.85 });

    expect(llm.callCount()).toBe(1); // single LLM call
    expect(r1.passed).toBe(true); // 0.8 >= 0.7
    expect(r2.passed).toBe(false); // 0.8 < 0.85
    expect(r1.similarity).toBe(r2.similarity);
  });

  it('persists cache to disk and reads it back from a fresh judge instance', async () => {
    const llm1 = fakeLlmCall(['{"similarity": 0.9, "reasoning": "match"}']);
    const judge1 = makeLlmProseJudge({ cachePath, llmCall: llm1.fn });
    await judge1({ field: 't', reference: 'X', candidate: 'Y', minSimilarity: 0.75 });
    expect(fs.existsSync(cachePath)).toBe(true);

    // Fresh instance should pick up the persisted cache and not call LLM again
    const llm2 = fakeLlmCall([]); // no canned responses — must not be called
    const judge2 = makeLlmProseJudge({ cachePath, llmCall: llm2.fn });
    const result = await judge2({ field: 't', reference: 'X', candidate: 'Y', minSimilarity: 0.75 });

    expect(result.similarity).toBe(0.9);
    expect(llm2.callCount()).toBe(0);
  });

  it('different reference text causes a cache miss', async () => {
    const llm = fakeLlmCall([
      '{"similarity": 0.9, "reasoning": "first"}',
      '{"similarity": 0.5, "reasoning": "second"}',
    ]);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    await judge({ field: 't', reference: 'A', candidate: 'X', minSimilarity: 0.7 });
    await judge({ field: 't', reference: 'B', candidate: 'X', minSimilarity: 0.7 });

    expect(llm.callCount()).toBe(2);
  });

  it('different candidate text causes a cache miss', async () => {
    const llm = fakeLlmCall([
      '{"similarity": 0.9, "reasoning": "first"}',
      '{"similarity": 0.5, "reasoning": "second"}',
    ]);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    await judge({ field: 't', reference: 'A', candidate: 'X', minSimilarity: 0.7 });
    await judge({ field: 't', reference: 'A', candidate: 'Y', minSimilarity: 0.7 });

    expect(llm.callCount()).toBe(2);
  });

  it('throws on malformed LLM response (no JSON)', async () => {
    const llm = fakeLlmCall(['not json at all']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    await expect(judge({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.7 })).rejects.toThrow(
      /parse|json/i
    );
  });

  it('throws on JSON missing similarity field', async () => {
    const llm = fakeLlmCall(['{"reasoning": "ok but no number"}']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    await expect(judge({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.7 })).rejects.toThrow(
      /similarity/i
    );
  });

  it('throws on similarity outside [0, 1]', async () => {
    const llm = fakeLlmCall(['{"similarity": 1.5, "reasoning": "out of range"}']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    await expect(judge({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.7 })).rejects.toThrow(
      /similarity|range/i
    );
  });

  it('extracts JSON from response wrapped in extra text', async () => {
    // Some models prepend "Here is the JSON:" or similar before the actual object
    const llm = fakeLlmCall(['Here is the result: {"similarity": 0.88, "reasoning": "fine"} done.']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });

    const result = await judge({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.7 });
    expect(result.similarity).toBeCloseTo(0.88, 5);
  });

  it('returned function does NOT carry STUB_JUDGE_MARKER (so the guardrail accepts it)', () => {
    const judge = makeLlmProseJudge({ cachePath, llmCall: fakeLlmCall([]).fn });
    expect((judge as unknown as { [k: symbol]: unknown })[STUB_JUDGE_MARKER]).toBeUndefined();
  });

  it('different judge model results in cache miss for same ref+cand', async () => {
    const llm1 = fakeLlmCall(['{"similarity": 0.9, "reasoning": "model A"}']);
    const judge1 = makeLlmProseJudge({ cachePath, model: 'model-a', llmCall: llm1.fn });
    await judge1({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.7 });

    const llm2 = fakeLlmCall(['{"similarity": 0.6, "reasoning": "model B"}']);
    const judge2 = makeLlmProseJudge({ cachePath, model: 'model-b', llmCall: llm2.fn });
    const r2 = await judge2({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.7 });

    expect(r2.similarity).toBe(0.6);
    expect(llm2.callCount()).toBe(1);
  });

  it('handles a missing cache file gracefully on first run', async () => {
    const nonexistent = path.join(cacheDir, 'subdir', 'never-existed.json');
    const llm = fakeLlmCall(['{"similarity": 0.8, "reasoning": "ok"}']);
    const judge = makeLlmProseJudge({ cachePath: nonexistent, llmCall: llm.fn });
    const result = await judge({ field: 't', reference: 'A', candidate: 'B', minSimilarity: 0.7 });
    expect(result.similarity).toBe(0.8);
    expect(fs.existsSync(nonexistent)).toBe(true); // cache file created
  });

  it('user prompt contains both reference and candidate', async () => {
    const llm = fakeLlmCall(['{"similarity": 0.8, "reasoning": "ok"}']);
    const judge = makeLlmProseJudge({ cachePath, llmCall: llm.fn });
    await judge({
      field: 't',
      reference: 'AUTHENTICATE_REFERENCE',
      candidate: 'CANDIDATE_DESC',
      minSimilarity: 0.7,
    });
    const prompt = llm.lastUserPrompt() ?? '';
    expect(prompt).toContain('AUTHENTICATE_REFERENCE');
    expect(prompt).toContain('CANDIDATE_DESC');
  });
});
