import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, ProseJudgeFn, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Lower default threshold for module descriptions vs definition_metadata.
 * The tree-phase prompt asks for a single short sentence per module
 * (`buildTreeSystemPrompt` examples are ~5–10 words), which gives the
 * judge less surface area to score → cosine drifts naturally lower.
 *
 * Iteration 4 starts at 0.6 — the same floor we found necessary for
 * iteration 3's terse relationship semantics. Per-entry overrides via
 * `GroundTruthModule.minSimilarity` remain available for borderline cases.
 */
const DEFAULT_MODULE_PROSE_MIN_SIMILARITY = 0.6;

interface ProducedModuleRow {
  fullPath: string;
  description: string | null;
}

/**
 * Compare the `modules` table.
 *
 * Natural key: `full_path`. Async because module descriptions are LLM prose
 * and need to be judged when GT declares a `descriptionReference`.
 *
 * Severity matrix:
 *   GT module missing in produced       → MAJOR
 *   Extra produced module               → MINOR (suppressed if it's an
 *                                          ancestor of any GT module — those
 *                                          are auto-created scaffolding rows)
 *   Description prose drift             → MINOR (prose-drift kind)
 *   Produced description NULL when GT
 *     declared a reference              → MINOR (prose-drift kind, distinct
 *                                          from "judge said no" — no judge call)
 *   Module 'project' root               → IGNORED (always present)
 */
export async function compareModules(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();
  const producedRows = conn
    .prepare('SELECT full_path AS fullPath, description FROM modules')
    .all() as ProducedModuleRow[];
  const producedByPath = new Map<string, ProducedModuleRow>();
  for (const r of producedRows) {
    producedByPath.set(r.fullPath, r);
  }

  const expected = gt.modules ?? [];
  const expectedSet = new Set(expected.map((m) => m.fullPath));

  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const e of expected) {
    const producedRow = producedByPath.get(e.fullPath);
    if (!producedRow) {
      diffs.push({
        kind: 'missing',
        severity: 'major',
        naturalKey: e.fullPath,
        details: `Module '${e.fullPath}' is in ground truth but missing from produced DB`,
      });
      continue;
    }

    // Optional prose check on description (only when GT declares a reference)
    if (e.descriptionReference != null) {
      if (producedRow.description == null) {
        // Distinct case: the LLM never wrote a description for this module.
        // Judge can't compare against null, so flag it directly.
        diffs.push({
          kind: 'prose-drift',
          severity: 'minor',
          naturalKey: e.fullPath,
          details: `module description is null in produced DB; expected prose matching: '${truncate(e.descriptionReference)}'`,
        });
        proseChecksFailed += 1;
      } else {
        const minSim = e.minSimilarity ?? DEFAULT_MODULE_PROSE_MIN_SIMILARITY;
        const judgment = await judgeFn({
          field: `modules.description for ${e.fullPath}`,
          reference: e.descriptionReference,
          candidate: producedRow.description,
          minSimilarity: minSim,
        });
        if (judgment.passed) {
          proseChecksPassed += 1;
        } else {
          proseChecksFailed += 1;
          diffs.push({
            kind: 'prose-drift',
            severity: 'minor',
            naturalKey: e.fullPath,
            details: `prose drift: similarity ${judgment.similarity.toFixed(2)} < ${minSim} — ${judgment.reasoning}`,
          });
        }
      }
    }
  }

  // Produced DB will always have auto-created intermediate ancestors and the
  // 'project' root. Don't report those — only report extras with no descendants.
  for (const p of producedRows) {
    if (expectedSet.has(p.fullPath)) continue;
    if (p.fullPath === 'project') continue;
    const isAncestor = expected.some((e) => e.fullPath.startsWith(`${p.fullPath}.`));
    if (isAncestor) continue;
    diffs.push({
      kind: 'extra',
      severity: 'minor',
      naturalKey: p.fullPath,
      details: `Produced DB has module '${p.fullPath}' not declared in ground truth`,
    });
  }

  return {
    table: 'modules',
    passed: tableDiffPassed(diffs),
    expectedCount: expected.length,
    producedCount: producedRows.length,
    diffs,
    proseChecks: { passed: proseChecksPassed, failed: proseChecksFailed },
  };
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
