import type { MetadataAssertion, ProseJudgeFn } from '../../types.js';
import { parseJsonStringArray } from './shared.js';

/**
 * PR4: property-based metadata assertions.
 *
 * Replaces brittle prose-similarity grading with structural property checks
 * anchored on facts about the produced output. The Author.domain failure mode
 * — the LLM tags `class Author < ApplicationRecord` as `["database-models",
 * "user-management"]` no matter how the prompt is phrased — is the canonical
 * case: a single `tag-none-of: ['user', 'auth', 'identity']` assertion catches
 * it without requiring the GT author to guess the LLM's exact phrasing.
 *
 * Assertion kinds:
 *   - tag-* operate on parsed tag arrays (JSON or comma-separated)
 *   - string-* operate on raw prose values
 *   - concept-fit is a last-resort tolerant theme judge call
 *   - regex is an escape hatch for highly structured fields
 *
 * Substring matching is case-insensitive throughout. Tag concepts are
 * SUBSTRINGS, not exact matches: `'book'` matches `['book-catalog']` and
 * `'auth'` matches `['authentication']`. This is intentional — the GT
 * author writes concepts, not vocabulary.
 */

export interface AssertionEvalContext {
  /** For diff reporting: defKey + aspect being evaluated. */
  defKey: string;
  aspectKey: string;
  /** Pluggable LLM judge for concept-fit assertions. */
  judgeFn: ProseJudgeFn;
}

export interface AssertionEvalResult {
  passed: boolean;
  /** First assertion that failed (if any). */
  failedAssertion?: MetadataAssertion;
  /** Human-readable explanation of why it failed. */
  reason?: string;
  /**
   * True iff the failure was a `concept-fit` assertion (the only kind that
   * triggers the prose judge). The comparator uses this to decide whether
   * the failure should be reported as `kind: 'prose-drift'` (counted in
   * proseChecks.failed) vs `kind: 'mismatch'` (counted in structural
   * severity).
   */
  proseDrift: boolean;
}

/**
 * Evaluate an ordered list of assertions against a produced metadata value.
 * Stops at the first failure and returns it. An empty list passes vacuously.
 */
export async function evaluateAssertions(
  assertions: MetadataAssertion[],
  producedValue: string,
  ctx: AssertionEvalContext
): Promise<AssertionEvalResult> {
  const tags = parseTagsLenient(producedValue);
  for (const assertion of assertions) {
    const result = await evaluateOne(assertion, producedValue, tags, ctx);
    if (!result.passed) return result;
  }
  return { passed: true, proseDrift: false };
}

async function evaluateOne(
  assertion: MetadataAssertion,
  producedValue: string,
  tags: string[],
  ctx: AssertionEvalContext
): Promise<AssertionEvalResult> {
  switch (assertion.kind) {
    case 'tag-any-of': {
      const found = assertion.anyOf.find((needle) => tags.some((t) => containsCi(t, needle)));
      if (found) return ok();
      return fail(assertion, `none of [${assertion.anyOf.join(', ')}] appears in produced tags [${tags.join(', ')}]`);
    }

    case 'tag-none-of': {
      for (const banned of assertion.noneOf) {
        const offending = tags.find((t) => containsCi(t, banned));
        if (offending !== undefined) {
          return fail(assertion, `banned concept '${banned}' appears in produced tag '${offending}'`);
        }
      }
      return ok();
    }

    case 'tag-floor': {
      if (tags.length >= assertion.min) return ok();
      return fail(assertion, `produced ${tags.length} tag(s), need at least ${assertion.min}`);
    }

    case 'string-contains': {
      if (assertion.substrings && assertion.substrings.length > 0) {
        const missing = assertion.substrings.find((s) => !containsCi(producedValue, s));
        if (missing !== undefined) {
          return fail(assertion, `missing required substring '${missing}' in produced value`);
        }
      }
      if (assertion.anyOf && assertion.anyOf.length > 0) {
        const found = assertion.anyOf.find((s) => containsCi(producedValue, s));
        if (!found) {
          return fail(assertion, `none of [${assertion.anyOf.join(', ')}] appears in produced value`);
        }
      }
      return ok();
    }

    case 'string-forbid': {
      const offending = assertion.substrings.find((s) => containsCi(producedValue, s));
      if (offending !== undefined) {
        return fail(assertion, `forbidden substring '${offending}' appears in produced value`);
      }
      return ok();
    }

    case 'concept-fit': {
      const minSim = assertion.minSimilarity ?? 0.6;
      const judgment = await ctx.judgeFn({
        field: `${ctx.defKey}.${ctx.aspectKey} concept-fit`,
        reference: assertion.mustReflect,
        candidate: producedValue,
        minSimilarity: minSim,
        mode: 'theme',
      });
      if (judgment.passed) return ok();
      return {
        passed: false,
        failedAssertion: assertion,
        reason: `concept-fit similarity ${judgment.similarity.toFixed(2)} < ${minSim} — ${judgment.reasoning}`,
        proseDrift: true,
      };
    }

    case 'regex': {
      const re = new RegExp(assertion.pattern, assertion.flags);
      if (re.test(producedValue)) return ok();
      return fail(assertion, `pattern /${assertion.pattern}/${assertion.flags ?? ''} did not match`);
    }
  }
}

function ok(): AssertionEvalResult {
  return { passed: true, proseDrift: false };
}

function fail(assertion: MetadataAssertion, reason: string): AssertionEvalResult {
  return { passed: false, failedAssertion: assertion, reason, proseDrift: false };
}

function containsCi(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Parse a metadata value as a tag array, accepting either JSON or
 * comma-separated input. Returns an empty array on parse failure or null
 * input. Used by tag-* assertions to be tolerant of how the LLM happens
 * to format its output.
 */
function parseTagsLenient(value: string): string[] {
  if (!value) return [];
  const json = parseJsonStringArray(value);
  if (json !== null) return json;
  // Fall back to comma-split, trimming whitespace.
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
