import { describe, expect, it, vi } from 'vitest';
import type { MetadataAssertion, ProseJudgeFn } from '../../types.js';
import { evaluateAssertions } from './metadata-assertions.js';

/**
 * `evaluateAssertions` is the heart of PR4: instead of asking the LLM judge
 * "does this paraphrase your hand-authored sentence", it asks structural
 * property questions about the produced output. Tests below cover one per
 * assertion kind plus integration cases.
 *
 * The judge function is mocked except where `concept-fit` explicitly needs
 * to call it. None of the structural assertion kinds (tag-*, string-*, regex)
 * should ever invoke the judge.
 */
function noopJudge(): ProseJudgeFn {
  return vi.fn(async () => ({
    similarity: 0.0,
    passed: false,
    reasoning: 'noop judge invoked unexpectedly',
  }));
}

const ctx = (judgeFn: ProseJudgeFn = noopJudge()) => ({
  defKey: 'app/models/author.rb::Author',
  aspectKey: 'domain',
  judgeFn,
});

describe('evaluateAssertions', () => {
  // ──────────────────────────────────────────────────────────────────────
  // tag-any-of
  // ──────────────────────────────────────────────────────────────────────
  describe('tag-any-of', () => {
    it('passes when one of the concepts appears as a substring', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'tag-any-of', label: 'about books', anyOf: ['book', 'catalog'] },
      ];
      const result = await evaluateAssertions(assertions, '["book-catalog","persistence"]', ctx());
      expect(result.passed).toBe(true);
      expect(result.failedAssertion).toBeUndefined();
    });

    it('matches case-insensitively', async () => {
      const assertions: MetadataAssertion[] = [{ kind: 'tag-any-of', label: 'auth', anyOf: ['AUTH'] }];
      const result = await evaluateAssertions(assertions, '["authentication"]', ctx());
      expect(result.passed).toBe(true);
    });

    it('fails when no concept appears in any tag', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'tag-any-of', label: 'about books', anyOf: ['book', 'catalog'] },
      ];
      const result = await evaluateAssertions(assertions, '["user-management","data-access"]', ctx());
      expect(result.passed).toBe(false);
      expect(result.failedAssertion?.label).toBe('about books');
    });

    it('accepts comma-separated tag input (not just JSON)', async () => {
      const assertions: MetadataAssertion[] = [{ kind: 'tag-any-of', label: 'about books', anyOf: ['book'] }];
      const result = await evaluateAssertions(assertions, 'book-catalog, persistence', ctx());
      expect(result.passed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // tag-none-of
  // ──────────────────────────────────────────────────────────────────────
  describe('tag-none-of', () => {
    it('fails when any banned concept appears as substring', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'tag-none-of', label: 'not user-related', noneOf: ['user', 'auth'] },
      ];
      const result = await evaluateAssertions(assertions, '["database-models","user-management"]', ctx());
      expect(result.passed).toBe(false);
      expect(result.failedAssertion?.label).toBe('not user-related');
      expect(result.reason).toMatch(/user/);
    });

    it('passes when no banned concept appears', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'tag-none-of', label: 'not user-related', noneOf: ['user', 'auth'] },
      ];
      const result = await evaluateAssertions(assertions, '["catalog","books","inventory"]', ctx());
      expect(result.passed).toBe(true);
    });

    it('catches the Author→user-management bug', async () => {
      // The exact failure mode that motivated PR4.
      const assertions: MetadataAssertion[] = [
        { kind: 'tag-floor', label: 'has tags', min: 1 },
        { kind: 'tag-any-of', label: 'about books or catalog', anyOf: ['book', 'catalog', 'author'] },
        { kind: 'tag-none-of', label: 'not user/identity', noneOf: ['user', 'auth', 'identity'] },
      ];
      // The actual LLM output we observed:
      const result = await evaluateAssertions(assertions, '["database-models","user-management"]', ctx());
      expect(result.passed).toBe(false);
      // Should fail on the second assertion (about books) because no book/catalog/author tag,
      // OR on the third (not user/identity) because user-management contains "user".
      // Either is correct. The point is: it FAILS, where the prose judge passed it.
      expect(result.failedAssertion).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // tag-floor
  // ──────────────────────────────────────────────────────────────────────
  describe('tag-floor', () => {
    it('passes when tag count meets the minimum', async () => {
      const assertions: MetadataAssertion[] = [{ kind: 'tag-floor', label: 'has 2 tags', min: 2 }];
      const result = await evaluateAssertions(assertions, '["a","b"]', ctx());
      expect(result.passed).toBe(true);
    });

    it('fails when fewer tags than the minimum', async () => {
      const assertions: MetadataAssertion[] = [{ kind: 'tag-floor', label: 'has 2 tags', min: 2 }];
      const result = await evaluateAssertions(assertions, '["only-one"]', ctx());
      expect(result.passed).toBe(false);
      expect(result.failedAssertion?.label).toBe('has 2 tags');
    });

    it('fails on empty array when min: 1', async () => {
      const assertions: MetadataAssertion[] = [{ kind: 'tag-floor', label: 'non-empty', min: 1 }];
      const result = await evaluateAssertions(assertions, '[]', ctx());
      expect(result.passed).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // string-contains
  // ──────────────────────────────────────────────────────────────────────
  describe('string-contains', () => {
    it('with `substrings` requires ALL to appear', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'string-contains', label: 'has all', substrings: ['model', 'book', 'author'] },
      ];
      const ok = await evaluateAssertions(assertions, 'ActiveRecord model for book authors with metadata', ctx());
      expect(ok.passed).toBe(true);

      // Missing the 'author' substring entirely.
      const fail = await evaluateAssertions(assertions, 'ActiveRecord model for book entries', ctx());
      expect(fail.passed).toBe(false);
      expect(fail.failedAssertion?.label).toBe('has all');
    });

    it('with `anyOf` requires AT LEAST ONE to appear', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'string-contains', label: 'mentions inventory or stock', anyOf: ['inventory', 'stock'] },
      ];
      const ok = await evaluateAssertions(assertions, 'A model with stock tracking', ctx());
      expect(ok.passed).toBe(true);

      const fail = await evaluateAssertions(assertions, 'A model with title and ISBN', ctx());
      expect(fail.passed).toBe(false);
    });

    it('matches case-insensitively', async () => {
      const assertions: MetadataAssertion[] = [{ kind: 'string-contains', label: 'cs', substrings: ['BOOK'] }];
      const result = await evaluateAssertions(assertions, 'a book record', ctx());
      expect(result.passed).toBe(true);
    });

    /**
     * Substring trap (documented in `assertion-builders.ts`).
     *
     * The matcher does plain case-insensitive substring containment, NOT
     * word-form-aware matching. Verb stems with a trailing 'e' break against
     * gerunds because the 'e' diverges from the 'i' (`creat[e]` vs `creat[i]ng`).
     *
     * If you change this contract, GT files using verb stems like
     * `'creat'`/`'updat'`/`'delet'` may need updating. Keep this test as a
     * tripwire so the change is intentional.
     */
    it('SUBSTRING TRAP — verb stems with trailing `e` do NOT match gerunds', async () => {
      const verbAssertions: MetadataAssertion[] = [
        { kind: 'string-contains', label: 'verbs', anyOf: ['create', 'update', 'delete'] },
      ];
      const gerundOnlyText =
        'Manages business logic for task operations including creating, updating, and deleting tasks';
      const failed = await evaluateAssertions(verbAssertions, gerundOnlyText, ctx());
      expect(failed.passed).toBe(false);

      // Stem-form needles work because 'creating' DOES contain 'creat'.
      const stemAssertions: MetadataAssertion[] = [
        { kind: 'string-contains', label: 'stems', anyOf: ['creat', 'updat', 'delet'] },
      ];
      const passed = await evaluateAssertions(stemAssertions, gerundOnlyText, ctx());
      expect(passed.passed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // string-forbid
  // ──────────────────────────────────────────────────────────────────────
  describe('string-forbid', () => {
    it('fails when any forbidden substring appears', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'string-forbid', label: 'no auth', substrings: ['authentication', 'password'] },
      ];
      const result = await evaluateAssertions(assertions, 'A model that handles user authentication', ctx());
      expect(result.passed).toBe(false);
      expect(result.failedAssertion?.label).toBe('no auth');
    });

    it('passes when no forbidden substring appears', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'string-forbid', label: 'no auth', substrings: ['authentication', 'password'] },
      ];
      const result = await evaluateAssertions(assertions, 'A model for book metadata', ctx());
      expect(result.passed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // concept-fit (last-resort theme judging)
  // ──────────────────────────────────────────────────────────────────────
  describe('concept-fit', () => {
    it('calls the prose judge in theme mode at the configured threshold', async () => {
      const judge = vi.fn(async () => ({ similarity: 0.85, passed: true, reasoning: 'fits' }));
      const assertions: MetadataAssertion[] = [
        { kind: 'concept-fit', label: 'narrow', mustReflect: 'a catalog entry' },
      ];
      const result = await evaluateAssertions(assertions, '["catalog","books"]', ctx(judge));
      expect(result.passed).toBe(true);
      expect(judge).toHaveBeenCalledTimes(1);
      const callArgs = judge.mock.calls[0][0];
      expect(callArgs.mode).toBe('theme');
      expect(callArgs.reference).toBe('a catalog entry');
      expect(callArgs.minSimilarity).toBe(0.6); // default
    });

    it('honors a custom minSimilarity', async () => {
      const judge = vi.fn(async () => ({ similarity: 0.7, passed: true, reasoning: 'fits' }));
      const assertions: MetadataAssertion[] = [
        { kind: 'concept-fit', label: 'narrow', mustReflect: 'X', minSimilarity: 0.8 },
      ];
      await evaluateAssertions(assertions, 'foo', ctx(judge));
      expect(judge.mock.calls[0][0].minSimilarity).toBe(0.8);
    });

    it('reports prose-drift when the judge fails', async () => {
      const judge = vi.fn(async () => ({ similarity: 0.3, passed: false, reasoning: 'too narrow' }));
      const assertions: MetadataAssertion[] = [{ kind: 'concept-fit', label: 'fit', mustReflect: 'X' }];
      const result = await evaluateAssertions(assertions, 'foo', ctx(judge));
      expect(result.passed).toBe(false);
      expect(result.proseDrift).toBe(true);
      expect(result.reason).toMatch(/too narrow/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // regex
  // ──────────────────────────────────────────────────────────────────────
  describe('regex', () => {
    it('passes when the pattern matches', async () => {
      const assertions: MetadataAssertion[] = [{ kind: 'regex', label: 'is true/false', pattern: '^(true|false)$' }];
      const ok = await evaluateAssertions(assertions, 'true', ctx());
      expect(ok.passed).toBe(true);

      const fail = await evaluateAssertions(assertions, 'maybe', ctx());
      expect(fail.passed).toBe(false);
    });

    it('honors flags (case-insensitive)', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'regex', label: 'TRUE/FALSE', pattern: '^(true|false)$', flags: 'i' },
      ];
      const result = await evaluateAssertions(assertions, 'TRUE', ctx());
      expect(result.passed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Composition / short-circuit
  // ──────────────────────────────────────────────────────────────────────
  describe('composition', () => {
    it('short-circuits on the first failure', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'tag-floor', label: 'first', min: 5 }, // fails
        { kind: 'tag-any-of', label: 'second-never-runs', anyOf: ['x'] }, // would fail too
      ];
      const result = await evaluateAssertions(assertions, '["a","b"]', ctx());
      expect(result.passed).toBe(false);
      expect(result.failedAssertion?.label).toBe('first');
    });

    it('passes when all assertions pass', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'tag-floor', label: 'has tags', min: 1 },
        { kind: 'tag-any-of', label: 'about books', anyOf: ['book'] },
        { kind: 'tag-none-of', label: 'not user', noneOf: ['user'] },
      ];
      const result = await evaluateAssertions(assertions, '["book-catalog","inventory"]', ctx());
      expect(result.passed).toBe(true);
    });

    it('an empty assertions list passes vacuously', async () => {
      const result = await evaluateAssertions([], 'whatever', ctx());
      expect(result.passed).toBe(true);
    });

    it('propagates the failed assertion `severity` field', async () => {
      const assertions: MetadataAssertion[] = [
        { kind: 'tag-any-of', label: 'critical fact', severity: 'major', anyOf: ['expected'] },
      ];
      const result = await evaluateAssertions(assertions, '["other"]', ctx());
      expect(result.passed).toBe(false);
      expect(result.failedAssertion?.severity).toBe('major');
    });
  });
});
