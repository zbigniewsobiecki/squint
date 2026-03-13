import type { DirtyLayer, DirtyReason, SyncDirtyEntry } from '../../db/schema.js';
import { cleanDanglingSymbolRefs } from '../cascade-delete.js';
import type { SyncContext } from './sync-context.js';

/** Chunk size for IN queries to avoid SQLite variable limit */
const DIRTY_CHUNK_SIZE = 500;

/** Build SyncDirtyEntry array from a set of IDs */
function entriesToMark(layer: DirtyLayer, ids: Iterable<number>, reason: DirtyReason): SyncDirtyEntry[] {
  return [...ids].map((entityId) => ({ layer, entityId, reason }));
}

/**
 * Phase 7 — Dangling cleanup.
 *
 * Removes symbol rows that reference definitions no longer in the DB.
 * Runs inside the exclusive transaction.
 */
export function cleanupDanglingRefs(ctx: SyncContext): void {
  ctx.result.danglingRefsCleaned = cleanDanglingSymbolRefs(ctx.conn);
}

/**
 * Phase 8 — Post-sync: inheritance, interactions, ghost rows.
 *
 * Runs inside the exclusive transaction.
 */
export function runPostSyncMaintenance(ctx: SyncContext): void {
  // Recreate inheritance relationships
  if (ctx.verbose) ctx.log('  Recreating inheritance relationships...');
  const inheritanceResult = ctx.db.graph.createInheritanceRelationships();
  ctx.result.inheritanceResult = { created: inheritanceResult.created };

  // Sync interactions from call graph if modules exist
  try {
    const moduleCount = ctx.db.modules.getStats().moduleCount;
    if (moduleCount > 0) {
      if (ctx.verbose) ctx.log('  Syncing interactions from call graph...');
      ctx.db.callGraph.syncFromCallGraph(ctx.db.interactions);
      ctx.result.interactionsRecalculated = true;
    }
  } catch {
    // modules table might not have data yet
  }

  // Clean ghost rows
  if (ctx.verbose) ctx.log('  Cleaning ghost rows...');
  const ghosts = ctx.db.findGhostRows();
  let ghostCount = 0;
  for (const g of ghosts.ghostRelationships) {
    if (ctx.db.deleteGhostRow(g.table, g.id)) ghostCount++;
  }
  for (const g of ghosts.ghostMembers) {
    if (ctx.db.deleteGhostRow(g.table, g.definitionId)) ghostCount++;
  }
  for (const g of ghosts.ghostEntryPoints) {
    if (ctx.db.deleteGhostRow(g.table, g.id)) ghostCount++;
  }
  for (const g of ghosts.ghostEntryModules) {
    if (ctx.db.deleteGhostRow(g.table, g.id)) ghostCount++;
  }
  for (const g of ghosts.ghostInteractions) {
    if (ctx.db.deleteGhostRow(g.table, g.id)) ghostCount++;
  }
  for (const g of ghosts.ghostSubflows) {
    if (ctx.db.deleteGhostRow(g.table, g.rowid)) ghostCount++;
  }
  ctx.result.ghostRowsCleaned = ghostCount;
}

/**
 * Phase 8b — Populate sync_dirty sets for incremental enrichment.
 *
 * Marks entities at each pipeline layer (metadata, relationships, modules,
 * contracts, interactions, flows, features) that need re-processing.
 *
 * Propagation order (bottom-up):
 *   definitions → metadata, relationships → modules → contracts, interactions → flows → features
 *
 * @param preCollectedModuleIds Module IDs collected before cascade-deletes removed
 *   the module_members rows for deleted/removed definitions.
 *
 * Runs inside the exclusive transaction.
 */
