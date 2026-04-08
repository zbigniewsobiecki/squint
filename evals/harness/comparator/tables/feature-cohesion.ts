import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, ProseJudgeFn, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

const DEFAULT_FEATURE_ROLE_MIN_SIMILARITY = 0.6;

interface ProducedFlowAnchor {
  flowId: number;
  entryDefKey: string | null;
  entryPath: string | null;
}

interface ProducedFeatureRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
}

/**
 * Compare LLM-driven features via a flow-cohesion rubric.
 *
 * Each rubric entry names a SET of flows (identified by entry path or entry
 * def — never by LLM-picked slug) that should belong to the same feature.
 * The comparator:
 *
 *   1. Resolves each rubric flow to a flow id via entry-point matching.
 *   2. Looks up the feature_id for each resolved flow.
 *   3. Computes the "winning" feature (the one containing the most rubric flows).
 *   4. Verifies cohesion (strict / majority).
 *   5. Sends the winning feature's name + description to the theme judge
 *      against the rubric's expectedRole.
 *
 * Severity:
 *   - Rubric flow can't be resolved (no entry match) → CRITICAL
 *   - Rubric flow exists but has no feature          → CRITICAL
 *   - Strict cohesion violated                       → MAJOR
 *   - Majority cohesion violated                     → MAJOR
 *   - Role judge below threshold                     → MINOR (prose-drift)
 */
export async function compareFeatureCohesion(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();

  // Pull all flows with entry anchors
  const flowAnchors = conn
    .prepare(
      `SELECT f.id AS flowId,
              CASE WHEN f.entry_point_id IS NULL THEN NULL
                   ELSE (fl.path || '::' || d.name)
              END AS entryDefKey,
              f.entry_path AS entryPath
       FROM flows f
       LEFT JOIN definitions d ON f.entry_point_id = d.id
       LEFT JOIN files fl ON d.file_id = fl.id`
    )
    .all() as ProducedFlowAnchor[];

  // Index flows by anchor
  const flowIdByEntryPath = new Map<string, number>();
  const flowIdByEntryDef = new Map<string, number>();
  for (const f of flowAnchors) {
    if (f.entryPath) flowIdByEntryPath.set(f.entryPath, f.flowId);
    if (f.entryDefKey) flowIdByEntryDef.set(f.entryDefKey, f.flowId);
  }

  // Pull feature_flows → flowId → featureId
  const featureFlowRows = conn
    .prepare('SELECT feature_id AS featureId, flow_id AS flowId FROM feature_flows')
    .all() as Array<{
    featureId: number;
    flowId: number;
  }>;
  const featureByFlowId = new Map<number, number>();
  for (const r of featureFlowRows) {
    featureByFlowId.set(r.flowId, r.featureId);
  }

  // Pull all features
  const featureRows = conn.prepare('SELECT id, slug, name, description FROM features').all() as ProducedFeatureRow[];
  const featureById = new Map<number, ProducedFeatureRow>();
  for (const f of featureRows) {
    featureById.set(f.id, f);
  }

  const groups = gt.featureCohesion ?? [];
  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const group of groups) {
    // Resolve each rubric flow → flowId → featureId
    const resolvedFlows: Array<{ flowId: number; featureId: number }> = [];
    let earlyFail = false;

    for (const ref of group.flows) {
      let flowId: number | undefined;
      if (ref.entryPath) {
        flowId = flowIdByEntryPath.get(ref.entryPath);
      } else if (ref.entryDef) {
        flowId = flowIdByEntryDef.get(ref.entryDef as unknown as string);
      }

      if (flowId === undefined) {
        diffs.push({
          kind: 'missing',
          severity: 'critical',
          naturalKey: group.label,
          details: `feature cohesion '${group.label}': no flow found for ${
            ref.entryPath ? `entry path '${ref.entryPath}'` : `entry def '${ref.entryDef}'`
          }`,
        });
        earlyFail = true;
        break;
      }

      const featureId = featureByFlowId.get(flowId);
      if (featureId === undefined) {
        diffs.push({
          kind: 'missing',
          severity: 'critical',
          naturalKey: group.label,
          details: `feature cohesion '${group.label}': flow ${flowId} (${ref.entryPath ?? ref.entryDef}) is not assigned to any feature`,
        });
        earlyFail = true;
        break;
      }
      resolvedFlows.push({ flowId, featureId });
    }

    if (earlyFail) continue;

    // Bucket by feature
    const buckets = new Map<number, number>();
    for (const r of resolvedFlows) {
      buckets.set(r.featureId, (buckets.get(r.featureId) ?? 0) + 1);
    }

    // Pick winner
    let winnerFeatureId = -1;
    let winnerCount = 0;
    for (const [fid, count] of buckets) {
      if (count > winnerCount) {
        winnerCount = count;
        winnerFeatureId = fid;
      }
    }

    // Cohesion check
    const total = resolvedFlows.length;
    const cohesionMode = group.cohesion ?? 'strict';
    if (cohesionMode === 'strict') {
      if (winnerCount !== total) {
        diffs.push({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: group.label,
          details: `feature cohesion(strict) failed for '${group.label}': flows split across ${buckets.size} features — ${formatBuckets(buckets, featureById)}`,
        });
        continue;
      }
    } else {
      // boundary-inclusive >=50%
      if (winnerCount * 2 < total) {
        diffs.push({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: group.label,
          details: `feature cohesion(majority) failed for '${group.label}': winning feature has ${winnerCount}/${total} flows — ${formatBuckets(buckets, featureById)}`,
        });
        continue;
      }
    }

    // Role judge — send winner feature's name + description to theme judge
    const winnerFeature = featureById.get(winnerFeatureId);
    if (!winnerFeature) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: group.label,
        details: `feature cohesion '${group.label}': winner feature id ${winnerFeatureId} not found`,
      });
      continue;
    }
    const candidate = `${winnerFeature.name}: ${winnerFeature.description ?? '(no description)'}`;
    const minSim = group.minRoleSimilarity ?? DEFAULT_FEATURE_ROLE_MIN_SIMILARITY;
    const judgment = await judgeFn({
      field: `feature_cohesion.${group.label} role check`,
      reference: group.expectedRole,
      candidate,
      minSimilarity: minSim,
      mode: 'theme',
    });
    if (judgment.passed) {
      proseChecksPassed += 1;
    } else {
      proseChecksFailed += 1;
      diffs.push({
        kind: 'prose-drift',
        severity: 'minor',
        naturalKey: group.label,
        details: `feature cohesion '${group.label}': role drift ${judgment.similarity.toFixed(2)} < ${minSim} — ${judgment.reasoning}`,
      });
    }
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

function formatBuckets(buckets: Map<number, number>, featureById: Map<number, ProducedFeatureRow>): string {
  const parts: string[] = [];
  for (const [fid, count] of buckets) {
    const slug = featureById.get(fid)?.slug ?? `id-${fid}`;
    parts.push(`${slug}(${count})`);
  }
  return parts.join(', ');
}
