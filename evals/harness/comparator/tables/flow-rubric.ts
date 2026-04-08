import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { FlowStakeholder, GroundTruth, ProseJudgeFn, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Default minimum similarity for the flow role check. Uses theme-judge mode
 * for tolerance — flow names + descriptions are short and the LLM picks
 * different vocab across runs.
 */
const DEFAULT_FLOW_ROLE_MIN_SIMILARITY = 0.6;

interface ProducedFlowRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  stakeholder: string;
}

/**
 * Compare LLM-driven flows via a theme-search rubric.
 *
 * Each rubric entry describes a thematic concept ("User logs in with
 * credentials") plus an acceptable stakeholder set. The comparator iterates
 * ALL produced flows, scores each candidate's name+description against the
 * expected role via the theme judge, and picks the best match. The match
 * passes if:
 *   1. At least one flow scores >= minRoleSimilarity, AND
 *   2. Its stakeholder is in acceptableStakeholders (when set).
 *
 * Severity:
 *   - No flow scores >= threshold (no thematic match)  → CRITICAL
 *   - Best match's stakeholder not in acceptable set   → MAJOR
 *
 * The rubric is intentionally tolerant — squint's flows stage produces a
 * small number of high-level journeys with LLM-picked names/slugs/paths,
 * none of which are deterministic. Theme search decouples the GT from
 * those LLM choices entirely.
 */
export async function compareFlowRubric(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();

  const flowRows = conn
    .prepare('SELECT id, slug, name, description, stakeholder FROM flows')
    .all() as ProducedFlowRow[];

  const rubric = gt.flowRubric ?? [];
  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const entry of rubric) {
    const minSim = entry.minRoleSimilarity ?? DEFAULT_FLOW_ROLE_MIN_SIMILARITY;

    // Theme-judge every flow against the expected role; track the best match
    let bestFlow: ProducedFlowRow | null = null;
    let bestScore = -1;
    let bestReasoning = '';

    for (const flow of flowRows) {
      const candidate = `${flow.name}: ${flow.description ?? '(no description)'}`;
      const judgment = await judgeFn({
        field: `flow_rubric.${entry.label} (candidate: ${flow.slug})`,
        reference: entry.expectedRole,
        candidate,
        minSimilarity: minSim,
        mode: 'theme',
      });
      if (judgment.similarity > bestScore) {
        bestScore = judgment.similarity;
        bestFlow = flow;
        bestReasoning = judgment.reasoning;
      }
    }

    if (bestFlow === null || bestScore < minSim) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: entry.label,
        details: `flow rubric '${entry.label}': no flow matches the expected role (best score ${bestScore.toFixed(2)} < ${minSim}${bestFlow ? `, best candidate '${bestFlow.slug}': ${bestReasoning}` : ', no flows at all'})`,
      });
      proseChecksFailed += 1;
      continue;
    }

    proseChecksPassed += 1;

    // Stakeholder check on the best-matching flow
    if (entry.acceptableStakeholders && entry.acceptableStakeholders.length > 0) {
      if (!entry.acceptableStakeholders.includes(bestFlow.stakeholder as FlowStakeholder)) {
        diffs.push({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: entry.label,
          details: `flow rubric '${entry.label}': matched flow '${bestFlow.slug}' has stakeholder '${bestFlow.stakeholder}' not in acceptable set [${entry.acceptableStakeholders.join(', ')}]`,
        });
      }
    }
  }

  return {
    table: 'flow_rubric',
    passed: tableDiffPassed(diffs),
    expectedCount: rubric.length,
    producedCount: flowRows.length,
    diffs,
    proseChecks: { passed: proseChecksPassed, failed: proseChecksFailed },
  };
}