export function populateDirtySets(ctx: SyncContext): void {
  if (ctx.verbose) ctx.log('  Populating dirty sets for incremental enrichment...');

  const { addedDefinitionIds, updatedDefinitionIds, removedDefinitionIds } = ctx.result;
  const { db, conn, preDeleteModuleIds: preCollectedModuleIds } = ctx;

  // Skip if no definition changes
  if (addedDefinitionIds.length === 0 && updatedDefinitionIds.length === 0 && removedDefinitionIds.length === 0) {
    return;
  }

  // Clear any stale dirty entries from a previous interrupted sync
  db.syncDirty.clear();

  // --- Layer 1: metadata (definitions needing re-annotation) ---
  db.syncDirty.markDirtyBatch([
    ...entriesToMark('metadata', addedDefinitionIds, 'added'),
    ...entriesToMark('metadata', updatedDefinitionIds, 'modified'),
  ]);

  // --- Layer 2: relationships (edges touching changed definitions) ---
  db.syncDirty.markDirtyBatch([
    ...entriesToMark('relationships', addedDefinitionIds, 'added'),
    ...entriesToMark('relationships', updatedDefinitionIds, 'modified'),
    ...entriesToMark('relationships', removedDefinitionIds, 'removed'),
  ]);

  // --- Layer 3: modules (modules containing changed definitions) ---
  // For removed definitions, module_members rows are already cascade-deleted,
  // so we use preCollectedModuleIds gathered before the cascade.
  const affectedModuleIds = new Set<number>(preCollectedModuleIds);
  for (let i = 0; i < updatedDefinitionIds.length; i += DIRTY_CHUNK_SIZE) {
    const chunk = updatedDefinitionIds.slice(i, i + DIRTY_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = conn
      .prepare(
        `SELECT DISTINCT module_id as moduleId FROM module_members
         WHERE definition_id IN (${placeholders})`
      )
      .all(...chunk) as Array<{ moduleId: number }>;
    for (const row of rows) affectedModuleIds.add(row.moduleId);
  }
  db.syncDirty.markDirtyBatch(entriesToMark('modules', affectedModuleIds, 'modified'));

  // --- Layer 4: contracts ---
  // Intentionally over-broad: all changed definitions are marked, though only ~2-5%
  // are boundary candidates. The contracts layer filters to actual participants when it runs.
  db.syncDirty.markDirtyBatch([
    ...entriesToMark('contracts', addedDefinitionIds, 'added'),
    ...entriesToMark('contracts', updatedDefinitionIds, 'modified'),
  ]);

  // --- Layer 5: interactions (interactions touching affected modules) ---
  if (affectedModuleIds.size === 0) return;

  const moduleIdArr = [...affectedModuleIds];
  const affectedInteractionIds = new Set<number>();
  for (let i = 0; i < moduleIdArr.length; i += DIRTY_CHUNK_SIZE) {
    const chunk = moduleIdArr.slice(i, i + DIRTY_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      const rows = conn
        .prepare(
          `SELECT DISTINCT id FROM interactions
           WHERE from_module_id IN (${placeholders}) OR to_module_id IN (${placeholders})`
        )
        .all(...chunk, ...chunk) as Array<{ id: number }>;
      for (const row of rows) affectedInteractionIds.add(row.id);
    } catch {
      // interactions table may not exist yet
    }
  }
  db.syncDirty.markDirtyBatch(entriesToMark('interactions', affectedInteractionIds, 'parent_dirty'));

  // --- Layer 6: flows (flows whose steps reference affected interactions) ---
  if (affectedInteractionIds.size === 0) return;

  const interactionIdArr = [...affectedInteractionIds];
  const affectedFlowIds = new Set<number>();
  for (let i = 0; i < interactionIdArr.length; i += DIRTY_CHUNK_SIZE) {
    const chunk = interactionIdArr.slice(i, i + DIRTY_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      const rows = conn
        .prepare(
          `SELECT DISTINCT flow_id as id FROM flow_steps
           WHERE interaction_id IN (${placeholders})`
        )
        .all(...chunk) as Array<{ id: number }>;
      for (const row of rows) affectedFlowIds.add(row.id);
    } catch {
      // flow_steps table may not exist yet
    }
  }
  db.syncDirty.markDirtyBatch(entriesToMark('flows', affectedFlowIds, 'parent_dirty'));

  // --- Layer 7: features (features containing affected flows) ---
  if (affectedFlowIds.size === 0) return;

  const flowIdArr = [...affectedFlowIds];
  const affectedFeatureIds = new Set<number>();
  for (let i = 0; i < flowIdArr.length; i += DIRTY_CHUNK_SIZE) {
    const chunk = flowIdArr.slice(i, i + DIRTY_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      const rows = conn
        .prepare(
          `SELECT DISTINCT feature_id as id FROM feature_flows
           WHERE flow_id IN (${placeholders})`
        )
        .all(...chunk) as Array<{ id: number }>;
      for (const row of rows) affectedFeatureIds.add(row.id);
    } catch {
      // feature_flows table may not exist yet
    }
  }
  db.syncDirty.markDirtyBatch(entriesToMark('features', affectedFeatureIds, 'parent_dirty'));
}
