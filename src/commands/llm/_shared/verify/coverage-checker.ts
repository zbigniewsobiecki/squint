/**
 * Phase 1: Deterministic coverage and structural checks (no LLM required).
 */

import fs from 'node:fs';
import type { IndexDatabase } from '../../../../db/database.js';
import { detectImpurePatterns } from '../pure-check.js';
import type { CoverageCheckResult, VerificationIssue } from './verify-types.js';

/**
 * Read source lines from a file synchronously (for use in non-async verification).
 */
function readSourceSync(filePath: string, startLine: number, endLine: number): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  } catch {
    return '';
  }
}

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

  // Check for suspicious pure:true annotations
  if (aspects.includes('pure')) {
    const pureIssues = checkPureAnnotations(db);
    issues.push(...pureIssues);
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
 * Check for suspicious pure:true annotations using deterministic pattern detection.
 */
function checkPureAnnotations(db: IndexDatabase): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  // Get all definitions that have pure = "true"
  const pureTrueIds = db.getDefinitionsWithMetadata('pure');

  for (const defId of pureTrueIds) {
    const pureValue = db.getDefinitionMetadataValue(defId, 'pure');
    if (pureValue !== 'true') continue;

    const def = db.getDefinitionById(defId);
    if (!def) continue;

    // Skip types that are inherently pure
    if (def.kind === 'interface' || def.kind === 'type' || def.kind === 'enum') continue;

    try {
      const source = readSourceSync(def.filePath, def.line, def.endLine);
      if (!source) continue;
      const impureReasons = detectImpurePatterns(source);
      if (impureReasons.length > 0) {
        issues.push({
          definitionId: def.id,
          definitionName: def.name,
          filePath: def.filePath,
          line: def.line,
          severity: 'warning',
          category: 'suspect-pure',
          message: `'${def.name}' marked pure but source contains: ${impureReasons[0]}`,
          suggestion: 'Consider changing pure to "false"',
        });
      }
    } catch {
      // File not readable — skip
    }
  }

  return issues;
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

  // Relationship type mismatch detection
  try {
    const typeMismatchIssues = checkRelationshipTypeMismatches(db);
    issues.push(...typeMismatchIssues);
    structuralIssueCount += typeMismatchIssues.length;
  } catch {
    // Ignore errors
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

/**
 * Detect relationship type mismatches: relationships marked as 'uses' that should be 'extends' or 'implements'.
 *
 * Tier 1 — Column-based: checks definitions with extends_name/implements_names/extends_interfaces
 *   against relationship_annotations marked as 'uses' targeting those same definitions.
 * Tier 2 — Source-code regex: for definitions with inheritance columns, checks source code
 *   for extends/implements keywords targeting relationship targets.
 */
function checkRelationshipTypeMismatches(db: IndexDatabase): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  const allDefs = db.getAllDefinitions();

  for (const def of allDefs) {
    // Get full definition details (includes implementsNames, extendsInterfaces)
    const fullDef = db.getDefinitionById(def.id);
    if (!fullDef) continue;

    // Collect all inheritance target names
    const extendsNames = new Set<string>();
    const implementsNames = new Set<string>();

    if (fullDef.extendsName) {
      extendsNames.add(fullDef.extendsName);
    }
    if (fullDef.extendsInterfaces) {
      for (const name of fullDef.extendsInterfaces) {
        extendsNames.add(name);
      }
    }
    if (fullDef.implementsNames) {
      for (const name of fullDef.implementsNames) {
        implementsNames.add(name);
      }
    }

    // Skip if no inheritance
    if (extendsNames.size === 0 && implementsNames.size === 0) continue;

    // Get all relationships from this definition
    const relsFrom = db.getRelationshipsFrom(def.id);

    for (const rel of relsFrom) {
      if (rel.relationshipType !== 'uses') continue;

      // Tier 1: check if target name matches a known inheritance target
      let expectedType: 'extends' | 'implements' | null = null;

      if (extendsNames.has(rel.toName)) {
        expectedType = 'extends';
      } else if (implementsNames.has(rel.toName)) {
        expectedType = 'implements';
      }

      if (expectedType) {
        issues.push({
          definitionId: def.id,
          definitionName: def.name,
          filePath: fullDef.filePath,
          line: def.line,
          severity: 'warning',
          category: 'wrong-relationship-type',
          message: `'${def.name}' → '${rel.toName}' is type 'uses' but should be '${expectedType}' (based on definition columns)`,
          suggestion: `Use --fix to change relationship type to '${expectedType}'`,
        });
      }
    }
  }

  return issues;
}
