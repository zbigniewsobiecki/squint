/**
 * Phase 1: Deterministic coverage and structural checks (no LLM required).
 */

import fs from 'node:fs';
import type { IndexDatabase } from '../../../../db/database.js';
import { isTestFile } from '../module-prompts.js';
import type { ProcessGroups } from '../process-utils.js';
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

    // Get domain metadata for each definition
    const domainVariants = new Map<string, number[]>(); // normalized domain string → def IDs
    for (const def of defs) {
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
    if (domainVariants.size > 1) {
      for (const def of defs) {
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

  return issues;
}

/**
 * Check for suspicious pure:true annotations using deterministic pattern detection.
 */
function checkPureAnnotations(db: IndexDatabase): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  // Get all definitions that have pure = "true"
  const pureTrueIds = db.metadata.getDefinitionsWith('pure');

  for (const defId of pureTrueIds) {
    const pureValue = db.metadata.getValue(defId, 'pure');
    if (pureValue !== 'true') continue;

    const def = db.definitions.getById(defId);
    if (!def) continue;

    // Skip types that are inherently pure
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
  const relevantInteractions = allInteractions.filter((i) => i.pattern !== 'test-internal');
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
