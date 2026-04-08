import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, InteractionSource, ProseJudgeFn, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Default minimum similarity for the semantic prose check. Lower than the
 * prose default (0.75) because LLM-generated semantic prose for interactions
 * is short ("validates auth credentials before forwarding the request") and
 * the theme judge mode is more tolerant.
 */
const DEFAULT_SEMANTIC_MIN_SIMILARITY = 0.6;

/**
 * Default acceptable sources when the rubric entry omits `acceptableSources`.
 * Excludes 'llm-inferred' because it's the most variance-prone source — the
 * cross-process inference step in iter 6 generates speculative edges that
 * may or may not appear across runs.
 */
const DEFAULT_ACCEPTABLE_SOURCES: InteractionSource[] = ['ast', 'ast-import', 'contract-matched'];

interface ProducedInteractionRow {
  fromModuleId: number;
  toModuleId: number;
  fromPath: string;
  toPath: string;
  source: string;
  semantic: string | null;
}

/**
 * Compare LLM-driven interactions via an anchor-based rubric.
 *
 * Each rubric entry names a "from anchor" definition and a "to anchor"
 * definition. The comparator looks up the modules those defs are assigned
 * to (via `module_members`) and then verifies an interaction edge exists
 * between those modules with an acceptable `source` and (optionally) a
 * semantic prose that the theme judge approves.
 *
 * Severity matrix:
 *   - Anchor def doesn't exist in produced       → CRITICAL
 *   - Anchor def has no module assignment        → CRITICAL
 *   - Both anchors resolve to the same module    → MAJOR (no cross-module edge)
 *   - No interaction edge between resolved mods  → MAJOR
 *   - Interaction `source` not in acceptableSet  → MAJOR
 *   - Semantic prose drift below threshold       → MINOR (prose-drift)
 */
export async function compareInteractionRubric(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();

  // defKey → moduleId map (from module_members JOIN)
  const memberRows = conn
    .prepare(
      `SELECT (f.path || '::' || d.name) AS defKey,
              mm.module_id AS moduleId,
              m.full_path AS fullPath
       FROM module_members mm
       JOIN definitions d ON mm.definition_id = d.id
       JOIN files f ON d.file_id = f.id
       JOIN modules m ON mm.module_id = m.id`
    )
    .all() as Array<{ defKey: string; moduleId: number; fullPath: string }>;
  const defToModule = new Map<string, { moduleId: number; fullPath: string }>();
  for (const r of memberRows) {
    defToModule.set(r.defKey, { moduleId: r.moduleId, fullPath: r.fullPath });
  }

  // Set of all defKeys present in produced
  const producedDefKeys = new Set<string>(
    (
      conn
        .prepare("SELECT (f.path || '::' || d.name) AS defKey FROM definitions d JOIN files f ON d.file_id = f.id")
        .all() as Array<{ defKey: string }>
    ).map((r) => r.defKey)
  );

  // Index interactions by (fromModuleId, toModuleId)
  const interactionRows = conn
    .prepare(
      `SELECT i.from_module_id AS fromModuleId,
              i.to_module_id AS toModuleId,
              fm.full_path AS fromPath,
              tm.full_path AS toPath,
              i.source AS source,
              i.semantic AS semantic
       FROM interactions i
       JOIN modules fm ON i.from_module_id = fm.id
       JOIN modules tm ON i.to_module_id = tm.id`
    )
    .all() as ProducedInteractionRow[];
  const interactionByModulePair = new Map<string, ProducedInteractionRow>();
  for (const i of interactionRows) {
    interactionByModulePair.set(`${i.fromModuleId}->${i.toModuleId}`, i);
  }

  const rubric = gt.interactionRubric ?? [];
  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const entry of rubric) {
    const fromKey = entry.fromAnchor as unknown as string;
    const toKey = entry.toAnchor as unknown as string;

    // Critical: anchor def not in produced
    if (!producedDefKeys.has(fromKey)) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: entry.label,
        details: `interaction rubric '${entry.label}' references unknown FROM anchor '${fromKey}'`,
      });
      continue;
    }
    if (!producedDefKeys.has(toKey)) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: entry.label,
        details: `interaction rubric '${entry.label}' references unknown TO anchor '${toKey}'`,
      });
      continue;
    }

    // Critical: anchor def is unassigned to any module
    const fromAssign = defToModule.get(fromKey);
    const toAssign = defToModule.get(toKey);
    if (!fromAssign) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: entry.label,
        details: `interaction rubric '${entry.label}': FROM anchor '${fromKey}' is unassigned to any module`,
      });
      continue;
    }
    if (!toAssign) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: entry.label,
        details: `interaction rubric '${entry.label}': TO anchor '${toKey}' is unassigned to any module`,
      });
      continue;
    }

    // Self-loop: from and to resolve to the same module. The interactions
    // table only stores cross-module edges, so a self-loop rubric entry
    // can never match. Treat as MAJOR — the rubric author likely intended
    // two separate modules.
    if (fromAssign.moduleId === toAssign.moduleId) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: entry.label,
        details: `interaction rubric '${entry.label}': both anchors resolve to the same module '${fromAssign.fullPath}', no cross-module edge to verify`,
      });
      continue;
    }

    // Look up the interaction edge between the two resolved modules
    const interaction = interactionByModulePair.get(`${fromAssign.moduleId}->${toAssign.moduleId}`);
    if (!interaction) {
      diffs.push({
        kind: 'missing',
        severity: 'major',
        naturalKey: entry.label,
        details: `interaction rubric '${entry.label}': no interaction edge between '${fromAssign.fullPath}' (containing ${fromKey}) and '${toAssign.fullPath}' (containing ${toKey})`,
      });
      continue;
    }

    // Source check
    const acceptable = entry.acceptableSources ?? DEFAULT_ACCEPTABLE_SOURCES;
    if (!acceptable.includes(interaction.source as InteractionSource)) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: entry.label,
        details: `interaction rubric '${entry.label}': source '${interaction.source}' not in acceptable set [${acceptable.join(', ')}]`,
      });
      continue;
    }

    // Optional semantic prose check
    if (entry.semanticReference != null) {
      if (interaction.semantic == null) {
        diffs.push({
          kind: 'prose-drift',
          severity: 'minor',
          naturalKey: entry.label,
          details: `interaction rubric '${entry.label}': semantic is null in produced DB; expected prose matching '${truncate(entry.semanticReference)}'`,
        });
        proseChecksFailed += 1;
        continue;
      }

      const minSim = entry.minSimilarity ?? DEFAULT_SEMANTIC_MIN_SIMILARITY;
      const judgment = await judgeFn({
        field: `interaction_rubric.${entry.label} semantic check`,
        reference: entry.semanticReference,
        candidate: interaction.semantic,
        minSimilarity: minSim,
        mode: 'theme',
      });
      if (judgment.passed) {
        proseChecksPassed += 1;
      } else {
        diffs.push({
          kind: 'prose-drift',
          severity: 'minor',
          naturalKey: entry.label,
          details: `interaction rubric '${entry.label}': semantic drift ${judgment.similarity.toFixed(2)} < ${minSim} — ${judgment.reasoning}`,
        });
        proseChecksFailed += 1;
      }
    }
  }

  return {
    table: 'interaction_rubric',
    passed: tableDiffPassed(diffs),
    expectedCount: rubric.length,
    producedCount: interactionRows.length,
    diffs,
    proseChecks: { passed: proseChecksPassed, failed: proseChecksFailed },
  };
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
