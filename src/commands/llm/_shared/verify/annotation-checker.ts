/**
 * Annotation coverage checks: missing annotations, pure-annotation validation,
 * domain consistency, and purpose-role mismatches.
 */

import fs from 'node:fs';
import path from 'node:path';
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

  const totalDefinitions = db.definitions.getCount();
  let annotatedDefinitions = totalDefinitions;

  for (const aspect of aspects) {
    const missingIds = db.metadata.getDefinitionsWithout(aspect);
    if (missingIds.length > 0) {
      annotatedDefinitions = Math.min(annotatedDefinitions, totalDefinitions - missingIds.length);
      missingCount += missingIds.length;
      // Report first 50 missing as individual issues
      for (const defId of missingIds.slice(0, 50)) {
        const def = db.definitions.getById(defId);
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

  // Check for inconsistent domain tags across same-named definitions
  if (aspects.includes('domain')) {
    const domainIssues = checkDomainConsistency(db);
    issues.push(...domainIssues);
  }

  // Check for purpose-role mismatches (when both purpose and role are present)
  if (aspects.includes('purpose') || (aspects.includes('purpose') && aspects.includes('role'))) {
    const purposeIssues = checkPurposeAnnotations(db);
    issues.push(...purposeIssues);
  }

  // Get relationship counts
  let totalRelationships = 0;
  let annotatedRelationships = 0;
  try {
    annotatedRelationships = db.relationships.getCount();
    const unannotated = db.relationships.getUnannotatedCount();
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
 * Check for inconsistent domain tags across definitions with the same name and kind.
 */
function checkDomainConsistency(db: IndexDatabase): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  const allDefs = db.definitions.getAll();

  // Group definitions by (name, kind)
  const groups = new Map<string, Array<{ id: number; name: string; kind: string; line: number }>>();
  for (const def of allDefs) {
    const key = `${def.name}::${def.kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ id: def.id, name: def.name, kind: def.kind, line: def.line });
  }

  for (const [, defs] of groups) {
    if (defs.length < 2) continue;

    // Sub-group by parent directory so definitions in unrelated directories are independent
    const byParentDir = new Map<string, typeof defs>();
    for (const def of defs) {
      const fullDef = db.definitions.getById(def.id);
      const dir = fullDef?.filePath ? path.dirname(fullDef.filePath) : '';
      const parentDir = path.dirname(dir);
      if (!byParentDir.has(parentDir)) byParentDir.set(parentDir, []);
      byParentDir.get(parentDir)!.push(def);
    }

    for (const [, subGroup] of byParentDir) {
      if (subGroup.length < 2) continue;

      // Get domain metadata for each definition
      const domainVariants = new Map<string, number[]>(); // normalized domain string → def IDs
      for (const def of subGroup) {
        const domainValue = db.metadata.getValue(def.id, 'domain');
        if (!domainValue) continue;
        try {
          const parsed = JSON.parse(domainValue) as string[];
          const normalized = JSON.stringify([...parsed].sort());
          if (!domainVariants.has(normalized)) domainVariants.set(normalized, []);
          domainVariants.get(normalized)!.push(def.id);
        } catch {
          // Skip unparseable domain values
        }
      }

      // If there are multiple distinct domain variants, flag inconsistency
      // Skip when every definition has a unique domain AND there are many (3+) — these are
      // likely independent symbols sharing a name (e.g., 4 different `router` exports in 4 files)
      const allUnique = domainVariants.size === subGroup.length;
      if (domainVariants.size > 1 && !(allUnique && subGroup.length > 2)) {
        for (const def of subGroup) {
          const domainValue = db.metadata.getValue(def.id, 'domain');
          if (!domainValue) continue;
          const fullDef = db.definitions.getById(def.id);
          issues.push({
            definitionId: def.id,
            definitionName: def.name,
            filePath: fullDef?.filePath,
            line: def.line,
            severity: 'warning',
            category: 'inconsistent-domain',
            message: `'${def.name}' (${def.kind}) has domain ${domainValue} — other definitions with same name have different domains`,
            fixData: { action: 'harmonize-domain' },
          });
        }
      }
    }
  }

  // Cross-directory same-name check: non-exported symbols with identical names AND
  // identical domains across different directories are likely mistagged (the logger pattern).
  const nameGroups = new Map<string, Array<{ id: number; name: string; filePath: string; isExported: boolean }>>();
  for (const def of allDefs) {
    if (!nameGroups.has(def.name)) nameGroups.set(def.name, []);
    const fullDef = db.definitions.getById(def.id);
    nameGroups.get(def.name)!.push({
      id: def.id,
      name: def.name,
      filePath: fullDef?.filePath ?? '',
      isExported: fullDef?.isExported ?? false,
    });
  }

  for (const [name, defs] of nameGroups) {
    // Only check non-exported symbols
    const nonExported = defs.filter((d) => !d.isExported);
    if (nonExported.length <= 5) continue;

    // Get domains for each
    const domainsByDef = new Map<number, string>();
    for (const def of nonExported) {
      const domainValue = db.metadata.getValue(def.id, 'domain');
      if (domainValue) domainsByDef.set(def.id, domainValue);
    }

    // Group by exact domain value
    const byDomain = new Map<string, number[]>();
    for (const [defId, domainValue] of domainsByDef) {
      try {
        const parsed = JSON.parse(domainValue) as string[];
        const normalized = JSON.stringify([...parsed].sort());
        if (!byDomain.has(normalized)) byDomain.set(normalized, []);
        byDomain.get(normalized)!.push(defId);
      } catch {
        // Skip
      }
    }

    for (const [domainStr, defIds] of byDomain) {
      if (defIds.length <= 5) continue;

      // Count distinct directories
      const dirs = new Set<string>();
      for (const defId of defIds) {
        const def = nonExported.find((d) => d.id === defId);
        if (def?.filePath) dirs.add(path.dirname(def.filePath));
      }

      if (dirs.size > 3) {
        for (const defId of defIds) {
          const def = nonExported.find((d) => d.id === defId);
          issues.push({
            definitionId: defId,
            definitionName: name,
            filePath: def?.filePath,
            severity: 'warning',
            category: 'mistagged-domain',
            message: `'${name}' in ${def?.filePath} shares domain ${domainStr} with ${defIds.length - 1} other '${name}' symbols across ${dirs.size} directories`,
            fixData: { action: 'reannotate-mistagged-domain' },
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Check for suspicious pure:true annotations using deterministic pattern detection.
 */
function checkPureAnnotations(db: IndexDatabase): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  // Get all definitions that have pure annotation
  const pureIds = db.metadata.getDefinitionsWith('pure');

  for (const defId of pureIds) {
    const pureValue = db.metadata.getValue(defId, 'pure');
    const def = db.definitions.getById(defId);
    if (!def) continue;

    // Check A: type/interface/enum marked pure=false → should be true
    if (pureValue === 'false' && (def.kind === 'type' || def.kind === 'interface' || def.kind === 'enum')) {
      issues.push({
        definitionId: def.id,
        definitionName: def.name,
        filePath: def.filePath,
        line: def.line,
        severity: 'warning',
        category: 'suspect-pure',
        message: `'${def.name}' (${def.kind}) marked pure=false but type-level declarations are always pure`,
        suggestion: 'Change pure to "true"',
        fixData: { action: 'set-pure-true' },
      });
      continue;
    }

    if (pureValue !== 'true') continue;

    // Check B: class marked pure=true — only flag if NOT an Error subclass
    if (def.kind === 'class') {
      const fullDef = db.definitions.getById(def.id);
      const isErrorSubclass =
        fullDef?.extendsName != null && (fullDef.extendsName === 'Error' || fullDef.extendsName.endsWith('Error'));
      if (!isErrorSubclass) {
        issues.push({
          definitionId: def.id,
          definitionName: def.name,
          filePath: def.filePath,
          line: def.line,
          severity: 'warning',
          category: 'suspect-pure',
          message: `'${def.name}' (class) marked pure=true but classes have mutable instances`,
          suggestion: 'Change pure to "false"',
          fixData: { action: 'set-pure-false' },
        });
      }
      continue;
    }

    // Skip types that are inherently pure (already handled above)
    if (def.kind === 'interface' || def.kind === 'type' || def.kind === 'enum') continue;

    try {
      const source = readSourceSync(db.resolveFilePath(def.filePath), def.line, def.endLine);
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
          fixData: { action: 'set-pure-false' },
        });
      }
    } catch {
      // File not readable — skip
    }

    // Gate 2: transitive impurity — check if any dependency has pure:false
    if (issues.every((i) => i.definitionId !== defId || i.category !== 'suspect-pure')) {
      try {
        const deps = db.dependencies.getWithMetadata(defId, 'pure');
        for (const dep of deps) {
          const depPure = db.metadata.getValue(dep.id, 'pure');
          if (depPure === 'false') {
            issues.push({
              definitionId: def.id,
              definitionName: def.name,
              filePath: def.filePath,
              line: def.line,
              severity: 'warning',
              category: 'suspect-pure',
              message: `'${def.name}' marked pure but depends on impure '${dep.name}'`,
              suggestion: 'Consider changing pure to "false"',
              fixData: { action: 'set-pure-false' },
            });
            break;
          }
        }
      } catch {
        // Ignore errors
      }
    }
  }

  return issues;
}

/**
 * Check for purpose-role mismatches: e.g., a definition with role "controller"
 * whose purpose says "business logic" instead of "HTTP handler" / "controller".
 */
function checkPurposeAnnotations(db: IndexDatabase): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  const allDefs = db.definitions.getAll();

  for (const def of allDefs) {
    const role = db.metadata.getValue(def.id, 'role');
    const purpose = db.metadata.getValue(def.id, 'purpose');
    if (!role || !purpose) continue;

    const roleLower = role.toLowerCase();
    const purposeLower = purpose.toLowerCase();

    // Controller/handler role but purpose says "business logic"
    if (
      (roleLower === 'controller' || roleLower === 'handler') &&
      purposeLower.includes('business logic') &&
      !purposeLower.includes('controller') &&
      !purposeLower.includes('handler') &&
      !purposeLower.includes('http')
    ) {
      const fullDef = db.definitions.getById(def.id);
      issues.push({
        definitionId: def.id,
        definitionName: def.name,
        filePath: fullDef?.filePath,
        line: def.line,
        severity: 'warning',
        category: 'purpose-role-mismatch',
        message: `'${def.name}' has role "${role}" but purpose describes "business logic" — controllers/handlers manage HTTP concerns, not business logic`,
        suggestion: 'Re-annotate purpose to reflect HTTP handler/controller role',
        fixData: { action: 'reannotate-definition' },
      });
    }

    // Service role but purpose says "HTTP handler" / "route handler"
    if (
      roleLower === 'service' &&
      (purposeLower.includes('http handler') || purposeLower.includes('route handler')) &&
      !purposeLower.includes('service') &&
      !purposeLower.includes('business')
    ) {
      const fullDef = db.definitions.getById(def.id);
      issues.push({
        definitionId: def.id,
        definitionName: def.name,
        filePath: fullDef?.filePath,
        line: def.line,
        severity: 'warning',
        category: 'purpose-role-mismatch',
        message: `'${def.name}' has role "${role}" but purpose describes HTTP handling — services contain business logic, not HTTP concerns`,
        suggestion: 'Re-annotate purpose to reflect service/business logic role',
        fixData: { action: 'reannotate-definition' },
      });
    }
  }

  return issues;
}
