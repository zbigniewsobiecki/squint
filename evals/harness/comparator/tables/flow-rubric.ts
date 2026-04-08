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
  entryDefId: number | null;
  entryDefKey: string | null;
  entryPath: string | null;
}

interface ProducedFlowDefStep {
  flowId: number;
  fromKey: string;
  toKey: string;
}

/**
 * Compare LLM-driven flows via an entry-point-based rubric.
 *
 * Each rubric entry identifies an EXPECTED flow by its entry point (HTTP path
 * or entry definition), then verifies:
 *   - The flow's stakeholder is in the acceptable set
 *   - The flow's definition-level steps include the required edges
 *     (subset semantics — extras are fine)
 *   - The flow's name + description match the expected role (theme judge)
 *
 * Severity:
 *   - No flow matches the rubric entry's entry point     → CRITICAL
 *   - Stakeholder not in acceptable set                  → MAJOR
 *   - Required definition edge missing from flow steps   → MAJOR
 *   - Role judge below threshold                         → MINOR (prose-drift)
 */
export async function compareFlowRubric(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();

  const flowRows = conn
    .prepare(
      `SELECT f.id AS id,
              f.slug AS slug,
              f.name AS name,
              f.description AS description,
              f.stakeholder AS stakeholder,
              f.entry_point_id AS entryDefId,
              CASE WHEN f.entry_point_id IS NULL THEN NULL
                   ELSE (fl.path || '::' || d.name)
              END AS entryDefKey,
              f.entry_path AS entryPath
       FROM flows f
       LEFT JOIN definitions d ON f.entry_point_id = d.id
       LEFT JOIN files fl ON d.file_id = fl.id`
    )
    .all() as ProducedFlowRow[];

  const stepRows = conn
    .prepare(
      `SELECT fds.flow_id AS flowId,
              (ff.path || '::' || fd.name) AS fromKey,
              (tf.path || '::' || td.name) AS toKey
       FROM flow_definition_steps fds
       JOIN definitions fd ON fds.from_definition_id = fd.id
       JOIN files ff ON fd.file_id = ff.id
       JOIN definitions td ON fds.to_definition_id = td.id
       JOIN files tf ON td.file_id = tf.id`
    )
    .all() as ProducedFlowDefStep[];

  const stepsByFlow = new Map<number, Set<string>>();
  for (const s of stepRows) {
    let set = stepsByFlow.get(s.flowId);
    if (!set) {
      set = new Set();
      stepsByFlow.set(s.flowId, set);
    }
    set.add(`${s.fromKey}->${s.toKey}`);
  }

  // Index flows by entry path AND by entry def key
  const flowsByEntryPath = new Map<string, ProducedFlowRow[]>();
  const flowsByEntryDef = new Map<string, ProducedFlowRow[]>();
  for (const f of flowRows) {
    if (f.entryPath) {
      let list = flowsByEntryPath.get(f.entryPath);
      if (!list) {
        list = [];
        flowsByEntryPath.set(f.entryPath, list);
      }
      list.push(f);
    }
    if (f.entryDefKey) {
      let list = flowsByEntryDef.get(f.entryDefKey);
      if (!list) {
        list = [];
        flowsByEntryDef.set(f.entryDefKey, list);
      }
      list.push(f);
    }
  }

  const rubric = gt.flowRubric ?? [];
  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const entry of rubric) {
    let candidates: ProducedFlowRow[] = [];
    if (entry.entryPath) {
      candidates = flowsByEntryPath.get(entry.entryPath) ?? [];
    } else if (entry.entryDef) {
      candidates = flowsByEntryDef.get(entry.entryDef as unknown as string) ?? [];
    }

    if (candidates.length === 0) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: entry.label,
        details: `flow rubric '${entry.label}': no flow found with entry ${
          entry.entryPath ? `path '${entry.entryPath}'` : `def '${entry.entryDef}'`
        }`,
      });
      continue;
    }

    // HTTP entry paths are typically unique per flow; for entry defs we
    // pick the first match.
    const flow = candidates[0];

    // Stakeholder check
    if (entry.acceptableStakeholders && entry.acceptableStakeholders.length > 0) {
      if (!entry.acceptableStakeholders.includes(flow.stakeholder as FlowStakeholder)) {
        diffs.push({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: entry.label,
          details: `flow rubric '${entry.label}': stakeholder '${flow.stakeholder}' not in acceptable set [${entry.acceptableStakeholders.join(', ')}]`,
        });
        continue;
      }
    }

    // Required definition-edge check (subset semantics)
    if (entry.requiredDefinitionEdges && entry.requiredDefinitionEdges.length > 0) {
      const flowSteps = stepsByFlow.get(flow.id) ?? new Set();
      const missing: string[] = [];
      for (const req of entry.requiredDefinitionEdges) {
        const edgeKey = `${req.from as unknown as string}->${req.to as unknown as string}`;
        if (!flowSteps.has(edgeKey)) {
          missing.push(edgeKey);
        }
      }
      if (missing.length > 0) {
        diffs.push({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: entry.label,
          details: `flow rubric '${entry.label}': missing required definition edges: ${missing.join(', ')}`,
        });
        continue;
      }
    }

    // Role judge: send "name: description" to the theme judge
    if (entry.expectedRole) {
      const candidate = `${flow.name}: ${flow.description ?? '(no description)'}`;
      const minSim = entry.minRoleSimilarity ?? DEFAULT_FLOW_ROLE_MIN_SIMILARITY;
      const judgment = await judgeFn({
        field: `flow_rubric.${entry.label} role check`,
        reference: entry.expectedRole,
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
          naturalKey: entry.label,
          details: `flow rubric '${entry.label}': role drift ${judgment.similarity.toFixed(2)} < ${minSim} — ${judgment.reasoning}`,
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
