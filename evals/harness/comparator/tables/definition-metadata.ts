import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type {
  GroundTruth,
  GroundTruthDefinitionMetadata,
  MetadataAssertion,
  ProseJudgeFn,
  RowDiff,
  TableDiff,
} from '../../types.js';
import { tableDiffPassed } from '../severity.js';
import { evaluateAssertions } from './metadata-assertions.js';
import { DEFAULT_PROSE_MIN_SIMILARITY, parseJsonStringArray } from './shared.js';

interface ProducedMetadataRow {
  defKey: string; // file::name
  key: string;
  value: string;
}

/**
 * Compare the `definition_metadata` table. Async because prose-bearing entries
 * call the LLM judge.
 *
 * Comparison policy per entry — chosen by which field of GroundTruthDefinitionMetadata is set:
 *   - exactValue   → byte-for-byte string match. Mismatch = MAJOR.
 *   - acceptableSet → JSON parse + non-empty subset check. Outliers = MINOR (vocabulary drift).
 *   - proseReference → judgeFn(reference, candidate). Below threshold = MINOR prose-drift.
 *
 * Missing definition (def itself absent in produced) = CRITICAL.
 * Missing aspect (def exists, aspect not annotated) = MAJOR.
 */
export async function compareDefinitionMetadata(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();
  const rows = conn
    .prepare(
      `SELECT (f.path || '::' || d.name) AS defKey, dm.key AS key, dm.value AS value
       FROM definition_metadata dm
       JOIN definitions d ON dm.definition_id = d.id
       JOIN files f ON d.file_id = f.id`
    )
    .all() as ProducedMetadataRow[];

  // Map: defKey -> Map<aspectKey, value>
  const producedByDef = new Map<string, Map<string, string>>();
  for (const r of rows) {
    let aspectMap = producedByDef.get(r.defKey);
    if (!aspectMap) {
      aspectMap = new Map();
      producedByDef.set(r.defKey, aspectMap);
    }
    aspectMap.set(r.key, r.value);
  }

  // Set of all defKeys present in produced (for the "def missing" check)
  const producedDefKeys = new Set<string>(
    (
      conn
        .prepare("SELECT (f.path || '::' || d.name) AS defKey FROM definitions d JOIN files f ON d.file_id = f.id")
        .all() as Array<{ defKey: string }>
    ).map((r) => r.defKey)
  );

  const expected = gt.definitionMetadata ?? [];
  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const entry of expected) {
    const defKey = entry.defKey as unknown as string;

    // Critical: GT references a definition that doesn't exist in produced
    if (!producedDefKeys.has(defKey)) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: `${defKey}.${entry.key}`,
        details: `Ground truth references unknown definition '${defKey}' for metadata key '${entry.key}'`,
      });
      continue;
    }

    const aspectMap = producedByDef.get(defKey);
    const actualValue = aspectMap?.get(entry.key);

    // Major: definition exists but the LLM did not annotate this aspect
    if (actualValue === undefined) {
      diffs.push({
        kind: 'missing',
        severity: 'major',
        naturalKey: `${defKey}.${entry.key}`,
        details: `Definition '${defKey}' exists but aspect '${entry.key}' is not annotated`,
      });
      continue;
    }

    // PR4: assertions branch — property-based grading. Routed first when
    // present so the new shape takes precedence over the legacy strategies
    // (`exactValue` still wins because it's the only deterministic one).
    if (entry.exactValue === undefined && entry.assertions && entry.assertions.length > 0) {
      const assertionResult = await evaluateAssertions(entry.assertions, actualValue, {
        defKey,
        aspectKey: entry.key,
        judgeFn,
      });
      if (assertionResult.passed) {
        proseChecksPassed += 1;
      } else {
        const failed = assertionResult.failedAssertion;
        const sev = failed?.severity ?? 'minor';
        if (assertionResult.proseDrift) {
          // concept-fit failures land in the prose-drift bucket so they
          // don't double-count into the structural minor counter.
          proseChecksFailed += 1;
          diffs.push({
            kind: 'prose-drift',
            severity: 'minor',
            naturalKey: `${defKey}.${entry.key}`,
            details: `assertion '${failed?.label ?? '?'}': ${assertionResult.reason ?? 'failed'}`,
          });
        } else {
          // Structural assertion failure — counts toward proseChecks.failed
          // (so the baseline ratchet sees it) but is reported as a structural
          // mismatch with the assertion's chosen severity.
          proseChecksFailed += 1;
          diffs.push({
            kind: 'mismatch',
            severity: sev,
            naturalKey: `${defKey}.${entry.key}`,
            details: `assertion '${failed?.label ?? '?'}': ${assertionResult.reason ?? 'failed'}`,
          });
        }
      }
      continue;
    }

    // Apply the right strategy based on which GT field is set
    const result = compareSingleMetadataEntry(entry, actualValue);
    if (result.kind === 'exact-mismatch') {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: `${defKey}.${entry.key}`,
        details: `${entry.key}: expected '${result.expected}', produced '${result.actual}'`,
      });
    } else if (result.kind === 'set-mismatch') {
      diffs.push({
        kind: 'mismatch',
        severity: 'minor',
        naturalKey: `${defKey}.${entry.key}`,
        details: `${entry.key}: expected set [${result.expected.join(', ')}], produced [${result.actual.join(', ')}]`,
      });
    } else if (result.kind === 'tags-floor-fail') {
      diffs.push({
        kind: 'mismatch',
        severity: 'minor',
        naturalKey: `${defKey}.${entry.key}`,
        details: `${entry.key}: produced ${result.actualLength} tag(s), but minTagsRequired=${result.required}`,
      });
    } else if (result.kind === 'tags-parse-fail') {
      diffs.push({
        kind: 'mismatch',
        severity: 'minor',
        naturalKey: `${defKey}.${entry.key}`,
        details: `${entry.key}: themeReference set but produced value is not a JSON string array (got ${truncate(actualValue, 60)})`,
      });
    } else if (result.kind === 'prose' || result.kind === 'theme') {
      // Async judge call. Theme strategy uses a tolerant tag-list judging
      // prompt; prose strategy uses the strict similarity prompt.
      const defaultMinSim = result.kind === 'theme' ? DEFAULT_THEME_MIN_SIMILARITY : DEFAULT_PROSE_MIN_SIMILARITY;
      const minSim = entry.minSimilarity ?? defaultMinSim;
      const judgment = await judgeFn({
        field: `definition_metadata.${entry.key} for ${defKey}`,
        reference: result.reference,
        candidate: result.candidate,
        minSimilarity: minSim,
        mode: result.kind === 'theme' ? 'theme' : 'prose',
      });
      if (judgment.passed) {
        proseChecksPassed += 1;
      } else {
        proseChecksFailed += 1;
        diffs.push({
          kind: 'prose-drift',
          severity: 'minor',
          naturalKey: `${defKey}.${entry.key}`,
          details: `prose drift: similarity ${judgment.similarity.toFixed(2)} < ${minSim} — ${judgment.reasoning}`,
        });
      }
    }
    // 'exact-match' and 'set-match' produce no diff
  }

  return {
    table: 'definition_metadata',
    passed: tableDiffPassed(diffs),
    expectedCount: expected.length,
    producedCount: rows.length,
    diffs,
    proseChecks: { passed: proseChecksPassed, failed: proseChecksFailed },
  };
}

