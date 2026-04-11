import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from '@oclif/core';
import { completeWithLogging } from '../../../src/commands/llm/_shared/llm-utils.js';
import type { ProseJudgeFn, ProseJudgeRequest, ProseJudgeResult } from '../types.js';

/**
 * LLM-backed prose-similarity judge for the eval harness.
 *
 * Wraps squint's existing `completeWithLogging()` infrastructure (retry,
 * cost reporting, llmist client management) and adds:
 * - A strict similarity-judging system prompt
 * - Disk-persistent cache keyed on (model, reference, candidate, prompt-version)
 * - Robust JSON extraction from the LLM response
 *
 * Returned function does NOT carry STUB_JUDGE_MARKER, so the
 * `assertNoStubJudgeForProseChecks` guardrail accepts it for prose-bearing
 * scopes.
 */

/**
 * Bumped whenever a system prompt changes. Forces a cache miss for old
 * (model, ref, cand) entries that were judged under the old instructions,
 * since the same inputs would semantically produce a different score now.
 *
 * Two distinct version namespaces: prose judging (strict, full sentences)
 * and theme judging (tolerant, prose-vs-tag-list). They live in the same
 * cache file but never collide because the version string is part of the
 * SHA-256 cache key.
 */
const PROSE_PROMPT_VERSION = 'v1';
const THEME_PROMPT_VERSION = 'theme-v2';

const PROSE_SYSTEM_PROMPT = `You are a strict semantic similarity judge for code documentation.

Compare a REFERENCE description (the ground-truth expected meaning) against a CANDIDATE description (what an LLM produced). Score how well the candidate captures the same meaning as the reference, on a scale of 0.0 to 1.0.

Scoring rubric:
- 1.0 = identical meaning, even if different words/phrasing
- 0.85-0.99 = same core meaning, minor missing nuance
- 0.7-0.84 = same general intent but missing one important concept
- 0.4-0.69 = related topic, missing key concepts
- 0.0-0.39 = different meaning or wrong topic

Be strict. Surface drift. Do not give credit for vague descriptions that could apply to many things. A description that says "handles requests" when the reference says "validates auth credentials and signs JWT" is missing key concepts — score around 0.5.

Output ONLY a JSON object with this exact shape, no other text:
{"similarity": <number 0..1>, "reasoning": "<one sentence>"}`;

const THEME_SYSTEM_PROMPT = `You judge whether a short LLM-produced label fits a target code-element concept.

The CANDIDATE is a short label produced by an LLM annotating some code element. It can be either:
- A tag list formatted as "tags: a, b, c"
- A name + brief description formatted as "name: brief description"
Both are short labels, not full-prose paraphrases of anything.

The REFERENCE is a one-sentence description of the target CONCEPT — what kind of code element the candidate is supposed to label. The reference is a CONCEPT, not a checklist of words the candidate must contain.

Score how reasonably the candidate fits the reference concept, on a scale of 0.0 to 1.0:
- 0.85-1.0 = the candidate clearly fits (any reasonable label for that kind of element)
- 0.6-0.84 = the candidate is reasonable, perhaps using broader or different vocabulary
- 0.3-0.59 = the candidate is tangentially related but doesn't clearly identify this kind of element
- 0.0-0.29 = the candidate is unrelated, off-topic, or actively misleading

Be tolerant of vocabulary choice. The annotating LLM has freedom to pick synonyms ("event-management" vs "events", "user-management" vs "auth", "task-management" vs "tasks"). Do NOT penalize the candidate for "missing concepts" or being "too generic" — short labels rarely paraphrase a full reference. Score above 0.7 unless the candidate is clearly off-topic for the reference's concept.

Output ONLY a JSON object with this exact shape, no other text:
{"similarity": <number 0..1>, "reasoning": "<one sentence>"}`;

const DEFAULT_MODEL = process.env.EVAL_JUDGE_MODEL ?? 'openrouter:google/gemini-2.5-flash';

/** Subset of completeWithLogging's options that the judge actually uses. */
export interface LlmCallOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  command: Command;
  isJson: boolean;
}

/** Pluggable LLM call signature — accepts the real `completeWithLogging` or a test stub. */
export type LlmCallFn = (opts: LlmCallOptions) => Promise<string>;

export interface MakeLlmProseJudgeOptions {
  /** Model to use. Default: process.env.EVAL_JUDGE_MODEL ?? 'openrouter:google/gemini-2.5-flash' */
  model?: string;
  /** Cache file path. Default: evals/results/.judge-cache.json */
  cachePath?: string;
  /** LLM call site override (for tests). Default: completeWithLogging from squint. */
  llmCall?: LlmCallFn;
}

interface CachedJudgment {
  similarity: number;
  reasoning: string;
  cachedAt: string;
}

