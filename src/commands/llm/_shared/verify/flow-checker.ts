/**
 * Flow quality checks: structural integrity and coverage of generated flows.
 */

import type { IndexDatabase } from '../../../../db/database.js';
import { isRuntimeInteraction } from '../../../../db/schema.js';
import type { CoverageCheckResult, VerificationIssue } from './verify-types.js';

/**
 * Check flow quality: structural integrity and coverage of generated flows.
 */
export function checkFlowQuality(db: IndexDatabase): CoverageCheckResult {
  const issues: VerificationIssue[] = [];
  let structuralIssueCount = 0;

  const allFlows = db.flows.getAll();
  const allModulesWithMembers = db.modules.getAllWithMembers();
  const moduleMap = new Map(allModulesWithMembers.map((m) => [m.id, m]));

  // Check 1 — orphan-entry-point: Flow references a module with no callable definitions
  const callableKinds = new Set(['function', 'class', 'const', 'variable', 'method']);
  for (const flow of allFlows) {
    if (!flow.entryPointModuleId) continue;
    const mod = moduleMap.get(flow.entryPointModuleId);
    if (!mod) continue;
    const hasCallable = mod.members.some((m) => callableKinds.has(m.kind));
    if (!hasCallable) {
      issues.push({
        severity: 'error',
        category: 'orphan-entry-point',
        message: `Flow '${flow.name}' (id=${flow.id}) references module '${mod.fullPath}' which has no callable definitions (all members are type-only)`,
        suggestion: 'Use --fix to remove this flow',
        fixData: { action: 'remove-flow', targetDefinitionId: flow.id },
      });
      structuralIssueCount++;
    }
  }

  // Check 2 — empty-flow: Flow has 0 steps
  for (const flow of allFlows) {
    const steps = db.flows.getSteps(flow.id);
    if (steps.length === 0) {
      issues.push({
        severity: 'warning',
        category: 'empty-flow',
        message: `Flow '${flow.name}' (id=${flow.id}) has 0 interaction steps`,
        suggestion: 'Use --fix to remove empty flows',
        fixData: { action: 'remove-flow', targetDefinitionId: flow.id },
      });
    }
  }

  // Check 3 — dangling-interaction: Flow step references a non-existent interaction
  for (const flow of allFlows) {
    const steps = db.flows.getSteps(flow.id);
    for (const step of steps) {
      const interaction = db.interactions.getById(step.interactionId);
      if (!interaction) {
        issues.push({
          severity: 'error',
          category: 'dangling-interaction',
          message: `Flow '${flow.name}' (id=${flow.id}) step ${step.stepOrder} references non-existent interaction ${step.interactionId}`,
        });
        structuralIssueCount++;
      }
    }
  }

  // Check 4 — duplicate-slug: Multiple flows share the same slug
  const slugCounts = new Map<string, number[]>();
  for (const flow of allFlows) {
    const ids = slugCounts.get(flow.slug) ?? [];
    ids.push(flow.id);
    slugCounts.set(flow.slug, ids);
  }
  for (const [slug, ids] of slugCounts) {
    if (ids.length > 1) {
      issues.push({
        severity: 'warning',
        category: 'duplicate-slug',
        message: `Slug '${slug}' is shared by ${ids.length} flows (IDs: ${ids.join(', ')})`,
      });
    }
  }

  // Check 5 — uncovered-interactions: Interactions not covered by any flow (informational)
  const coveredInteractionIds = new Set<number>();
  for (const flow of allFlows) {
    const steps = db.flows.getSteps(flow.id);
    for (const step of steps) {
      coveredInteractionIds.add(step.interactionId);
    }
  }
  const allInteractions = db.interactions.getAll();
  const relevantInteractions = allInteractions.filter(isRuntimeInteraction);
  const uncovered = relevantInteractions.filter((i) => !coveredInteractionIds.has(i.id));
  if (uncovered.length > 0) {
    issues.push({
      severity: 'info',
      category: 'uncovered-interactions',
      message: `${uncovered.length}/${relevantInteractions.length} relevant interactions are not covered by any flow`,
    });
    for (const i of uncovered.slice(0, 20)) {
      issues.push({
        severity: 'info',
        category: 'uncovered-interactions',
        message: `  ${i.fromModulePath} → ${i.toModulePath}${i.semantic ? `: ${i.semantic}` : ''}`,
      });
    }
    if (uncovered.length > 20) {
      issues.push({
        severity: 'info',
        category: 'uncovered-interactions',
        message: `  ... and ${uncovered.length - 20} more`,
      });
    }
  }

  // Check 6 — broken-chain: consecutive steps where toModuleId doesn't connect to next step
  for (const flow of allFlows) {
    const steps = db.flows.getSteps(flow.id);
    if (steps.length < 2) continue;

    for (let i = 0; i < steps.length - 1; i++) {
      const currentInteraction = db.interactions.getById(steps[i].interactionId);
      const nextInteraction = db.interactions.getById(steps[i + 1].interactionId);
      if (!currentInteraction || !nextInteraction) continue; // Skip nulls (caught by dangling-interaction)

      const currentTo = currentInteraction.toModuleId;
      const nextFrom = nextInteraction.fromModuleId;
      const nextTo = nextInteraction.toModuleId;

      if (currentTo !== nextFrom && currentTo !== nextTo) {
        issues.push({
          severity: 'warning',
          category: 'broken-chain',
          message: `Flow '${flow.name}' (id=${flow.id}) has broken chain at step ${steps[i].stepOrder}→${steps[i + 1].stepOrder}: module #${currentTo} doesn't connect to next step`,
        });
      }
    }
  }

  // Check 7 — entry-mismatch: entry point module != first step's from module
  for (const flow of allFlows) {
    if (!flow.entryPointModuleId) continue;
    const steps = db.flows.getSteps(flow.id);
    if (steps.length === 0) continue;

    const firstInteraction = db.interactions.getById(steps[0].interactionId);
    if (!firstInteraction) continue;

    if (flow.entryPointModuleId !== firstInteraction.fromModuleId) {
      issues.push({
        severity: 'warning',
        category: 'entry-mismatch',
        message: `Flow '${flow.name}' (id=${flow.id}) entry module #${flow.entryPointModuleId} doesn't match first step's from module #${firstInteraction.fromModuleId}`,
      });
    }
  }

  // Check 8 — entry-not-in-module: entry point definition not a member of entry module
  for (const flow of allFlows) {
    if (!flow.entryPointId || !flow.entryPointModuleId) continue;
    const mod = moduleMap.get(flow.entryPointModuleId);
    if (!mod) continue;

    const isMember = mod.members.some((m) => m.definitionId === flow.entryPointId);
    if (!isMember) {
      issues.push({
        severity: 'error',
        category: 'entry-not-in-module',
        message: `Flow '${flow.name}' (id=${flow.id}) entry point definition #${flow.entryPointId} is not a member of entry module #${flow.entryPointModuleId}`,
        fixData: { action: 'null-entry-point', flowId: flow.id },
      });
      structuralIssueCount++;
    }
  }

  const passed = structuralIssueCount === 0;
  return {
    passed,
    issues,
    stats: {
      totalDefinitions: allFlows.length,
      annotatedDefinitions: allFlows.length - structuralIssueCount,
      totalRelationships: relevantInteractions.length,
      annotatedRelationships: coveredInteractionIds.size,
      missingCount: uncovered.length,
      structuralIssueCount,
    },
  };
}
