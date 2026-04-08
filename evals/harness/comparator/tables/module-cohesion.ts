import type { IndexDatabase } from '../../../../src/db/database-facade.js';
import type { GroundTruth, ModuleCohesionGroup, ProseJudgeFn, RowDiff, TableDiff } from '../../types.js';
import { tableDiffPassed } from '../severity.js';

/**
 * Default minimum similarity for the role-judge call. Lower than the prose
 * default (0.75) because module names + descriptions are short and the
 * candidate is mechanically formatted ("name: description"). Iter 4's prose
 * checks already use 0.6 for the same reason.
 */
const DEFAULT_ROLE_MIN_SIMILARITY = 0.6;

interface MemberAssignment {
  defKey: string;
  moduleId: number | null;
  moduleFullPath: string | null;
}

interface ProducedModuleRow {
  id: number;
  fullPath: string;
  name: string;
  description: string | null;
}

/**
 * Compare LLM-driven module assignments via a cohesion + role rubric.
 *
 * Replaces the strict `compareModules` + `compareModuleMembers` exact-matching
 * for LLM-driven module-stage iterations. Verifies the *property* that
 * semantically related definitions live in the same module that plays the
 * expected role, rather than the *spelling* of the LLM's slug choices.
 *
 * Severity matrix:
 *   GT references unknown definition       → CRITICAL
 *   Any group member is unassigned         → CRITICAL
 *   Strict cohesion violated               → MAJOR
 *   Majority cohesion violated             → MAJOR
 *   Role judge below threshold             → MINOR (prose-drift)
 *
 * The "winner" module is the one containing all members (strict) or the
 * largest share (majority). Its name+description is sent to the prose judge
 * with `expectedRole` as the reference.
 */
export async function compareModuleCohesion(
  produced: IndexDatabase,
  gt: GroundTruth,
  judgeFn: ProseJudgeFn
): Promise<TableDiff> {
  const conn = produced.getConnection();

  // Build defKey → { moduleId, fullPath } map for produced assignments
  const memberRows = conn
    .prepare(
      `SELECT (f.path || '::' || d.name) AS defKey,
              m.id AS moduleId,
              m.full_path AS fullPath
       FROM module_members mm
       JOIN definitions d ON mm.definition_id = d.id
       JOIN files f ON d.file_id = f.id
       JOIN modules m ON mm.module_id = m.id`
    )
    .all() as Array<{ defKey: string; moduleId: number; fullPath: string }>;
  const assignmentByDef = new Map<string, { moduleId: number; fullPath: string }>();
  for (const r of memberRows) {
    assignmentByDef.set(r.defKey, { moduleId: r.moduleId, fullPath: r.fullPath });
  }

  // Set of defKeys present in produced — for the "GT references unknown def" check
  const producedDefKeys = new Set<string>(
    (
      conn
        .prepare("SELECT (f.path || '::' || d.name) AS defKey FROM definitions d JOIN files f ON d.file_id = f.id")
        .all() as Array<{ defKey: string }>
    ).map((r) => r.defKey)
  );

  // Module lookup by id (for fetching name + description after we pick a winner)
  const moduleRows = conn
    .prepare('SELECT id, full_path AS fullPath, name, description FROM modules')
    .all() as ProducedModuleRow[];
  const moduleById = new Map<number, ProducedModuleRow>();
  for (const m of moduleRows) {
    moduleById.set(m.id, m);
  }

  const groups = gt.moduleCohesion ?? [];
  const diffs: RowDiff[] = [];
  let proseChecksPassed = 0;
  let proseChecksFailed = 0;

  for (const group of groups) {
    const groupResult = await evaluateGroup(group, assignmentByDef, producedDefKeys, moduleById, judgeFn);
    diffs.push(...groupResult.diffs);
    proseChecksPassed += groupResult.proseChecksPassed;
    proseChecksFailed += groupResult.proseChecksFailed;
  }

  return {
    table: 'module_cohesion',
    passed: tableDiffPassed(diffs),
    expectedCount: groups.length,
    producedCount: memberRows.length,
    diffs,
    proseChecks: { passed: proseChecksPassed, failed: proseChecksFailed },
  };
}

interface GroupEvalResult {
  diffs: RowDiff[];
  proseChecksPassed: number;
  proseChecksFailed: number;
}

