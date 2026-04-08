import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, ProseJudgeFn, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

const DEFAULT_FEATURE_ROLE_MIN_SIMILARITY = 0.6;

interface ProducedFeatureRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
}

/**
 * Compare LLM-driven features via a theme-search rubric.
 *
 * Each rubric entry describes a target feature concept (e.g.,
 * "User authentication and identity"). The comparator iterates ALL produced
 * features, theme-judges each name+description against the expected role,
 * and picks the best match. Critical if no feature scores above threshold.
 *
 * Severity:
 *   - No feature matches expected theme → CRITICAL
 *
 * No cohesion / flow-assignment check: squint's flow→feature assignment is
 * non-deterministic and the flow entry anchors are unreliable. Theme-only
 * matching keeps the rubric robust to LLM variance.
 */
export async function compareFeatureCohesion(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();

  const featureRows = conn.prepare('SELECT id, slug, name, description FROM features').all() as ProducedFeatureRow[];

  const groups = gt.featureCohesion ?? [];
  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const entry of groups) {
    const minSim = entry.minRoleSimilarity ?? DEFAULT_FEATURE_ROLE_MIN_SIMILARITY;

    let bestFeature: ProducedFeatureRow | null = null;
    let bestScore = -1;
    let bestReasoning = '';

    for (const feature of featureRows) {
      const candidate = `${feature.name}: ${feature.description ?? '(no description)'}`;
      const judgment = await judgeFn({
        field: `feature_cohesion.${entry.label} (candidate: ${feature.slug})`,
        reference: entry.expectedRole,
        candidate,
        minSimilarity: minSim,
        mode: 'theme',
      });
      if (judgment.similarity > bestScore) {
        bestScore = judgment.similarity;
        bestFeature = feature;
        bestReasoning = judgment.reasoning;
      }
    }

    if (bestFeature === null || bestScore < minSim) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: entry.label,
        details: `feature cohesion '${entry.label}': no feature matches the expected role (best score ${bestScore.toFixed(2)} < ${minSim}${bestFeature ? `, best candidate '${bestFeature.slug}': ${bestReasoning}` : ', no features at all'})`,
      });
      proseChecksFailed += 1;
      continue;
    }

    proseChecksPassed += 1;
  }

  return {
    table: 'feature_cohesion',
    passed: tableDiffPassed(diffs),
    expectedCount: groups.length,
    producedCount: featureRows.length,
    diffs,
    proseChecks: { passed: proseChecksPassed, failed: proseChecksFailed },
  };
}
