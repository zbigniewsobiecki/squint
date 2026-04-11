import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import {
  type GroundTruth,
  type GroundTruthRelationship,
  type ProseJudgeFn,
  type RowDiff,
  type TableDiff,
  parseDefKey,
} from '../../types.js';
import { tableDiffPassed } from '../severity.js';
import { DEFAULT_PROSE_MIN_SIMILARITY } from './shared.js';

interface ProducedRelationshipRow {
  fromKey: string; // file::name
  toKey: string;
  relationshipType: string;
  semantic: string;
}

/**
 * The exact placeholder string parse-time inheritance edges start as
 * (`graph-repository.ts:createInheritanceRelationships`). The relationships
 * LLM stage is supposed to replace it with real prose; if it leaks through to
 * the produced DB, the LLM dropped the annotation and we report it as MAJOR.
 */
const PENDING_LLM_ANNOTATION = 'PENDING_LLM_ANNOTATION';

/**
 * Compare the `relationship_annotations` table. Async because semantic-bearing
 * entries call the LLM judge.
 *
 * Severity matrix:
 *   GT relationship missing in produced  → CRITICAL
 *   relationship_type mismatch           → MAJOR
 *   semantic === PENDING_LLM_ANNOTATION  → MAJOR (LLM dropped this annotation)
 *   prose drift below similarity         → MINOR (prose-drift kind)
 *   extra produced relationships         → IGNORED (intentional — see below)
 *
 * Why extras are ignored: squint's symbols stage produces many "uses" edges
 * from the call graph that we don't enumerate in GT. The eval claim is "all
 * GT-declared edges exist with valid semantic", not strict equality. This
 * matches the iteration 3 plan and prevents flaky drift on benign extras.
 */
export async function compareRelationshipAnnotations(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();
  const rows = conn
    .prepare(
      `SELECT
         (ff.path || '::' || fd.name) AS fromKey,
         (tf.path || '::' || td.name) AS toKey,
         ra.relationship_type AS relationshipType,
         ra.semantic AS semantic
       FROM relationship_annotations ra
       JOIN definitions fd ON ra.from_definition_id = fd.id
       JOIN files ff ON fd.file_id = ff.id
       JOIN definitions td ON ra.to_definition_id = td.id
       JOIN files tf ON td.file_id = tf.id`
    )
    .all() as ProducedRelationshipRow[];

  // Map by edge key `${fromKey}->${toKey}` for O(1) GT lookup.
  const producedByEdge = new Map<string, ProducedRelationshipRow>();
  for (const r of rows) {
    producedByEdge.set(edgeKey(r.fromKey, r.toKey), r);
  }

  // Set of all definition keys present in produced (for the "GT references
  // unknown definition" critical case). Same join the dispatcher uses for
  // definition_metadata.
  const producedDefKeys = new Set<string>(
    (
      conn
        .prepare("SELECT (f.path || '::' || d.name) AS defKey FROM definitions d JOIN files f ON d.file_id = f.id")
        .all() as Array<{ defKey: string }>
    ).map((r) => r.defKey)
  );

  const expected = gt.relationships ?? [];
  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const entry of expected) {
    const fromKey = entry.fromDef as unknown as string;
    const toKey = entry.toDef as unknown as string;
    const naturalKey = `${fromKey}->${toKey}`;

    // Critical: GT references a definition the produced DB doesn't even have.
    // Distinguishes "the LLM dropped this edge" from "your GT has a typo".
    const missingDef = !producedDefKeys.has(fromKey) ? fromKey : !producedDefKeys.has(toKey) ? toKey : null;
    if (missingDef !== null) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey,
        details: `Ground truth references unknown definition '${missingDef}' (parsed from ${describeEntry(entry)})`,
      });
      continue;
    }

    const producedRow = producedByEdge.get(edgeKey(fromKey, toKey));

    // Critical: GT-declared edge does not exist in produced.
    if (!producedRow) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey,
        details: `Relationship ${naturalKey} (${entry.relationshipType}) missing in produced relationship_annotations`,
      });
      continue;
    }

    // Major: relationship_type mismatch (e.g. GT says extends, produced says uses).
    if (producedRow.relationshipType !== entry.relationshipType) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey,
        details: `relationship_type: expected '${entry.relationshipType}', produced '${producedRow.relationshipType}'`,
      });
      // Don't run prose check or PENDING check for a wrong-type edge — the
      // type mismatch already trumps everything else for this edge.
      continue;
    }

    // Major: the parse-time placeholder leaked through. The relationships
    // LLM stage was supposed to replace it; the LLM dropped this annotation.
    if (producedRow.semantic === PENDING_LLM_ANNOTATION) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey,
        details: `semantic is still '${PENDING_LLM_ANNOTATION}' — relationships annotate stage failed to replace the parse-time placeholder for this edge`,
      });
      continue;
    }

    // Minor (prose-drift): semantic disagrees with the GT reference text.
    // Skip the judge call if the GT didn't declare a reference — this is an
    // existence-and-type-only check.
    if (entry.semanticReference != null) {
      const minSim = entry.minSimilarity ?? DEFAULT_PROSE_MIN_SIMILARITY;
      const judgment = await judgeFn({
        field: `relationship_annotations.semantic for ${naturalKey}`,
        reference: entry.semanticReference,
        candidate: producedRow.semantic,
        minSimilarity: minSim,
      });
      if (judgment.passed) {
        proseChecksPassed += 1;
      } else {
        proseChecksFailed += 1;
        diffs.push({
          kind: 'prose-drift',
          severity: 'minor',
          naturalKey,
          details: `prose drift: similarity ${judgment.similarity.toFixed(2)} < ${minSim} — ${judgment.reasoning}`,
        });
      }
    }
  }

  return {
    table: 'relationship_annotations',
    passed: tableDiffPassed(diffs),
    expectedCount: expected.length,
    producedCount: rows.length,
    diffs,
    proseChecks: { passed: proseChecksPassed, failed: proseChecksFailed },
  };
}

function edgeKey(fromKey: string, toKey: string): string {
  return `${fromKey}->${toKey}`;
}

/**
 * Pretty-print a GT entry for an error message. Falls back to JSON if the
 * keys can't be parsed (e.g. caller passed a malformed defKey).
 */
function describeEntry(entry: GroundTruthRelationship): string {
  try {
    const from = parseDefKey(entry.fromDef);
    const to = parseDefKey(entry.toDef);
    return `${from.file}::${from.name} → ${to.file}::${to.name} [${entry.relationshipType}]`;
  } catch {
    return JSON.stringify({ from: entry.fromDef, to: entry.toDef, type: entry.relationshipType });
  }
}
