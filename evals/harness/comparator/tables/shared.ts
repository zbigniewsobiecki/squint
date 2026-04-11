/**
 * Shared helpers used by multiple per-table comparators.
 *
 * Kept tiny on purpose — anything specific to a single table belongs in that
 * table's file.
 */

/** Definition `line` field tolerance: ground truth declares approximate lines. */
export const LINE_TOLERANCE = 2;

/** Default minimum LLM-judged similarity score for a `proseReference` to pass. */
export const DEFAULT_PROSE_MIN_SIMILARITY = 0.75;

/**
 * Parse a SQLite TEXT column that holds a JSON array of strings.
 * Returns null on missing column or malformed JSON. Used for `domain`,
 * `implementsNames`, `extendsInterfaces`, and `interactions.symbols`.
 */
export function parseJsonStringArray(value: string | null): string[] | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Order-independent string-array equality. Used by definition comparators
 * to compare implementsNames / extendsInterfaces sets.
 */
export function arraysEqualSorted(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
