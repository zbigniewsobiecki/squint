/**
 * Phase 2: LLM-powered content verification of annotations and relationships.
 */

import type { Command } from '@oclif/core';
import type { IndexDatabase } from '../../../../db/database.js';
import { readSourceAsString } from '../../../_shared/index.js';
import type { LlmContext } from '../base-llm-command.js';
import { parseCsvWithMapper, safeParseInt } from '../csv-utils.js';
import { completeWithLogging } from '../llm-utils.js';
import { isTestFile } from '../module-prompts.js';
import {
  buildAnnotationVerifySystemPrompt,
  buildAnnotationVerifyUserPrompt,
  buildModuleAssignmentVerifySystemPrompt,
  buildModuleAssignmentVerifyUserPrompt,
  buildRelationshipVerifySystemPrompt,
  buildRelationshipVerifyUserPrompt,
} from './verify-prompts.js';
import type { ContentVerificationResult, VerificationIssue, VerifySeverity } from './verify-types.js';

interface VerifyFlags {
  'batch-size': number;
  'max-iterations': number;
}

/**
 * Parse the verification CSV response (definition_id,check,verdict,reason).
 */
export function parseAnnotationVerifyCsv(
  content: string
): Array<{ definitionId: number; check: string; verdict: string; reason: string }> {
  const { items } = parseCsvWithMapper(content, {
    minColumns: 4,
    rowMapper: (cols, lineNum, errors) => {
      const definitionId = safeParseInt(cols[0], 'definitionId', lineNum, errors);
      if (definitionId === null) return null;
      return {
        definitionId,
        check: cols[1],
        verdict: cols[2].toLowerCase(),
        reason: cols[3],
      };
    },
  });
  return items;
}

/**
 * Parse the relationship verification CSV response (from_id,to_id,verdict,reason).
 */
export function parseRelationshipVerifyCsv(
  content: string
): Array<{ fromId: number; toId: number; verdict: string; reason: string }> {
  const { items } = parseCsvWithMapper(content, {
    minColumns: 4,
    rowMapper: (cols, lineNum, errors) => {
      const fromId = safeParseInt(cols[0], 'from_id', lineNum, errors);
      const toId = safeParseInt(cols[1], 'to_id', lineNum, errors);
      if (fromId === null || toId === null) return null;
      return {
        fromId,
        toId,
        verdict: cols[2].toLowerCase(),
        reason: cols[3],
      };
    },
  });
  return items;
}

export function verdictToSeverity(verdict: string): VerifySeverity | null {
  if (verdict === 'wrong') return 'error';
  if (verdict === 'suspect') return 'warning';
  return null; // correct — no issue
}

/**
 * Verify annotation content using LLM (Phase 2).
 */
export async function verifyAnnotationContent(
  db: IndexDatabase,
  ctx: LlmContext,
  command: Command,
  flags: VerifyFlags,
  aspects: string[]
): Promise<ContentVerificationResult> {
  const issues: VerificationIssue[] = [];
  const batchSize = flags['batch-size'];
  const maxIterations = flags['max-iterations'];
  const systemPrompt = buildAnnotationVerifySystemPrompt();

  // Get all definitions that have all aspects annotated
  const allDefIds = db.metadata.getDefinitionsWith(aspects[0]);
  // Filter to those that have all aspects
  const fullyAnnotatedIds = allDefIds.filter((id) => {
    const meta = db.metadata.get(id);
    return aspects.every((a) => a in meta);
  });

  let checked = 0;
  let batchesProcessed = 0;

  for (let offset = 0; offset < fullyAnnotatedIds.length; offset += batchSize) {
    if (maxIterations > 0 && batchesProcessed >= maxIterations) break;

    const batchIds = fullyAnnotatedIds.slice(offset, offset + batchSize);
    const symbolsForPrompt: Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      endLine: number;
      sourceCode: string;
      annotations: Record<string, string>;
    }> = [];

    for (const defId of batchIds) {
      const def = db.definitions.getById(defId);
      if (!def) continue;

      const sourceCode = await readSourceAsString(db.resolveFilePath(def.filePath), def.line, def.endLine);
      const annotations = db.metadata.get(defId);

      symbolsForPrompt.push({
        id: defId,
        name: def.name,
        kind: def.kind,
        filePath: def.filePath,
        line: def.line,
        endLine: def.endLine,
        sourceCode,
        annotations,
      });
    }

    if (symbolsForPrompt.length === 0) continue;

    const userPrompt = buildAnnotationVerifyUserPrompt(symbolsForPrompt, aspects);

    try {
      const response = await completeWithLogging({
        model: ctx.model,
        systemPrompt,
        userPrompt,
        temperature: 0,
        command,
        isJson: ctx.isJson,
        iteration: { current: batchesProcessed + 1, max: maxIterations },
      });

      const parsed = parseAnnotationVerifyCsv(response);
      for (const row of parsed) {
        const severity = verdictToSeverity(row.verdict);
        if (!severity) continue; // correct, skip

        const def = db.definitions.getById(row.definitionId);
        issues.push({
          definitionId: row.definitionId,
          definitionName: def?.name,
          filePath: def?.filePath,
          line: def?.line,
          severity,
          category: `wrong-${row.check}`,
          message: `${row.check}: ${row.reason}`,
          fixData:
            severity === 'error'
              ? {
                  action: 'reannotate-definition' as const,
                  reason: row.reason,
                }
              : undefined,
        });
      }
    } catch {
      // LLM error, continue to next batch
    }

    checked += symbolsForPrompt.length;
    batchesProcessed++;
  }

  return {
    issues,
    stats: {
      checked,
      issuesFound: issues.length,
      batchesProcessed,
    },
  };
}

