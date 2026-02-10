/**
 * Phase 1: Deterministic coverage and structural checks (no LLM required).
 */

import fs from 'node:fs';
import type { IndexDatabase } from '../../../../db/database.js';
import type { CoverageCheckResult, VerificationIssue } from './verify-types.js';

/**
 * Check annotation coverage for the given aspects.
 * Reports missing annotations as issues.
 */
export function checkAnnotationCoverage(db: IndexDatabase, aspects: string[]): CoverageCheckResult {
  const issues: VerificationIssue[] = [];
  let missingCount = 0;

  const totalDefinitions = db.getDefinitionCount();
  let annotatedDefinitions = totalDefinitions;

  for (const aspect of aspects) {
    const missingIds = db.getDefinitionsWithoutMetadata(aspect);
    if (missingIds.length > 0) {
      annotatedDefinitions = Math.min(annotatedDefinitions, totalDefinitions - missingIds.length);
      missingCount += missingIds.length;
      // Report first 50 missing as individual issues
      for (const defId of missingIds.slice(0, 50)) {
        const def = db.getDefinitionById(defId);
        if (def) {
          issues.push({
            definitionId: defId,
            definitionName: def.name,
            filePath: def.filePath,
            line: def.line,
            severity: 'error',
            category: 'missing-annotation',
            message: `Missing '${aspect}' annotation`,
          });
        }
      }
      if (missingIds.length > 50) {
        issues.push({
          severity: 'info',
          category: 'missing-annotation',
          message: `... and ${missingIds.length - 50} more definitions missing '${aspect}'`,
        });
      }
    }
  }

  // Get relationship counts
  let totalRelationships = 0;
  let annotatedRelationships = 0;
  try {
    annotatedRelationships = db.getRelationshipAnnotationCount();
    const unannotated = db.getUnannotatedRelationshipCount();
    totalRelationships = annotatedRelationships + unannotated;
  } catch {
    // Table doesn't exist
  }

  const passed = missingCount === 0;
  return {
    passed,
    issues,
    stats: {
      totalDefinitions,
      annotatedDefinitions: totalDefinitions - missingCount,
      totalRelationships,
      annotatedRelationships,
      missingCount,
      structuralIssueCount: 0,
    },
  };
}

/**
 * Check relationship coverage and structural issues.
 */
export function checkRelationshipCoverage(db: IndexDatabase): CoverageCheckResult {
  const issues: VerificationIssue[] = [];
  let structuralIssueCount = 0;

  // Count unannotated relationships
  let annotatedRelationships = 0;
  let unannotatedCount = 0;
  try {
    annotatedRelationships = db.getRelationshipAnnotationCount();
    unannotatedCount = db.getUnannotatedRelationshipCount();
  } catch {
    // Table doesn't exist
  }
  const totalRelationships = annotatedRelationships + unannotatedCount;

  if (unannotatedCount > 0) {
    issues.push({
      severity: 'error',
      category: 'unannotated-relationship',
      message: `${unannotatedCount} relationships have no annotation`,
    });
  }

  // Duplicate target detection: extends/implements where same (from_id, type) links to multiple to_ids with same name
  try {
    const allRels = db.getAllRelationshipAnnotations({ limit: 100000 });
    const byFromAndType = new Map<string, Array<{ toId: number; toName: string }>>();

    for (const rel of allRels) {
      if (rel.relationshipType === 'extends' || rel.relationshipType === 'implements') {
        const key = `${rel.fromDefinitionId}:${rel.relationshipType}`;
        if (!byFromAndType.has(key)) byFromAndType.set(key, []);
        byFromAndType.get(key)!.push({ toId: rel.toDefinitionId, toName: rel.toName });
      }
    }

    for (const [key, targets] of byFromAndType) {
      // Check if multiple targets share the same name (cartesian product error)
      const nameGroups = new Map<string, number[]>();
      for (const t of targets) {
        if (!nameGroups.has(t.toName)) nameGroups.set(t.toName, []);
        nameGroups.get(t.toName)!.push(t.toId);
      }

      for (const [name, ids] of nameGroups) {
        if (ids.length > 1) {
          const [fromIdStr, relType] = key.split(':');
          issues.push({
            severity: 'error',
            category: 'duplicate-target',
            message: `Definition #${fromIdStr} has ${ids.length} '${relType}' relationships to different definitions named '${name}' (IDs: ${ids.join(', ')})`,
            suggestion: 'This is likely a cartesian product error — only one target should exist',
          });
          structuralIssueCount++;
        }
      }
    }
  } catch {
    // Table doesn't exist
  }

  // Stale file detection
  try {
    const allFiles = db.getAllFiles();
    for (const file of allFiles) {
      try {
        fs.accessSync(file.path);
      } catch {
        issues.push({
          filePath: file.path,
          severity: 'warning',
          category: 'stale-file',
          message: `File no longer exists on disk: ${file.path}`,
          suggestion: 'Use --fix to remove stale file entries',
        });
        structuralIssueCount++;
      }
    }
  } catch {
    // Files table doesn't exist
  }

  // Missing extends: definitions where extends_name is set but no extends relationship exists
  try {
    const allDefs = db.getAllDefinitions();
    for (const def of allDefs) {
      if (!def.extendsName) continue;

      const relsFrom = db.getRelationshipsFrom(def.id);
      const hasExtendsRel = relsFrom.some((r) => r.relationshipType === 'extends');

      if (!hasExtendsRel) {
        const fullDef = db.getDefinitionById(def.id);
        issues.push({
          definitionId: def.id,
          definitionName: def.name,
          filePath: fullDef?.filePath,
          line: def.line,
          severity: 'warning',
          category: 'missing-extends',
          message: `Definition '${def.name}' has extends_name='${def.extendsName}' but no 'extends' relationship annotation`,
          suggestion: 'The target class may not be indexed, or the extends clause uses unsupported syntax',
        });
        structuralIssueCount++;
      }
    }
  } catch {
    // Ignore errors
  }

  const totalDefinitions = db.getDefinitionCount();
  const passed = unannotatedCount === 0 && structuralIssueCount === 0;

  return {
    passed,
    issues,
    stats: {
      totalDefinitions,
      annotatedDefinitions: totalDefinitions,
      totalRelationships,
      annotatedRelationships,
      missingCount: unannotatedCount,
      structuralIssueCount,
    },
  };
}
