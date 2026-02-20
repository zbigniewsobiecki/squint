/**
 * Referential integrity checks: detect ghost rows referencing deleted entities.
 */

import type { IndexDatabase } from '../../../../db/database.js';
import type { CoverageCheckResult, VerificationIssue } from './verify-types.js';

/**
 * Check referential integrity: detect ghost rows referencing deleted entities.
 */
export function checkReferentialIntegrity(db: IndexDatabase): CoverageCheckResult {
  const issues: VerificationIssue[] = [];
  let structuralIssueCount = 0;

  const ghosts = db.findGhostRows();

  for (const g of ghosts.ghostRelationships) {
    issues.push({
      severity: 'error',
      category: 'ghost-relationship',
      message: `Relationship annotation #${g.id} references a deleted definition`,
      fixData: { action: 'remove-ghost', ghostTable: g.table, ghostRowId: g.id },
    });
    structuralIssueCount++;
  }

  for (const g of ghosts.ghostMembers) {
    issues.push({
      severity: 'error',
      category: 'ghost-member',
      message: `Module member for definition #${g.definitionId} references a deleted definition or module`,
      fixData: { action: 'remove-ghost', ghostTable: g.table, ghostRowId: g.definitionId },
    });
    structuralIssueCount++;
  }

  for (const g of ghosts.ghostEntryPoints) {
    issues.push({
      severity: 'error',
      category: 'ghost-entry-point',
      message: `Flow #${g.id} references a deleted entry point definition`,
      fixData: { action: 'remove-ghost', ghostTable: g.table, ghostRowId: g.id },
    });
    structuralIssueCount++;
  }

  for (const g of ghosts.ghostEntryModules) {
    issues.push({
      severity: 'error',
      category: 'ghost-entry-module',
      message: `Flow #${g.id} references a deleted entry point module`,
      fixData: { action: 'remove-ghost', ghostTable: g.table, ghostRowId: g.id },
    });
    structuralIssueCount++;
  }

  for (const g of ghosts.ghostInteractions) {
    issues.push({
      severity: 'error',
      category: 'ghost-interaction',
      message: `Interaction #${g.id} references a deleted module`,
      fixData: { action: 'remove-ghost', ghostTable: g.table, ghostRowId: g.id },
    });
    structuralIssueCount++;
  }

  for (const g of ghosts.ghostSubflows) {
    issues.push({
      severity: 'error',
      category: 'ghost-subflow',
      message: `Subflow step (rowid=${g.rowid}) references a deleted flow`,
      fixData: { action: 'remove-ghost', ghostTable: g.table, ghostRowId: g.rowid },
    });
    structuralIssueCount++;
  }

  const passed = structuralIssueCount === 0;
  return {
    passed,
    issues,
    stats: {
      totalDefinitions: 0,
      annotatedDefinitions: 0,
      totalRelationships: 0,
      annotatedRelationships: 0,
      missingCount: 0,
      structuralIssueCount,
    },
  };
}