/**
 * Verify relationship content using LLM (Phase 2).
 */
export async function verifyRelationshipContent(
  db: IndexDatabase,
  ctx: LlmContext,
  command: Command,
  flags: VerifyFlags
): Promise<ContentVerificationResult> {
  const issues: VerificationIssue[] = [];
  const batchSize = flags['batch-size'];
  const maxIterations = flags['max-iterations'];
  const systemPrompt = buildRelationshipVerifySystemPrompt();

  // Get all annotated relationships (including PENDING — they'll be caught by Phase 1 deterministically
  // and also verified here if they somehow survive fixing)
  const allRels = db.relationships.getAll({ limit: 100000 });
  const annotatedRels = allRels;

  // Group by source definition
  const byFromId = new Map<number, typeof annotatedRels>();
  for (const rel of annotatedRels) {
    if (!byFromId.has(rel.fromDefinitionId)) byFromId.set(rel.fromDefinitionId, []);
    byFromId.get(rel.fromDefinitionId)!.push(rel);
  }

  const sourceIds = [...byFromId.keys()];
  let checked = 0;
  let batchesProcessed = 0;

  for (let offset = 0; offset < sourceIds.length; offset += batchSize) {
    if (maxIterations > 0 && batchesProcessed >= maxIterations) break;

    const batchSourceIds = sourceIds.slice(offset, offset + batchSize);
    const groupsForPrompt: Array<{
      fromId: number;
      fromName: string;
      fromKind: string;
      filePath: string;
      sourceCode: string;
      relationships: Array<{
        toId: number;
        toName: string;
        toKind: string;
        semantic: string;
        relationshipType: string;
      }>;
    }> = [];

    for (const fromId of batchSourceIds) {
      const def = db.definitions.getById(fromId);
      if (!def) continue;

      const sourceCode = await readSourceAsString(db.resolveFilePath(def.filePath), def.line, def.endLine);
      const rels = byFromId.get(fromId) || [];

      groupsForPrompt.push({
        fromId,
        fromName: def.name,
        fromKind: def.kind,
        filePath: def.filePath,
        sourceCode,
        relationships: rels.map((r) => ({
          toId: r.toDefinitionId,
          toName: r.toName,
          toKind: r.toKind,
          semantic: r.semantic,
          relationshipType: r.relationshipType || 'uses',
        })),
      });
    }

    if (groupsForPrompt.length === 0) continue;

    const userPrompt = buildRelationshipVerifyUserPrompt(groupsForPrompt);

    try {
      const response = await completeWithLogging({
        model: ctx.model,
        systemPrompt,
        userPrompt,
        temperature: 0,
        command,
        isJson: ctx.isJson,
        iteration: { current: batchesProcessed + 1, max: maxIterations },
      });

      const parsed = parseRelationshipVerifyCsv(response);
      for (const row of parsed) {
        const severity = verdictToSeverity(row.verdict);
        if (!severity) continue;

        const fromDef = db.definitions.getById(row.fromId);
        const toDef = db.definitions.getById(row.toId);
        issues.push({
          definitionId: row.fromId,
          definitionName: fromDef?.name,
          filePath: fromDef?.filePath,
          line: fromDef?.line,
          severity,
          category: 'wrong-relationship',
          message: `${fromDef?.name || row.fromId} → ${toDef?.name || row.toId}: ${row.reason}`,
          fixData:
            severity === 'error'
              ? {
                  action: 'reannotate-relationship' as const,
                  targetDefinitionId: row.toId,
                  reason: row.reason,
                }
              : undefined,
        });
      }
    } catch {
      // LLM error, continue to next batch
    }

    checked += groupsForPrompt.reduce((sum, g) => sum + g.relationships.length, 0);
    batchesProcessed++;
  }

  return {
    issues,
    stats: {
      checked,
      issuesFound: issues.length,
      batchesProcessed,
    },
  };
}