async function evaluateGroup(
  group: ModuleCohesionGroup,
  assignmentByDef: Map<string, { moduleId: number; fullPath: string }>,
  producedDefKeys: Set<string>,
  moduleById: Map<number, ProducedModuleRow>,
  judgeFn: ProseJudgeFn
): Promise<GroupEvalResult> {
  const diffs: RowDiff[] = [];

  // Resolve member assignments + check for unknown defs
  const assignments: MemberAssignment[] = [];
  for (const member of group.members) {
    const memberKey = member as unknown as string;
    if (!producedDefKeys.has(memberKey)) {
      diffs.push({
        kind: 'missing',
        severity: 'critical',
        naturalKey: group.label,
        details: `cohesion group '${group.label}' references unknown definition '${memberKey}'`,
      });
      // Stop processing this group — there's no useful comparison after a missing def
      return { diffs, proseChecksPassed: 0, proseChecksFailed: 0 };
    }
    const assigned = assignmentByDef.get(memberKey);
    assignments.push({
      defKey: memberKey,
      moduleId: assigned?.moduleId ?? null,
      moduleFullPath: assigned?.fullPath ?? null,
    });
  }

  // Critical: any member completely unassigned to any module
  const unassigned = assignments.filter((a) => a.moduleId === null);
  if (unassigned.length > 0) {
    diffs.push({
      kind: 'missing',
      severity: 'critical',
      naturalKey: group.label,
      details: `cohesion group '${group.label}' has ${unassigned.length} unassigned member(s): ${unassigned
        .map((a) => a.defKey)
        .join(', ')}`,
    });
    return { diffs, proseChecksPassed: 0, proseChecksFailed: 0 };
  }

  // Bucket assigned members by their containing module
  const buckets = new Map<number, MemberAssignment[]>();
  for (const a of assignments) {
    if (a.moduleId === null) continue;
    let bucket = buckets.get(a.moduleId);
    if (!bucket) {
      bucket = [];
      buckets.set(a.moduleId, bucket);
    }
    bucket.push(a);
  }

  // Pick the winning module: the one with the most members
  let winnerModuleId: number | null = null;
  let winnerCount = 0;
  for (const [moduleId, bucket] of buckets) {
    if (bucket.length > winnerCount) {
      winnerCount = bucket.length;
      winnerModuleId = moduleId;
    }
  }

  // Cohesion check
  const cohesionMode = group.cohesion ?? 'strict';
  if (cohesionMode === 'strict') {
    if (winnerCount !== assignments.length) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: group.label,
        details: `cohesion(strict) failed for '${group.label}': members scattered across ${buckets.size} modules — ${formatBuckets(buckets, moduleById)}`,
      });
      return { diffs, proseChecksPassed: 0, proseChecksFailed: 0 };
    }
  } else {
    // 'majority': winner must contain >50% of members
    const totalMembers = assignments.length;
    if (winnerCount * 2 <= totalMembers) {
      diffs.push({
        kind: 'mismatch',
        severity: 'major',
        naturalKey: group.label,
        details: `cohesion(majority) failed for '${group.label}': winning module has ${winnerCount}/${totalMembers} members — ${formatBuckets(buckets, moduleById)}`,
      });
      return { diffs, proseChecksPassed: 0, proseChecksFailed: 0 };
    }
  }

  // Role judge: send the winning module's name + description to the LLM
  if (winnerModuleId === null) {
    // Should be unreachable given the assignment checks above, but keep total
    diffs.push({
      kind: 'mismatch',
      severity: 'major',
      naturalKey: group.label,
      details: `cohesion '${group.label}': internal — could not pick a winner module`,
    });
    return { diffs, proseChecksPassed: 0, proseChecksFailed: 0 };
  }
  const winnerModule = moduleById.get(winnerModuleId);
  if (!winnerModule) {
    diffs.push({
      kind: 'mismatch',
      severity: 'major',
      naturalKey: group.label,
      details: `cohesion '${group.label}': winning module id ${winnerModuleId} not found in modules table`,
    });
    return { diffs, proseChecksPassed: 0, proseChecksFailed: 0 };
  }

  const candidate = formatModuleAsCandidate(winnerModule);
  const minSim = group.minRoleSimilarity ?? DEFAULT_ROLE_MIN_SIMILARITY;
  // Use the tolerant 'theme' judge mode for role checks: the candidate is a
  // short LLM-produced label (name + brief description), conceptually the
  // same kind of input as the tag-list theme strategy. The strict prose
  // mode is too harsh for this — it scores around 0.4 because the short
  // label can't paraphrase every detail in the rubric's expectedRole.
  const judgment = await judgeFn({
    field: `module_cohesion.${group.label} role check`,
    reference: group.expectedRole,
    candidate,
    minSimilarity: minSim,
    mode: 'theme',
  });

  if (judgment.passed) {
    return { diffs, proseChecksPassed: 1, proseChecksFailed: 0 };
  }
  diffs.push({
    kind: 'prose-drift',
    severity: 'minor',
    naturalKey: group.label,
    details: `role drift: similarity ${judgment.similarity.toFixed(2)} < ${minSim} — ${judgment.reasoning}`,
  });
  return { diffs, proseChecksPassed: 0, proseChecksFailed: 1 };
}

/**
 * Format the winning module's name + description as a single short string
 * that the prose judge can compare against the rubric's `expectedRole`.
 *
 * Uses the LEAF NAME of the module (last segment of full_path), not the
 * `name` column, because the LLM-picked `name` is sometimes a more verbose
 * "Authentication API" while the slug stays compact ("auth"). The leaf is
 * what an end user sees; the description carries the semantic detail.
 *
 * Falls back to "(no description)" if the description column is null —
 * tested against this exact string in the unit suite.
 */
function formatModuleAsCandidate(module: ProducedModuleRow): string {
  const segments = module.fullPath.split('.');
  const leaf = segments[segments.length - 1] ?? module.fullPath;
  const description = module.description ?? '(no description)';
  return `${leaf}: ${description}`;
}

/**
 * Format a per-module bucket count for human-readable diff details.
 * "moduleA(3), moduleB(1)"
 */
function formatBuckets(buckets: Map<number, MemberAssignment[]>, moduleById: Map<number, ProducedModuleRow>): string {
  const parts: string[] = [];
  for (const [moduleId, members] of buckets) {
    const path = moduleById.get(moduleId)?.fullPath ?? `id-${moduleId}`;
    parts.push(`${path}(${members.length})`);
  }
  return parts.join(', ');
}