/**
 * Default minimum similarity for `themeReference` tag-array judging.
 * Lower than the prose default (0.75) because the candidate is a short
 * comma-separated tag list rather than a full sentence — the judge has
 * less surface area to score against.
 */
const DEFAULT_THEME_MIN_SIMILARITY = 0.6;

type SingleEntryResult =
  | { kind: 'exact-match' }
  | { kind: 'exact-mismatch'; expected: string; actual: string }
  | { kind: 'set-match' }
  | { kind: 'set-mismatch'; expected: string[]; actual: string[] }
  | { kind: 'prose'; reference: string; candidate: string }
  | { kind: 'theme'; reference: string; candidate: string }
  | { kind: 'tags-floor-fail'; actualLength: number; required: number }
  | { kind: 'tags-parse-fail' };

/**
 * Apply the right comparison strategy for a single GT metadata entry.
 * Pure synchronous function — the async judge call happens in the caller.
 *
 * Strategy precedence (first match wins): exactValue → acceptableSet →
 * themeReference → proseReference. The GT type encourages exactly one to be
 * set, but defining a precedence keeps the function total.
 */
function compareSingleMetadataEntry(entry: GroundTruthDefinitionMetadata, actualValue: string): SingleEntryResult {
  if (entry.exactValue !== undefined) {
    return entry.exactValue === actualValue
      ? { kind: 'exact-match' }
      : { kind: 'exact-mismatch', expected: entry.exactValue, actual: actualValue };
  }
  if (entry.acceptableSet !== undefined) {
    const actualSet = parseJsonStringArray(actualValue) ?? [];
    // Subset check: actualSet must be (a) non-empty AND (b) a subset of acceptableSet.
    // Outliers in actualSet (tags not in the vocabulary) trigger a mismatch.
    if (actualSet.length === 0) {
      return { kind: 'set-mismatch', expected: [...entry.acceptableSet].sort(), actual: [] };
    }
    const acceptableHash = new Set(entry.acceptableSet);
    const outliers = actualSet.filter((t) => !acceptableHash.has(t));
    if (outliers.length === 0) {
      return { kind: 'set-match' };
    }
    return {
      kind: 'set-mismatch',
      expected: [...entry.acceptableSet].sort(),
      actual: [...actualSet].sort(),
    };
  }
  if (entry.themeReference !== undefined) {
    const tags = parseJsonStringArray(actualValue);
    if (tags === null) {
      return { kind: 'tags-parse-fail' };
    }
    const floor = entry.minTagsRequired ?? 1;
    if (tags.length < floor) {
      return { kind: 'tags-floor-fail', actualLength: tags.length, required: floor };
    }
    // Format candidate as readable prose for the judge: "tags: a, b, c"
    return {
      kind: 'theme',
      reference: entry.themeReference,
      candidate: `tags: ${tags.join(', ')}`,
    };
  }
  if (entry.proseReference !== undefined) {
    return { kind: 'prose', reference: entry.proseReference, candidate: actualValue };
  }
  // None of the strategy fields set — programmer error.
  throw new Error(
    `Ground truth metadata entry for ${entry.defKey}.${entry.key} has none of exactValue/acceptableSet/themeReference/proseReference set`
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
