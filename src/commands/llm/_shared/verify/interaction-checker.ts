/**
 * Interaction quality checks: self-loops, missing import paths, symbol mismatches,
 * false bidirectionals, and ungrounded inferred interactions.
 */

import type { IndexDatabase } from '../../../../db/database.js';
import type { ProcessGroups } from '../process-utils.js';
import type { CoverageCheckResult, VerificationIssue } from './verify-types.js';

/**
 * Check interaction quality: self-loops, missing import paths, symbol mismatches,
 * false bidirectionals, and ungrounded inferred interactions.
 */
export function checkInteractionQuality(db: IndexDatabase, processGroups?: ProcessGroups): CoverageCheckResult {
  const issues: VerificationIssue[] = [];
  let structuralIssueCount = 0;

  const allInteractions = db.interactions.getAll();
  if (allInteractions.length === 0) {
    return {
      passed: true,
      issues: [],
      stats: {
        totalDefinitions: 0,
        annotatedDefinitions: 0,
        totalRelationships: 0,
        annotatedRelationships: 0,
        missingCount: 0,
        structuralIssueCount: 0,
      },
    };
  }

  // Build call graph edge set for O(1) lookups
  const callGraphEdges = new Set<string>();
  try {
    const moduleCallGraph = db.callGraph.getModuleCallGraph();
    for (const edge of moduleCallGraph) {
      callGraphEdges.add(`${edge.fromModuleId}->${edge.toModuleId}`);
    }
  } catch {
    // Call graph may not be available
  }

  // Build module members lookup for symbol mismatch checks
  const allModulesWithMembers = db.modules.getAllWithMembers();
  const moduleMemberNames = new Map<number, Set<string>>();
  for (const mod of allModulesWithMembers) {
    moduleMemberNames.set(mod.id, new Set(mod.members.map((m) => m.name)));
  }

  // Helper to check if two modules are cross-process
  const isCrossProcess = (fromId: number, toId: number): boolean => {
    if (!processGroups) return false;
    const fromGroup = processGroups.moduleToGroup.get(fromId);
    const toGroup = processGroups.moduleToGroup.get(toId);
    if (fromGroup === undefined || toGroup === undefined) return false;
    return fromGroup !== toGroup;
  };

  // Build AST edge flow map for direction-implausible check (Check 8)
  // Map: "groupA->groupB" → count of AST edges from groupA to groupB
  const astFlowCounts = new Map<string, number>();
  if (processGroups) {
    for (const interaction of allInteractions) {
      if (interaction.source !== 'ast' && interaction.source !== 'ast-import') continue;
      const fromGroup = processGroups.moduleToGroup.get(interaction.fromModuleId);
      const toGroup = processGroups.moduleToGroup.get(interaction.toModuleId);
      if (fromGroup === undefined || toGroup === undefined) continue;
      if (fromGroup === toGroup) continue;
      const key = `${fromGroup}->${toGroup}`;
      astFlowCounts.set(key, (astFlowCounts.get(key) ?? 0) + 1);
    }
  }

  for (const interaction of allInteractions) {
    // Check 1: self-loop-interaction
    if (interaction.fromModuleId === interaction.toModuleId) {
      issues.push({
        severity: 'error',
        category: 'self-loop-interaction',
        message: `Interaction #${interaction.id} is a self-loop: ${interaction.fromModulePath} → ${interaction.toModulePath}`,
        fixData: { action: 'remove-interaction', interactionId: interaction.id },
      });
      structuralIssueCount++;
      continue; // Skip other checks for self-loops
    }

    // Check 2: no-import-path (for AST/import-based interactions)
    if (interaction.source === 'ast' || interaction.source === 'ast-import') {
      try {
        const hasImport = db.interactions.hasModuleImportPath(interaction.fromModuleId, interaction.toModuleId);
        if (!hasImport) {
          issues.push({
            severity: 'warning',
            category: 'no-import-path',
            message: `Interaction #${interaction.id} (${interaction.fromModulePath} → ${interaction.toModulePath}) has source '${interaction.source}' but no import path exists`,
          });
        }
      } catch {
        // Skip if query fails
      }
    }

    // Check 3: interaction-symbol-mismatch
    if (interaction.symbols) {
      try {
        const symbolNames: string[] =
          typeof interaction.symbols === 'string' ? JSON.parse(interaction.symbols) : interaction.symbols;
        const targetMembers = moduleMemberNames.get(interaction.toModuleId);
        if (targetMembers && symbolNames.length > 0) {
          const mismatched = symbolNames.filter((s) => !targetMembers.has(s));
          if (mismatched.length > 0 && mismatched.length === symbolNames.length) {
            issues.push({
              severity: 'warning',
              category: 'interaction-symbol-mismatch',
              message: `Interaction #${interaction.id} (${interaction.fromModulePath} → ${interaction.toModulePath}): all ${symbolNames.length} symbols not found in target module`,
              fixData: { action: 'rebuild-symbols', interactionId: interaction.id },
            });
          }
        }
      } catch {
        // JSON parse error — skip
      }
    }

    // Check 4: false-bidirectional
    if (interaction.direction === 'bi') {
      const reverseKey = `${interaction.toModuleId}->${interaction.fromModuleId}`;
      if (!callGraphEdges.has(reverseKey)) {
        issues.push({
          severity: 'warning',
          category: 'false-bidirectional',
          message: `Interaction #${interaction.id} (${interaction.fromModulePath} → ${interaction.toModulePath}) is 'bi' but no reverse call graph edge exists`,
          fixData: { action: 'set-direction-uni', interactionId: interaction.id },
        });
      }
    }

    // Check 5: ungrounded-inferred (process-aware)
    if (interaction.source === 'llm-inferred') {
      // Skip check for cross-process interactions — they're expected to have no static evidence
      if (!isCrossProcess(interaction.fromModuleId, interaction.toModuleId)) {
        const forwardKey = `${interaction.fromModuleId}->${interaction.toModuleId}`;
        const hasCallEdge = callGraphEdges.has(forwardKey);
        let hasImport = false;
        try {
          hasImport = db.interactions.hasModuleImportPath(interaction.fromModuleId, interaction.toModuleId);
        } catch {
          // Skip
        }

        if (!hasCallEdge && !hasImport) {
          issues.push({
            severity: 'warning',
            category: 'ungrounded-inferred',
            message: `Interaction #${interaction.id} (${interaction.fromModulePath} → ${interaction.toModulePath}) is 'llm-inferred' with no import path and no call graph edge`,
            fixData: { action: 'remove-interaction', interactionId: interaction.id },
          });
        }
      }
    }

    // Check 8: direction-implausible (for llm-inferred cross-process interactions)
    if (interaction.source === 'llm-inferred' && processGroups) {
      const fromGroup = processGroups.moduleToGroup.get(interaction.fromModuleId);
      const toGroup = processGroups.moduleToGroup.get(interaction.toModuleId);

      if (fromGroup !== undefined && toGroup !== undefined && fromGroup !== toGroup) {
        const forwardKey = `${fromGroup}->${toGroup}`;
        const reverseKey = `${toGroup}->${fromGroup}`;
        const forwardCount = astFlowCounts.get(forwardKey) ?? 0;
        const reverseCount = astFlowCounts.get(reverseKey) ?? 0;

        // Flag if AST edges only flow in the reverse direction
        if (forwardCount === 0 && reverseCount > 0) {
          issues.push({
            severity: 'warning',
            category: 'direction-implausible',
            message: `Interaction #${interaction.id} (${interaction.fromModulePath} → ${interaction.toModulePath}) goes against AST edge flow (${reverseCount} AST edges flow in reverse, 0 forward)`,
            fixData: { action: 'remove-interaction', interactionId: interaction.id },
          });
        }
      }
    }
  }

  // Check 6: fan-in-anomaly
  try {
    const anomalies = db.interactionAnalysis.detectFanInAnomalies();
    for (const anomaly of anomalies) {
      // Get all llm-inferred interactions targeting this module
      const inferredToModule = allInteractions.filter(
        (i) => i.toModuleId === anomaly.moduleId && i.source === 'llm-inferred'
      );
      for (const interaction of inferredToModule) {
        issues.push({
          severity: 'warning',
          category: 'fan-in-anomaly',
          message: `Interaction #${interaction.id} (${interaction.fromModulePath} → ${anomaly.modulePath}) targets a fan-in anomaly (${anomaly.llmFanIn} LLM inbound, ${anomaly.astFanIn} AST inbound)`,
          fixData: { action: 'remove-inferred-to-module', targetModuleId: anomaly.moduleId },
        });
      }
    }
  } catch {
    // Skip if analysis fails
  }

  const passed = structuralIssueCount === 0;
  return {
    passed,
    issues,
    stats: {
      totalDefinitions: allInteractions.length,
      annotatedDefinitions: allInteractions.length - structuralIssueCount,
      totalRelationships: 0,
      annotatedRelationships: 0,
      missingCount: 0,
      structuralIssueCount,
    },
  };
}
