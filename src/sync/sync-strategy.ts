import type { IndexDatabase } from '../db/database-facade.js';
import type { SyncResult } from './incremental-indexer.js';

/**
 * Enrichment strategy for the sync pipeline.
 *
 * - 'full': Clear + rebuild all layers (existing --force behavior)
 * - 'incremental': Process only dirty subsets at each layer
 * - 'none': No enrichment needed (no changes or no dirty entries)
 */
export type EnrichmentStrategy = 'full' | 'incremental' | 'none';

/**
 * Thresholds for deciding when to fall back from incremental to full rebuild.
 * All ratios are 0..1.
 */
export interface StrategyThresholds {
  /** Fall back to full rebuild if > this fraction of definitions changed (default 0.40) */
  defsChangedRatio: number;
  /** Fall back to full rebuild if > this fraction of modules affected (default 0.60) */
  modulesAffectedRatio: number;
  /** Fall back to full rebuild for interactions if > this fraction affected (default 0.70) */
  interactionsAffectedRatio: number;
}

export const DEFAULT_THRESHOLDS: StrategyThresholds = {
  defsChangedRatio: 0.4,
  modulesAffectedRatio: 0.6,
  interactionsAffectedRatio: 0.7,
};

export interface StrategyDecision {
  strategy: EnrichmentStrategy;
  reason: string;
  metrics: {
    totalDefinitions: number;
    changedDefinitions: number;
    changeRatio: number;
    totalModules: number;
    affectedModules: number;
    moduleRatio: number;
    totalInteractions: number;
    affectedInteractions: number;
    interactionRatio: number;
  };
}

/**
 * Decide whether to use incremental or full enrichment based on change scope.
 *
 * Rules:
 * 1. No changes → 'none'
 * 2. No modules exist → 'full' (first enrichment must be full)
 * 3. Change ratio > threshold → 'full' (incremental overhead exceeds savings)
 * 4. Otherwise → 'incremental'
 */
export function selectStrategy(
  db: IndexDatabase,
  syncResult: SyncResult,
  thresholds: StrategyThresholds = DEFAULT_THRESHOLDS
): StrategyDecision {
  const totalDefinitions = db.getDefinitionCount();
  const changedDefinitions =
    syncResult.addedDefinitionIds.length +
    syncResult.removedDefinitionIds.length +
    syncResult.updatedDefinitionIds.length;

  // No changes → no enrichment needed
  if (changedDefinitions === 0) {
    return {
      strategy: 'none',
      reason: 'No definition changes detected',
      metrics: {
        totalDefinitions,
        changedDefinitions: 0,
        changeRatio: 0,
        totalModules: 0,
        affectedModules: 0,
        moduleRatio: 0,
        totalInteractions: 0,
        affectedInteractions: 0,
        interactionRatio: 0,
      },
    };
  }

  // Check if modules exist
  let totalModules = 0;
  try {
    totalModules = db.modules.getStats().moduleCount;
  } catch {
    // Table may not exist
  }

  if (totalModules === 0) {
    return {
      strategy: 'full',
      reason: 'No modules exist — first enrichment must be full',
      metrics: {
        totalDefinitions,
        changedDefinitions,
        changeRatio: totalDefinitions > 0 ? changedDefinitions / totalDefinitions : 1,
        totalModules: 0,
        affectedModules: 0,
        moduleRatio: 0,
        totalInteractions: 0,
        affectedInteractions: 0,
        interactionRatio: 0,
      },
    };
  }

  // Compute ratios
  const changeRatio = totalDefinitions > 0 ? changedDefinitions / totalDefinitions : 1;

  const affectedModules = db.syncDirty.count('modules');
  const moduleRatio = totalModules > 0 ? affectedModules / totalModules : 0;

  let totalInteractions = 0;
  try {
    totalInteractions = db.interactions.getCount();
  } catch {
    // Table may not exist
  }
  const affectedInteractions = db.syncDirty.count('interactions');
  const interactionRatio = totalInteractions > 0 ? affectedInteractions / totalInteractions : 0;

  const metrics = {
    totalDefinitions,
    changedDefinitions,
    changeRatio,
    totalModules,
    affectedModules,
    moduleRatio,
    totalInteractions,
    affectedInteractions,
    interactionRatio,
  };

  // Threshold checks
  if (changeRatio > thresholds.defsChangedRatio) {
    return {
      strategy: 'full',
      reason: `Definition change ratio ${(changeRatio * 100).toFixed(1)}% exceeds threshold ${(thresholds.defsChangedRatio * 100).toFixed(0)}%`,
      metrics,
    };
  }

  if (moduleRatio > thresholds.modulesAffectedRatio) {
    return {
      strategy: 'full',
      reason: `Module affected ratio ${(moduleRatio * 100).toFixed(1)}% exceeds threshold ${(thresholds.modulesAffectedRatio * 100).toFixed(0)}%`,
      metrics,
    };
  }

  if (interactionRatio > thresholds.interactionsAffectedRatio) {
    return {
      strategy: 'full',
      reason: `Interaction affected ratio ${(interactionRatio * 100).toFixed(1)}% exceeds threshold ${(thresholds.interactionsAffectedRatio * 100).toFixed(0)}%`,
      metrics,
    };
  }

  return {
    strategy: 'incremental',
    reason: `Change ratio ${(changeRatio * 100).toFixed(1)}%, module ratio ${(moduleRatio * 100).toFixed(1)}% — within incremental thresholds`,
    metrics,
  };
}
