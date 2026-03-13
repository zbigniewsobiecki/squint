/**
 * Shared helpers for processing symbol and relationship annotation results
 * from LLM responses, and for computing coverage for prompts.
 *
 * Extracted from annotate.ts to eliminate duplicated logic between the
 * normal batch processing path and the circular-dependency (cycle) path.
 */

import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import type { AnnotationResult, RelationshipAnnotationResult } from '../llm/_shared/coverage.js';
import { type CoverageInfo, filterCoverageForAspects } from '../llm/_shared/coverage.js';
import type { DependencyContextEnhanced } from '../llm/_shared/prompts.js';
import { validateAnnotationValue } from './annotation-validators.js';
import type { RelationshipRetryQueue } from './retry-queue.js';

// ─── Symbol annotation processing ────────────────────────────────────────────

export interface ProcessSymbolAnnotationsOptions {
  /** Parsed CSV rows from the LLM response. */
  rows: Array<{ symbolId: number; aspect: string; value: string }>;
  /** Set of valid symbol IDs for this batch. */
  validSymbolIds: Set<number>;
  /** Aspects requested for this run. */
  aspects: string[];
  /** Source code keyed by symbol ID (for pure-check validation). */
  sourceCodeById: Map<number, string>;
  /** Dependencies keyed by symbol ID (for transitive-purity check). */
  depsById: Map<number, DependencyContextEnhanced[]>;
  /** Symbol kind keyed by symbol ID (for type-level pure override). */
  kindById: Map<number, string>;
  /** Detected language for the batch (used in pure validation). */
  batchLanguage: string;
  /** When true, skip database writes. */
  dryRun: boolean;
  /** Database instance used to persist annotations. */
  db: IndexDatabase;
  // ---- Optional — only used in the normal (non-cycle) batch path ----
  /** Symbol name keyed by ID; when omitted, the numeric ID is used as fallback. */
  symbolNameById?: Map<number, string>;
  /** When true, emit verbose pure-override log entries via `log`. */
  verbose?: boolean;
  /** Logging function (e.g. `this.log`). */
  log?: (message: string) => void;
  /** Whether output is in JSON mode (suppresses text logging). */
  isJson?: boolean;
}

export interface ProcessSymbolAnnotationsResult {
  results: AnnotationResult[];
  annotationCount: number;
  errorCount: number;
}

/**
 * Validate and optionally persist symbol annotations from an LLM response.
 *
 * Handles:
 * - Invalid symbol IDs (not in this batch)
 * - Unexpected aspect values
 * - Aspect-specific validation (pure gates, domain JSON, purpose length, etc.)
 * - Dry-run mode (skips persistence)
 *
 * Works for both the normal batch path (with full AnnotationResult tracking)
 * and the cycle path (simplified — symbolNameById is optional).
 */
export function processSymbolAnnotations(opts: ProcessSymbolAnnotationsOptions): ProcessSymbolAnnotationsResult {
  const {
    rows,
    validSymbolIds,
    aspects,
    sourceCodeById,
    depsById,
    kindById,
    batchLanguage,
    dryRun,
    db,
    symbolNameById,
    verbose,
    log,
    isJson,
  } = opts;

  const results: AnnotationResult[] = [];
  let annotationCount = 0;
  let errorCount = 0;

  for (const row of rows) {
    const symbolId = row.symbolId;
    const symbolName = symbolNameById?.get(symbolId) ?? String(symbolId);

    // Validate symbol ID
    if (!validSymbolIds.has(symbolId)) {
      results.push({
        symbolId,
        symbolName: String(symbolId),
        aspect: row.aspect,
        value: row.value,
        success: false,
        error: `Invalid symbol ID: ${symbolId}`,
      });
      errorCount++;
      continue;
    }

    // Validate aspect
    if (!aspects.includes(row.aspect)) {
      results.push({
        symbolId,
        symbolName,
        aspect: row.aspect,
        value: row.value,
        success: false,
        error: `Unexpected aspect: ${row.aspect}`,
      });
      errorCount++;
      continue;
    }

    // Validate value (aspect-specific)
    let value = row.value;
    const validationError = validateAnnotationValue(
      row.aspect,
      value,
      sourceCodeById.get(symbolId),
      depsById.get(symbolId),
      kindById.get(symbolId),
      batchLanguage
    );

    if (validationError?.startsWith('overridden to true')) {
      if (!isJson && verbose && log) {
        log(chalk.yellow(`  Pure override for #${symbolId}: ${validationError}`));
      }
      value = 'true';
    } else if (validationError?.startsWith('overridden')) {
      if (!isJson && verbose && log) {
        log(chalk.yellow(`  Pure override for #${symbolId}: ${validationError}`));
      }
      value = 'false';
    } else if (validationError) {
      results.push({
        symbolId,
        symbolName,
        aspect: row.aspect,
        value,
        success: false,
        error: validationError,
      });
      errorCount++;
      continue;
    }

    // Persist (unless dry-run)
    if (!dryRun) {
      db.metadata.set(symbolId, row.aspect, value);
    }

    results.push({
      symbolId,
      symbolName,
      aspect: row.aspect,
      value,
      success: true,
    });
    annotationCount++;
  }

  return { results, annotationCount, errorCount };
}