type CacheFile = Record<string, CachedJudgment>;

/**
 * Build a prose judge backed by a real LLM.
 */
export function makeLlmProseJudge(opts: MakeLlmProseJudgeOptions = {}): ProseJudgeFn {
  const model = opts.model ?? DEFAULT_MODEL;
  const cachePath = opts.cachePath ?? defaultCachePath();
  const llmCall = opts.llmCall ?? (completeWithLogging as unknown as LlmCallFn);

  // Lazy cache load — first call reads from disk if it exists.
  let cache: CacheFile | null = null;

  function loadCache(): CacheFile {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      cache = JSON.parse(raw) as CacheFile;
    } catch {
      cache = {};
    }
    return cache;
  }

  function saveCache(): void {
    if (!cache) return;
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  }

  function cacheKey(version: string, reference: string, candidate: string): string {
    // Excludes minSimilarity by design — the same (model, ref, cand) always produces the
    // same similarity score; passed/failed is computed at request time.
    // The version string is mode-specific so prose and theme judgments cohabit
    // the same cache file without colliding.
    return createHash('sha256').update(`${version}\n${model}\n${reference}\n${candidate}`).digest('hex');
  }

  return async function llmProseJudge(req: ProseJudgeRequest): Promise<ProseJudgeResult> {
    const mode = req.mode ?? 'prose';
    const systemPrompt = mode === 'theme' ? THEME_SYSTEM_PROMPT : PROSE_SYSTEM_PROMPT;
    const version = mode === 'theme' ? THEME_PROMPT_VERSION : PROSE_PROMPT_VERSION;
    const c = loadCache();
    const key = cacheKey(version, req.reference, req.candidate);
    const hit = c[key];

    let similarity: number;
    let reasoning: string;

    if (hit) {
      similarity = hit.similarity;
      reasoning = hit.reasoning;
    } else {
      const userPrompt = `REFERENCE: ${req.reference}\nCANDIDATE: ${req.candidate}\n\nScore the similarity.`;
      const response = await llmCall({
        model,
        systemPrompt,
        userPrompt,
        temperature: 0,
        command: stubCommand(),
        isJson: true, // suppress completeWithLogging's colored before/after logs
      });
      const parsed = parseJudgeResponse(response, req.field);
      similarity = parsed.similarity;
      reasoning = parsed.reasoning;
      c[key] = { similarity, reasoning, cachedAt: new Date().toISOString() };
      saveCache();
    }

    return {
      similarity,
      passed: similarity >= req.minSimilarity,
      reasoning,
    };
  };
}

// ============================================================
// Helpers
// ============================================================

function defaultCachePath(): string {
  // evals/.judge-cache.json — sibling of `results/`, NOT inside it. Lives
  // outside the per-run rotation directory so the rotator can never touch it.
  // Gitignored via an explicit `.judge-cache.json` rule.
  return path.resolve(process.cwd(), 'evals/.judge-cache.json');
}

/** Minimal mock Command for completeWithLogging — only needs a `log` method. */
function stubCommand(): Command {
  return {
    log: () => undefined,
  } as unknown as Command;
}

interface ParsedJudgment {
  similarity: number;
  reasoning: string;
}

/**
 * Extract a JSON judgment object from the LLM response.
 *
 * Tolerates extra text around the JSON (some models prepend "Here is the result:" etc.).
 * Throws on:
 * - No parseable JSON object found
 * - Missing `similarity` field
 * - similarity outside [0, 1]
 */
export function parseJudgeResponse(response: string, fieldLabel: string): ParsedJudgment {
  // Find the first {...} block. Our judge response is always a flat object, so a
  // simple non-nested match suffices. We do NOT require the "similarity" key to
  // appear inside the brace pair — that's the parser's job to validate, not the
  // matcher's. This way a {"reasoning": "..."} without similarity still gets
  // parsed and surfaces a precise "missing similarity" error.
  const match = response.match(/\{[^{}]*\}/);
  if (!match) {
    throw new Error(`prose-judge: could not parse JSON from response for ${fieldLabel}: ${truncate(response, 200)}`);
  }
  let parsed: { similarity?: unknown; reasoning?: unknown };
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      `prose-judge: invalid JSON in response for ${fieldLabel}: ${truncate(match[0], 200)} (${(err as Error).message})`
    );
  }

  const sim = parsed.similarity;
  if (typeof sim !== 'number') {
    throw new Error(`prose-judge: missing or non-numeric 'similarity' in response for ${fieldLabel}`);
  }
  if (sim < 0 || sim > 1 || !Number.isFinite(sim)) {
    throw new Error(`prose-judge: similarity ${sim} out of range [0, 1] for ${fieldLabel}`);
  }

  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  return { similarity: sim, reasoning };
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}
