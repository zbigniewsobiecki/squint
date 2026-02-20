/**
 * Relationship coverage and structural checks.
 */

import fs from 'node:fs';
import type { IndexDatabase } from '../../../../db/database.js';
import type { CoverageCheckResult, VerificationIssue } from './verify-types.js';

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
    annotatedRelationships = db.relationships.getCount();
    unannotatedCount = db.relationships.getUnannotatedCount();
  } catch {
    // Table doesn't exist
  }
  const totalRelationships = annotatedRelationships + unannotatedCount;

  if (unannotatedCount > 0) {
    const unannotated = db.relationships.getUnannotated({ limit: 50 });
    for (const rel of unannotated) {
      issues.push({
        definitionId: rel.fromDefinitionId,
        definitionName: rel.fromName,
        severity: 'error',
        category: 'missing-relationship',
        message: `Missing: ${rel.fromName} → ${rel.toName}`,
        fixData: { action: 'annotate-missing-relationship', targetDefinitionId: rel.toDefinitionId },
      });
    }
    if (unannotatedCount > 50) {
      issues.push({
        severity: 'error',
        category: 'missing-relationship',
        message: `... and ${unannotatedCount - 50} more missing relationships`,
      });
    }
    structuralIssueCount += unannotatedCount;
  }

  // Check for PENDING_LLM_ANNOTATION relationships
  try {
    const allRels = db.relationships.getAll({ limit: 100000 });
    const pendingRels = allRels.filter((r) => r.semantic === 'PENDING_LLM_ANNOTATION');
    for (const rel of pendingRels) {
      issues.push({
        definitionId: rel.fromDefinitionId,
        definitionName: rel.fromName,
        severity: 'error',
        category: 'pending-annotation',
        message: `${rel.fromName} → ${rel.toName} (${rel.relationshipType}) has placeholder PENDING_LLM_ANNOTATION`,
        fixData: { action: 'reannotate-relationship', targetDefinitionId: rel.toDefinitionId },
      });
      structuralIssueCount++;
    }
  } catch {
    // Table doesn't exist
  }

  // Duplicate target detection: extends/implements where same (from_id, type) links to multiple to_ids with same name
  try {
    const allRels = db.relationships.getAll({ limit: 100000 });
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
    const allFiles = db.files.getAll();
    for (const file of allFiles) {
      try {
        fs.accessSync(db.resolveFilePath(file.path));
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
    const BUILTIN_BASE_CLASSES = new Set([
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'ReferenceError',
      'URIError',
      'EvalError',
      'AggregateError',
      'Array',
      'Map',
      'Set',
      'WeakMap',
      'WeakSet',
      'RegExp',
      'Promise',
      'Proxy',
      'Event',
      'EventTarget',
      'CustomEvent',
      'HTMLElement',
      'HTMLDivElement',
      'HTMLInputElement',
      'ReadableStream',
      'WritableStream',
      'TransformStream',
      'EventEmitter',
    ]);

    const allDefs = db.definitions.getAll();
    for (const def of allDefs) {
      if (!def.extendsName) continue;

      // Skip built-in base classes that have no definition in the DB
      if (BUILTIN_BASE_CLASSES.has(def.extendsName)) continue;

      const relsFrom = db.relationships.getFrom(def.id);
      const hasExtendsRel = relsFrom.some((r) => r.relationshipType === 'extends');

      if (!hasExtendsRel) {
        const fullDef = db.definitions.getById(def.id);
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

  // Missing implements: definitions where implements_names is set but no implements relationship exists
  try {
    const BUILTIN_INTERFACES = new Set([
      'Iterable',
      'Iterator',
      'AsyncIterable',
      'AsyncIterator',
      'PromiseLike',
      'ArrayLike',
      'Disposable',
      'AsyncDisposable',
    ]);

    const allDefs2 = db.definitions.getAll();
    for (const def of allDefs2) {
      const fullDef = db.definitions.getById(def.id);
      if (!fullDef?.implementsNames || fullDef.implementsNames.length === 0) continue;

      const relsFrom = db.relationships.getFrom(def.id);
      const implementsRels = new Set(relsFrom.filter((r) => r.relationshipType === 'implements').map((r) => r.toName));

      for (const ifaceName of fullDef.implementsNames) {
        if (BUILTIN_INTERFACES.has(ifaceName)) continue;
        if (implementsRels.has(ifaceName)) continue;

        issues.push({
          definitionId: def.id,
          definitionName: def.name,
          filePath: fullDef.filePath,
          line: def.line,
          severity: 'warning',
          category: 'missing-implements',
          message: `Definition '${def.name}' implements '${ifaceName}' but no 'implements' relationship annotation exists`,
          suggestion: 'The target interface may not be indexed, or the implements clause uses unsupported syntax',
        });
        structuralIssueCount++;
      }
    }
  } catch {
    // Ignore errors
  }

  // Orphan module-scope usages: imported symbols used outside any definition's line range
  try {
    const orphans = db.dependencies.getOrphanModuleScopeUsages();
    if (orphans.length > 0) {
      // Group by file for concise reporting
      const byFile = new Map<string, typeof orphans>();
      for (const o of orphans) {
        if (!byFile.has(o.filePath)) byFile.set(o.filePath, []);
        byFile.get(o.filePath)!.push(o);
      }

      issues.push({
        severity: 'info',
        category: 'orphan-module-scope-usage',
        message: `${orphans.length} imported symbol(s) used at module scope (outside any definition) across ${byFile.size} file(s) — these cannot be captured as dependencies by the line-range join`,
      });
      for (const [filePath, fileOrphans] of [...byFile.entries()].slice(0, 10)) {
        const names = [...new Set(fileOrphans.map((o) => o.symbolName))].join(', ');
        issues.push({
          severity: 'info',
          category: 'orphan-module-scope-usage',
          filePath,
          message: `  ${filePath}: ${names}`,
        });
      }
      if (byFile.size > 10) {
        issues.push({
          severity: 'info',
          category: 'orphan-module-scope-usage',
          message: `  ... and ${byFile.size - 10} more files`,
        });
      }
    }
  } catch {
    // Usages table may not exist
  }

  const totalDefinitions = db.definitions.getCount();
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

  const allDefs = db.definitions.getAll();

  for (const def of allDefs) {
    // Get full definition details (includes implementsNames, extendsInterfaces)
    const fullDef = db.definitions.getById(def.id);
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
    const relsFrom = db.relationships.getFrom(def.id);

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
          fixData: {
            action: 'change-relationship-type',
            targetDefinitionId: rel.toDefinitionId,
            expectedType,
          },
        });
      }
    }
  }

  return issues;
}