// ─── Relationship annotation processing ──────────────────────────────────────

export interface ProcessRelationshipAnnotationsOptions {
  /** Parsed CSV rows from the LLM response. */
  rows: Array<{ fromId: number; toId: number; value: string }>;
  /** Set of valid symbol IDs for this batch (used to validate fromId). */
  validSymbolIds: Set<number>;
  /**
   * Valid relationship map.
   *
   * - Normal batch path: `Map<fromId, Map<toId, toName>>` — toName is looked
   *   up from the map for richer error messages.
   * - Cycle path: `Map<fromId, Set<toId>>` — no toName available; pass the
   *   simplified form and omit `symbolNameById`.
   */
  validRelationships: Map<number, Map<number, string>> | Map<number, Set<number>>;
  /** When true, skip database writes. */
  dryRun: boolean;
  /** Database instance used to persist relationship annotations. */
  db: IndexDatabase;
  // ---- Optional ----
  /** Symbol name keyed by ID; used for richer error/result messages. */
  symbolNameById?: Map<number, string>;
  /** Retry queue to record short-value failures for later retry. */
  retryQueue?: RelationshipRetryQueue;
}

export interface ProcessRelationshipAnnotationsResult {
  results: RelationshipAnnotationResult[];
  annotationCount: number;
  errorCount: number;
}

/**
 * Validate and optionally persist relationship annotations from an LLM response.
 *
 * Handles:
 * - Invalid fromId (not in this batch)
 * - Unexpected relationship (toId not in valid set for this fromId)
 * - Too-short description (< 5 chars) — added to retryQueue when provided
 * - Dry-run mode (skips persistence)
 *
 * Works for both the normal batch path (Map<fromId, Map<toId, toName>>) and
 * the cycle path (Map<fromId, Set<toId>>).
 */
export function processRelationshipAnnotations(
  opts: ProcessRelationshipAnnotationsOptions
): ProcessRelationshipAnnotationsResult {
  const { rows, validSymbolIds, validRelationships, dryRun, db, symbolNameById, retryQueue } = opts;

  const results: RelationshipAnnotationResult[] = [];
  let annotationCount = 0;
  let errorCount = 0;

  for (const row of rows) {
    const fromId = row.fromId;
    const toId = row.toId;
    const fromName = symbolNameById?.get(fromId) ?? String(fromId);

    // Validate fromId
    if (!validSymbolIds.has(fromId)) {
      results.push({
        fromId,
        fromName: String(fromId),
        toId,
        toName: String(toId),
        value: row.value,
        success: false,
        error: `Invalid from_id: ${fromId}`,
      });
      errorCount++;
      continue;
    }

    // Validate relationship exists and resolve toName
    const toEntry = validRelationships.get(fromId);
    let toName: string = String(toId);
    let relationshipValid = false;

    if (toEntry instanceof Map) {
      // Normal batch path: Map<toId, toName>
      if (toEntry.has(toId)) {
        relationshipValid = true;
        toName = toEntry.get(toId) ?? String(toId);
      }
    } else if (toEntry instanceof Set) {
      // Cycle path: Set<toId>
      relationshipValid = toEntry.has(toId);
    }

    if (!relationshipValid) {
      results.push({
        fromId,
        fromName,
        toId,
        toName: String(toId),
        value: row.value,
        success: false,
        error: `Unexpected relationship: ${fromId} → ${toId}`,
      });
      errorCount++;
      continue;
    }

    // Validate value length
    if (!row.value || row.value.length < 5) {
      const errorMsg = 'Relationship description must be at least 5 characters';
      results.push({
        fromId,
        fromName,
        toId,
        toName,
        value: row.value,
        success: false,
        error: errorMsg,
      });
      retryQueue?.add(fromId, toId, errorMsg);
      errorCount++;
      continue;
    }

    // Persist (unless dry-run)
    if (!dryRun) {
      db.relationships.set(fromId, toId, row.value);
    }

    results.push({
      fromId,
      fromName,
      toId,
      toName,
      value: row.value,
      success: true,
    });
    annotationCount++;
  }

  return { results, annotationCount, errorCount };
}

// ─── Coverage computation ─────────────────────────────────────────────────────

export interface GetCoverageForPromptOptions {
  /** Database instance. */
  db: IndexDatabase;
  /** Aspects to compute coverage for. */
  aspects: string[];
  /** Optional symbol kind filter. */
  kind?: string;
  /** Optional file path pattern filter. */
  filePattern?: string;
}

/**
 * Compute per-aspect coverage info for use in LLM prompts.
 *
 * Encapsulates the repeated pattern:
 *   1. `db.metadata.getAspectCoverage({ kind, filePattern })`
 *   2. `db.metadata.getFilteredCount({ kind, filePattern })`
 *   3. `filterCoverageForAspects(allCoverage, aspects, total)`
 */
export function getCoverageForPrompt(opts: GetCoverageForPromptOptions): CoverageInfo[] {
  const { db, aspects, kind, filePattern } = opts;

  const allCoverage = db.metadata.getAspectCoverage({ kind, filePattern });
  const totalSymbols = db.metadata.getFilteredCount({ kind, filePattern });
  return filterCoverageForAspects(allCoverage, aspects, totalSymbols);
}
