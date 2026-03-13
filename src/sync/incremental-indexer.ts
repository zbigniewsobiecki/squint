import type { IndexDatabase } from '../db/database-facade.js';
import { buildWorkspaceMap } from '../parser/workspace-resolver.js';
import { scanDirectory } from '../utils/file-scanner.js';
import type { FileChange } from './change-detector.js';
import { deleteRemovedFiles } from './phases/delete-removed-files.js';
import { parseChangedFiles, preParseDependentFiles } from './phases/parse-files.js';
import { cleanupDanglingRefs, populateDirtySets, runPostSyncMaintenance } from './phases/post-sync-cleanup.js';
import { processModifiedFiles } from './phases/process-modified-files.js';
import { processNewFiles } from './phases/process-new-files.js';
import { reResolveDependents } from './phases/re-resolve-dependents.js';
import { resolveReferences } from './phases/resolve-references.js';
import type { SyncContext } from './phases/sync-context.js';

export interface SyncResult {
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  definitionsAdded: number;
  definitionsRemoved: number;
  definitionsUpdated: number;
  importsRefreshed: number;
  staleMetadataCount: number;
  unassignedCount: number;
  interactionsRecalculated: boolean;
  dependentFilesReResolved: number;
  danglingRefsCleaned: number;
  ghostRowsCleaned: number;
  inheritanceResult: { created: number };
  /** IDs of definitions added during this sync (new files + new defs in modified files) */
  addedDefinitionIds: number[];
  /** IDs of definitions removed during this sync (deleted files + removed defs in modified files) */
  removedDefinitionIds: number[];
  /** IDs of definitions updated in-place during this sync (matched by name:kind in modified files) */
  updatedDefinitionIds: number[];
}

/**
 * Apply incremental sync to the database based on detected file changes.
 *
 * Orchestrates 8 phases:
 *   Phase 2/2b — Parse changed + dependent files (async, before transaction)
 *   Phase 1    — Delete removed files              (inside transaction)
 *   Phase 3    — Process modified files            (inside transaction)
 *   Phase 4    — Process new files                 (inside transaction)
 *   Phase 5    — Resolve references                (inside transaction)
 *   Phase 6    — Re-resolve dependent files        (inside transaction)
 *   Phase 7    — Dangling cleanup                  (inside transaction)
 *   Phase 8/8b — Post-sync maintenance + dirty sets (inside transaction)
 */
export async function applySync(
  changes: FileChange[],
  sourceDirectory: string,
  db: IndexDatabase,
  verbose = false,
  log: (msg: string) => void = () => {}
): Promise<SyncResult> {
  const conn = db.getConnection();

  const deleted = changes.filter((c) => c.status === 'deleted');
  const modified = changes.filter((c) => c.status === 'modified');
  const added = changes.filter((c) => c.status === 'new');

  const result: SyncResult = {
    filesAdded: added.length,
    filesModified: modified.length,
    filesDeleted: deleted.length,
    definitionsAdded: 0,
    definitionsRemoved: 0,
    definitionsUpdated: 0,
    importsRefreshed: 0,
    staleMetadataCount: 0,
    unassignedCount: 0,
    interactionsRecalculated: false,
    dependentFilesReResolved: 0,
    danglingRefsCleaned: 0,
    ghostRowsCleaned: 0,
    inheritanceResult: { created: 0 },
    addedDefinitionIds: [],
    removedDefinitionIds: [],
    updatedDefinitionIds: [],
  };

  if (changes.length === 0) return result;

  // Build workspace map and known files set for parsing
  const allDiskFiles = await scanDirectory(sourceDirectory);
  const knownFiles = new Set(allDiskFiles);
  const workspaceMap = buildWorkspaceMap(sourceDirectory, knownFiles);

  // Build the shared context object that flows through all phases
  const ctx: SyncContext = {
    db,
    conn,
    result,
    fileIdMap: new Map(),
    definitionMap: new Map(),
    allDefinitionMap: new Map(),
    changedFileIds: new Set(),
    preDeleteModuleIds: new Set(),
    allParsedFiles: new Map(),
    parsedChanges: new Map(),
    sourceDirectory,
    verbose,
    log,
  };

  // ============================================================
  // Phases 2 + 2b — Parse files (async, before transaction)
  // ============================================================
  await parseChangedFiles(added, modified, knownFiles, workspaceMap, ctx);
  await preParseDependentFiles(modified, deleted, knownFiles, workspaceMap, ctx);

  // ============================================================
  // All DB mutations wrapped in a single exclusive transaction.
  // All async work (parsing) has been completed above.
  // better-sqlite3 operations are synchronous, so this is safe.
  // If the process crashes, SQLite rolls back the entire sync.
  // ============================================================
  const syncTransaction = conn.transaction(() => {
    deleteRemovedFiles(deleted, ctx); // Phase 1
    processModifiedFiles(modified, ctx); // Phase 3
    processNewFiles(added, ctx); // Phase 4
    resolveReferences(added, modified, allDiskFiles, ctx); // Phase 5
    reResolveDependents(ctx); // Phase 6
    cleanupDanglingRefs(ctx); // Phase 7
    runPostSyncMaintenance(ctx); // Phase 8
    populateDirtySets(ctx); // Phase 8b
  });

  // Execute as exclusive transaction for concurrency safety
  syncTransaction.exclusive();

  return result;
}