/**
 * Parse the module assignment verification CSV response (definition_id,verdict,reason,suggested_module_path).
 */
export function parseModuleAssignmentVerifyCsv(
  content: string
): Array<{ definitionId: number; verdict: string; reason: string; suggestedModulePath: string | null }> {
  const { items } = parseCsvWithMapper(content, {
    minColumns: 3,
    rowMapper: (cols, lineNum, errors) => {
      const definitionId = safeParseInt(cols[0], 'definition_id', lineNum, errors);
      if (definitionId === null) return null;
      return {
        definitionId,
        verdict: cols[1].toLowerCase(),
        reason: cols[2],
        suggestedModulePath: cols[3] ? cols[3].trim() : null,
      };
    },
  });
  return items;
}

/**
 * Verify module assignment content using LLM (Phase 2).
 */
export async function verifyModuleAssignmentContent(
  db: IndexDatabase,
  ctx: LlmContext,
  command: Command,
  flags: VerifyFlags
): Promise<ContentVerificationResult> {
  const issues: VerificationIssue[] = [];
  const batchSize = flags['batch-size'];
  const maxIterations = flags['max-iterations'];
  const systemPrompt = buildModuleAssignmentVerifySystemPrompt();

  // Get all assigned definitions (with their module info)
  const allModulesWithMembers = db.modules.getAllWithMembers();
  const testModuleIds = db.modules.getTestModuleIds();

  // Flatten to (definition, module) pairs, skip test modules and test files
  const assignments: Array<{
    defId: number;
    defName: string;
    defKind: string;
    filePath: string;
    moduleId: number;
    moduleName: string;
    modulePath: string;
  }> = [];

  for (const mod of allModulesWithMembers) {
    if (testModuleIds.has(mod.id)) continue;
    for (const member of mod.members) {
      if (isTestFile(member.filePath)) continue;
      assignments.push({
        defId: member.definitionId,
        defName: member.name,
        defKind: member.kind,
        filePath: member.filePath,
        moduleId: mod.id,
        moduleName: mod.name,
        modulePath: mod.fullPath,
      });
    }
  }

  let checked = 0;
  let batchesProcessed = 0;

  for (let offset = 0; offset < assignments.length; offset += batchSize) {
    if (maxIterations > 0 && batchesProcessed >= maxIterations) break;

    const batch = assignments.slice(offset, offset + batchSize);
    const itemsForPrompt: Array<{
      defId: number;
      defName: string;
      defKind: string;
      filePath: string;
      sourceCode: string;
      moduleName: string;
      modulePath: string;
    }> = [];

    for (const item of batch) {
      const def = db.definitions.getById(item.defId);
      if (!def) continue;
      const sourceCode = await readSourceAsString(db.resolveFilePath(item.filePath), def.line, def.endLine);
      itemsForPrompt.push({ ...item, sourceCode });
    }

    if (itemsForPrompt.length === 0) continue;

    // Get module tree for context
    const modules = db.modules.getAll();
    const userPrompt = buildModuleAssignmentVerifyUserPrompt(itemsForPrompt, modules);

    try {
      const response = await completeWithLogging({
        model: ctx.model,
        systemPrompt,
        userPrompt,
        temperature: 0,
        command,
        isJson: ctx.isJson,
        iteration: { current: batchesProcessed + 1, max: maxIterations },
      });

      const parsed = parseModuleAssignmentVerifyCsv(response);
      for (const row of parsed) {
        const severity = verdictToSeverity(row.verdict);
        if (!severity) continue;

        const matchedItem = batch.find((b) => b.defId === row.definitionId);
        // Resolve suggested module path to an ID
        let suggestedModuleId: number | undefined;
        if (row.suggestedModulePath) {
          const targetMod = db.modules.getByPath(row.suggestedModulePath);
          if (targetMod) suggestedModuleId = targetMod.id;
        }

        issues.push({
          definitionId: row.definitionId,
          definitionName: matchedItem?.defName,
          filePath: matchedItem?.filePath,
          line: undefined,
          severity,
          category: 'wrong-module-assignment',
          message: row.reason,
          fixData:
            severity === 'error'
              ? {
                  action: 'reassign-module' as const,
                  reason: row.reason,
                  targetModuleId: suggestedModuleId,
                }
              : undefined,
        });
      }
    } catch {
      // LLM error, continue
    }

    checked += itemsForPrompt.length;
    batchesProcessed++;
  }

  return { issues, stats: { checked, issuesFound: issues.length, batchesProcessed } };
}
