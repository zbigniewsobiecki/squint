/**
 * Module assignment quality checks.
 */

import type { IndexDatabase } from '../../../../db/database.js';
import { isTestFile } from '../module-prompts.js';
import type { CoverageCheckResult, VerificationIssue } from './verify-types.js';

/**
 * Check module assignment quality: test symbols in production modules,
 * non-exported test symbols in shared modules.
 */
export function checkModuleAssignments(db: IndexDatabase): CoverageCheckResult {
  const issues: VerificationIssue[] = [];
  let structuralIssueCount = 0;

  const modules = db.modules.getAll();
  if (modules.length === 0) {
    return {
      passed: true,
      issues: [],
      stats: {
        totalDefinitions: db.definitions.getCount(),
        annotatedDefinitions: 0,
        totalRelationships: 0,
        annotatedRelationships: 0,
        missingCount: 0,
        structuralIssueCount: 0,
      },
    };
  }

  const testModuleIds = db.modules.getTestModuleIds();

  // Check 1: test-in-production — test file symbols assigned to non-test modules
  const allModulesWithMembers = db.modules.getAllWithMembers();
  for (const mod of allModulesWithMembers) {
    if (testModuleIds.has(mod.id)) continue; // production module check only

    for (const member of mod.members) {
      if (isTestFile(member.filePath)) {
        issues.push({
          definitionId: member.definitionId,
          definitionName: member.name,
          filePath: member.filePath,
          line: member.line,
          severity: 'warning',
          category: 'test-in-production',
          message: `Test symbol '${member.name}' from test file assigned to production module '${mod.fullPath}'`,
          suggestion: 'Move to a test module (project.testing.*)',
          fixData: { action: 'move-to-test-module' },
        });
        structuralIssueCount++;
      }
    }
  }

  // Check 2: non-exported test symbol in shared module
  // Flag non-exported symbols from test files assigned to modules that have
  // members from multiple different files (i.e. shared/infrastructure modules)
  for (const mod of allModulesWithMembers) {
    // Count distinct files in this module
    const distinctFiles = new Set(mod.members.map((m) => m.filePath));
    if (distinctFiles.size <= 1) continue; // single-file module is fine

    for (const member of mod.members) {
      if (isTestFile(member.filePath) && !member.isExported) {
        issues.push({
          definitionId: member.definitionId,
          definitionName: member.name,
          filePath: member.filePath,
          line: member.line,
          severity: 'info',
          category: 'non-exported-in-shared',
          message: `Non-exported test symbol '${member.name}' in shared module '${mod.fullPath}' (${distinctFiles.size} files)`,
          suggestion: 'File-local test symbols should not be in shared modules — assign to a general test module',
        });
      }
    }
  }

  // Check 3: unassigned-definition — definitions not assigned to any module (informational)
  try {
    const unassigned = db.modules.getUnassigned();
    if (unassigned.length > 0) {
      issues.push({
        severity: 'info',
        category: 'unassigned-definition',
        message: `${unassigned.length} definitions are not assigned to any module`,
      });
      for (const sym of unassigned.slice(0, 20)) {
        issues.push({
          definitionId: sym.id,
          definitionName: sym.name,
          filePath: sym.filePath,
          line: sym.line,
          severity: 'info',
          category: 'unassigned-definition',
          message: `  ${sym.name} (${sym.kind}) in ${sym.filePath}:${sym.line}`,
        });
      }
      if (unassigned.length > 20) {
        issues.push({
          severity: 'info',
          category: 'unassigned-definition',
          message: `  ... and ${unassigned.length - 20} more`,
        });
      }
    }
  } catch {
    // Ignore errors
  }

  const totalDefinitions = db.definitions.getCount();
  const passed = structuralIssueCount === 0;

  return {
    passed,
    issues,
    stats: {
      totalDefinitions,
      annotatedDefinitions: totalDefinitions,
      totalRelationships: 0,
      annotatedRelationships: 0,
      missingCount: 0,
      structuralIssueCount,
    },
  };
}
