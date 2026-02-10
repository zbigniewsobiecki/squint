/**
 * Phase 2: LLM-powered content verification of annotations and relationships.
 */

import type { Command } from '@oclif/core';
import type { IndexDatabase } from '../../../../db/database.js';
import { readSourceAsString } from '../../../_shared/index.js';
import type { LlmContext } from '../base-llm-command.js';
import { parseCsvWithMapper, safeParseInt } from '../csv-utils.js';
import { completeWithLogging } from '../llm-utils.js';
import {
  buildAnnotationVerifySystemPrompt,
  buildAnnotationVerifyUserPrompt,
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
  const allDefIds = db.getDefinitionsWithMetadata(aspects[0]);
  // Filter to those that have all aspects
  const fullyAnnotatedIds = allDefIds.filter((id) => {
    const meta = db.getDefinitionMetadata(id);
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
      const def = db.getDefinitionById(defId);
      if (!def) continue;

      const sourceCode = await readSourceAsString(def.filePath, def.line, def.endLine);
      const annotations = db.getDefinitionMetadata(defId);

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

        const def = db.getDefinitionById(row.definitionId);
        issues.push({
          definitionId: row.definitionId,
          definitionName: def?.name,
          filePath: def?.filePath,
          line: def?.line,
          severity,
          category: `wrong-${row.check}`,
          message: `${row.check}: ${row.reason}`,
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

  // Get all annotated relationships
  const allRels = db.getAllRelationshipAnnotations({ limit: 100000 });
  // Filter to those that have real annotations (not PENDING)
  const annotatedRels = allRels.filter((r) => r.semantic !== 'PENDING_LLM_ANNOTATION');

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
      const def = db.getDefinitionById(fromId);
      if (!def) continue;

      const sourceCode = await readSourceAsString(def.filePath, def.line, def.endLine);
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

        const fromDef = db.getDefinitionById(row.fromId);
        const toDef = db.getDefinitionById(row.toId);
        issues.push({
          definitionId: row.fromId,
          definitionName: fromDef?.name,
          filePath: fromDef?.filePath,
          line: fromDef?.line,
          severity,
          category: 'wrong-relationship',
          message: `${fromDef?.name || row.fromId} → ${toDef?.name || row.toId}: ${row.reason}`,
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
