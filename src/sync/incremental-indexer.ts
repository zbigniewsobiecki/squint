import path from 'node:path';
import type { IndexDatabase } from '../db/database-facade.js';
import { computeHash } from '../db/schema.js';
import type { DirtyLayer, DirtyReason, SyncDirtyEntry } from '../db/schema.js';
import type { ParsedFile } from '../parser/ast-parser.js';
import { parseFile } from '../parser/ast-parser.js';
import { buildWorkspaceMap } from '../parser/workspace-resolver.js';
import { scanDirectory } from '../utils/file-scanner.js';
import { cascadeDeleteDefinitions, cascadeDeleteFile, cleanDanglingSymbolRefs } from './cascade-delete.js';
import type { FileChange } from './change-detector.js';
import {
  deleteFileImportsAndSymbols,
  followReExportChain,
  insertFileReferences,
  insertInternalUsages,
  resolveSymbolToDefinition,
} from './reference-resolver.js';

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

  // ============================================================
  // Phase 2 — Parse all new + modified files (async, before transaction)
  // ============================================================
  if (verbose) log(`  Parsing ${added.length + modified.length} file(s)...`);
  const parsedChanges = new Map<string, ParsedFile>();
  for (const change of [...modified, ...added]) {
    try {
      const parsed = await parseFile(change.absolutePath, knownFiles, workspaceMap);
      parsedChanges.set(change.absolutePath, parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`  Warning: Failed to parse ${change.path}: ${message}`);
    }
  }

  // ============================================================
  // Phase 2b — Pre-parse dependent files (async, before transaction)
  //            These are unchanged files that import from modified files.
  //            Pre-parsing ensures Phase 6 is fully synchronous.
  // ============================================================
  const allParsedFiles = new Map<string, ParsedFile>(parsedChanges);

  const preKnownChangedFileIds = new Set<number>();
  for (const change of [...modified, ...deleted]) {
    if (change.fileId) preKnownChangedFileIds.add(change.fileId);
  }

  if (preKnownChangedFileIds.size > 0) {
    const prePlaceholders = [...preKnownChangedFileIds].map(() => '?').join(',');
    const preDependentRows = conn
      .prepare(
        `SELECT DISTINCT i.from_file_id as fileId
         FROM imports i
         WHERE i.to_file_id IN (${prePlaceholders})
           AND i.from_file_id NOT IN (${prePlaceholders})`
      )
      .all(...preKnownChangedFileIds, ...preKnownChangedFileIds) as Array<{ fileId: number }>;

    if (verbose && preDependentRows.length > 0) {
      log(`  Pre-parsing ${preDependentRows.length} dependent file(s)...`);
    }

    for (const row of preDependentRows) {
      const depFileInfo = db.files.getById(row.fileId);
      if (!depFileInfo) continue;
      const depAbsPath = path.resolve(sourceDirectory, depFileInfo.path);

      if (!allParsedFiles.has(depAbsPath)) {
        try {
          const depParsed = await parseFile(depAbsPath, knownFiles, workspaceMap);
          allParsedFiles.set(depAbsPath, depParsed);
        } catch {
          // Will be skipped during Phase 6
        }
      }
    }
  }

  // ============================================================
  // All DB mutations wrapped in a single exclusive transaction.
  // All async work (parsing) has been completed above.
  // better-sqlite3 operations are synchronous, so this is safe.
  // If the process crashes, SQLite rolls back the entire sync.
  // ============================================================
  const syncTransaction = conn.transaction(() => {
    // Set to collect module IDs for removed definitions before cascade-delete
    // removes module_members rows. Used by populateDirtySets to mark affected modules.
    const preDeleteModuleIds = new Set<number>();

    // ============================================================
    // Phase 1 — Delete removed files
    // ============================================================
    if (deleted.length > 0) {
      if (verbose) log(`  Deleting ${deleted.length} removed file(s)...`);
      for (const change of deleted) {
        // Collect definition IDs before cascade-delete (for removedDefinitionIds tracking)
        const deletedFileDefs = conn
          .prepare('SELECT id FROM definitions WHERE file_id = ?')
          .all(change.fileId!) as Array<{ id: number }>;
        const deletedDefIds = deletedFileDefs.map((d) => d.id);
        for (const d of deletedFileDefs) {
          result.removedDefinitionIds.push(d.id);
          result.definitionsRemoved++;
        }

        // Collect module IDs before cascade-delete removes module_members rows
        if (deletedDefIds.length > 0) {
          const placeholders = deletedDefIds.map(() => '?').join(',');
          const moduleRows = conn
            .prepare(
              `SELECT DISTINCT module_id as moduleId FROM module_members
               WHERE definition_id IN (${placeholders})`
            )
            .all(...deletedDefIds) as Array<{ moduleId: number }>;
          for (const row of moduleRows) {
            preDeleteModuleIds.add(row.moduleId);
          }
        }

        cascadeDeleteFile(conn, change.fileId!);
      }
    }

    // ============================================================
    // Phase 3 — Process modified files (definition identity matching)
    // ============================================================
    const changedFileIds = new Set<number>();
    const fileIdMap = new Map<string, number>(); // absolutePath -> fileId
    const definitionMap = new Map<string, Map<string, number>>(); // absolutePath -> (name -> defId) for exported
    const allDefinitionMap = new Map<string, Map<string, number>>(); // absolutePath -> (name -> defId) for all

    // Pre-populate maps from existing DB files (for re-export resolution)
    const allDbFiles = db.files.getAllWithHash();
    for (const f of allDbFiles) {
      const absPath = path.resolve(sourceDirectory, f.path);
      fileIdMap.set(absPath, f.id);
    }

    for (const change of modified) {
      const parsed = parsedChanges.get(change.absolutePath);
      if (!parsed) continue;

      const fileId = change.fileId!;
      changedFileIds.add(fileId);
      fileIdMap.set(change.absolutePath, fileId);

      // Load existing definitions
      const oldDefs = db.definitions.getByFileId(fileId);
      const oldDefMap = new Map<string, (typeof oldDefs)[number]>();
      for (const d of oldDefs) {
        // Key by name+kind to handle multiple defs with same name but different kinds
        oldDefMap.set(`${d.name}:${d.kind}`, d);
      }

      const exportedDefMap = new Map<string, number>();
      const allDefMap = new Map<string, number>();

      // Match new definitions against old ones
      const matchedOldKeys = new Set<string>();
      for (const newDef of parsed.definitions) {
        const key = `${newDef.name}:${newDef.kind}`;
        const oldDef = oldDefMap.get(key);

        if (oldDef) {
          // MATCHED — update positions and export status, keep ID
          matchedOldKeys.add(key);
          db.definitions.updateDefinition(oldDef.id, {
            isExported: newDef.isExported,
            isDefault: newDef.isDefault,
            line: newDef.position.row + 1,
            column: newDef.position.column,
            endLine: newDef.endPosition.row + 1,
            endColumn: newDef.endPosition.column,
            declarationEndLine: (newDef.declarationEndPosition ?? newDef.endPosition).row + 1,
            declarationEndColumn: (newDef.declarationEndPosition ?? newDef.endPosition).column,
            extendsName: newDef.extends ?? null,
            implementsNames: newDef.implements ? JSON.stringify(newDef.implements) : null,
            extendsInterfaces: newDef.extendsAll ? JSON.stringify(newDef.extendsAll) : null,
          });
          result.definitionsUpdated++;
          result.updatedDefinitionIds.push(oldDef.id);

          allDefMap.set(newDef.name, oldDef.id);
          if (newDef.isExported) {
            exportedDefMap.set(newDef.name, oldDef.id);
          }

          // Check if this def has metadata (counts as stale)
          const hasMetadata = conn
            .prepare('SELECT COUNT(*) as count FROM definition_metadata WHERE definition_id = ?')
            .get(oldDef.id) as { count: number };
          if (hasMetadata.count > 0) {
            result.staleMetadataCount++;
          }
        } else {
          // ADDED — insert new definition
          const defId = db.insertDefinition(fileId, newDef);
          result.definitionsAdded++;
          result.unassignedCount++;
          result.addedDefinitionIds.push(defId);

          allDefMap.set(newDef.name, defId);
          if (newDef.isExported) {
            exportedDefMap.set(newDef.name, defId);
          }
        }
      }

      // REMOVED — delete definitions not in new parse
      const removedDefIds: number[] = [];
      for (const [key, oldDef] of oldDefMap) {
        if (!matchedOldKeys.has(key)) {
          removedDefIds.push(oldDef.id);
          result.definitionsRemoved++;
          result.removedDefinitionIds.push(oldDef.id);
        }
      }
      if (removedDefIds.length > 0) {
        // Collect module IDs before cascade-delete removes module_members rows
        const rmPlaceholders = removedDefIds.map(() => '?').join(',');
        const moduleRows = conn
          .prepare(
            `SELECT DISTINCT module_id as moduleId FROM module_members
             WHERE definition_id IN (${rmPlaceholders})`
          )
          .all(...removedDefIds) as Array<{ moduleId: number }>;
        for (const row of moduleRows) {
          preDeleteModuleIds.add(row.moduleId);
        }

        cascadeDeleteDefinitions(conn, removedDefIds);
      }

      definitionMap.set(change.absolutePath, exportedDefMap);
      allDefinitionMap.set(change.absolutePath, allDefMap);

      // Delete ALL imports, symbols, usages originating from this file
      deleteFileImportsAndSymbols(conn, fileId);
      result.importsRefreshed++;

      // Update file record
      db.files.updateHash(fileId, computeHash(parsed.content), parsed.sizeBytes, parsed.modifiedAt);
    }

    // ============================================================
    // Phase 4 — Process new files
    // ============================================================
    for (const change of added) {
      const parsed = parsedChanges.get(change.absolutePath);
      if (!parsed) continue;

      const fileId = db.insertFile({
        path: change.path,
        language: parsed.language,
        contentHash: computeHash(parsed.content),
        sizeBytes: parsed.sizeBytes,
        modifiedAt: parsed.modifiedAt,
      });
      changedFileIds.add(fileId);
      fileIdMap.set(change.absolutePath, fileId);

      const exportedDefMap = new Map<string, number>();
      const allDefMap = new Map<string, number>();
      for (const def of parsed.definitions) {
        const defId = db.insertDefinition(fileId, def);
        allDefMap.set(def.name, defId);
        if (def.isExported) {
          exportedDefMap.set(def.name, defId);
        }
        result.definitionsAdded++;
        result.unassignedCount++;
        result.addedDefinitionIds.push(defId);
      }
      definitionMap.set(change.absolutePath, exportedDefMap);
      allDefinitionMap.set(change.absolutePath, allDefMap);
    }

    // ============================================================
    // Phase 5 — Resolve references for changed files
    //           (insert imports, symbols, usages)
    // ============================================================

    // Build full definition maps for ALL files (needed for cross-file resolution)
    // For unchanged files, load from DB
    for (const absPath of allDiskFiles) {
      if (definitionMap.has(absPath)) continue; // Already populated for changed files
      const fId = fileIdMap.get(absPath);
      if (!fId) continue;

      const defs = db.definitions.getByFileId(fId);
      const expMap = new Map<string, number>();
      const allMap = new Map<string, number>();
      for (const d of defs) {
        allMap.set(d.name, d.id);
        if (d.isExported) {
          expMap.set(d.name, d.id);
        }
      }
      definitionMap.set(absPath, expMap);
      allDefinitionMap.set(absPath, allMap);
    }

    // Insert references and symbols for changed files
    for (const change of [...modified, ...added]) {
      const parsed = parsedChanges.get(change.absolutePath);
      if (!parsed) continue;
      const fromFileId = fileIdMap.get(change.absolutePath)!;

      insertFileReferences(parsed, fromFileId, db, fileIdMap, definitionMap, allParsedFiles, conn);
    }

    // Insert internal usages for changed files
    for (const change of [...modified, ...added]) {
      const parsed = parsedChanges.get(change.absolutePath);
      if (!parsed) continue;
      const fileId = fileIdMap.get(change.absolutePath)!;

      insertInternalUsages(parsed, fileId, change.absolutePath, allDefinitionMap, db);
    }

    // ============================================================
    // Phase 6 — Dependent file re-resolution
    //           (unchanged files importing from changed files)
    //           All dependent files were pre-parsed in Phase 2b.
    // ============================================================
    if (changedFileIds.size > 0) {
      const changedPlaceholders = [...changedFileIds].map(() => '?').join(',');
      const dependentRows = conn
        .prepare(
          `SELECT DISTINCT i.from_file_id as fileId
           FROM imports i
           WHERE i.to_file_id IN (${changedPlaceholders})
             AND i.from_file_id NOT IN (${changedPlaceholders})`
        )
        .all(...changedFileIds, ...changedFileIds) as Array<{ fileId: number }>;

      for (const row of dependentRows) {
        const depFileId = row.fileId;

        // Delete symbols + usages for imports FROM this dependent TO changed files
        conn
          .prepare(
            `DELETE FROM usages WHERE symbol_id IN (
            SELECT s.id FROM symbols s
            JOIN imports i ON s.reference_id = i.id
            WHERE i.from_file_id = ? AND i.to_file_id IN (${changedPlaceholders})
          )`
          )
          .run(depFileId, ...changedFileIds);

        conn
          .prepare(
            `DELETE FROM symbols WHERE reference_id IN (
            SELECT i.id FROM imports i
            WHERE i.from_file_id = ? AND i.to_file_id IN (${changedPlaceholders})
          )`
          )
          .run(depFileId, ...changedFileIds);

        // Re-resolve symbols for those imports
        const importsToReResolve = conn
          .prepare(
            `SELECT id, to_file_id as toFileId, type, source, is_external as isExternal
           FROM imports
           WHERE from_file_id = ? AND to_file_id IN (${changedPlaceholders})`
          )
          .all(depFileId, ...changedFileIds) as Array<{
          id: number;
          toFileId: number | null;
          type: string;
          source: string;
          isExternal: number;
        }>;

        // Get the dependent file's path to find its parsed data
        const depFileInfo = db.files.getById(depFileId);
        if (!depFileInfo) continue;

        const depAbsPath = path.resolve(sourceDirectory, depFileInfo.path);
        // Use pre-parsed data (from Phase 2b); skip if not available
        const depParsed = allParsedFiles.get(depAbsPath);
        if (!depParsed) continue;

        // For each import to a changed file, re-insert its symbols
        for (const imp of importsToReResolve) {
          // Find matching reference in parsed data
          const matchingRef = depParsed.references.find((ref) => {
            const refToFileId = ref.resolvedPath ? (fileIdMap.get(ref.resolvedPath) ?? null) : null;
            return refToFileId === imp.toFileId;
          });
          if (!matchingRef) continue;

          for (const sym of matchingRef.imports) {
            let defId = resolveSymbolToDefinition(sym, matchingRef, definitionMap, fileIdMap, db);

            if (defId === null && matchingRef.resolvedPath && !matchingRef.isExternal) {
              defId = followReExportChain(
                sym.kind === 'default' ? 'default' : sym.name,
                matchingRef.resolvedPath,
                allParsedFiles,
                definitionMap,
                new Set(),
                conn,
                fileIdMap
              );
            }

            const symbolId = db.insertSymbol(imp.id, defId, sym);
            for (const usage of sym.usages) {
              db.insertUsage(symbolId, usage);
            }
          }
        }

        result.dependentFilesReResolved++;
      }
    }

    // ============================================================
    // Phase 7 — Dangling cleanup
    // ============================================================
    result.danglingRefsCleaned = cleanDanglingSymbolRefs(conn);

    // ============================================================
    // Phase 8 — Post-sync: inheritance, interactions, ghost rows
    // ============================================================

    // Recreate inheritance relationships
    if (verbose) log('  Recreating inheritance relationships...');
    const inheritanceResult = db.graph.createInheritanceRelationships();
    result.inheritanceResult = {
      created: inheritanceResult.created,
    };

    // Sync interactions from call graph if modules exist
    try {
      const moduleCount = db.modules.getStats().moduleCount;
      if (moduleCount > 0) {
        if (verbose) log('  Syncing interactions from call graph...');
        db.callGraph.syncFromCallGraph(db.interactions);
        result.interactionsRecalculated = true;
      }
    } catch {
      // modules table might not have data yet
    }

    // Clean ghost rows
    if (verbose) log('  Cleaning ghost rows...');
    const ghosts = db.findGhostRows();
    let ghostCount = 0;
    for (const g of ghosts.ghostRelationships) {
      if (db.deleteGhostRow(g.table, g.id)) ghostCount++;
    }
    for (const g of ghosts.ghostMembers) {
      if (db.deleteGhostRow(g.table, g.definitionId)) ghostCount++;
    }
    for (const g of ghosts.ghostEntryPoints) {
      if (db.deleteGhostRow(g.table, g.id)) ghostCount++;
    }
    for (const g of ghosts.ghostEntryModules) {
      if (db.deleteGhostRow(g.table, g.id)) ghostCount++;
    }
    for (const g of ghosts.ghostInteractions) {
      if (db.deleteGhostRow(g.table, g.id)) ghostCount++;
    }
    for (const g of ghosts.ghostSubflows) {
      if (db.deleteGhostRow(g.table, g.rowid)) ghostCount++;
    }
    result.ghostRowsCleaned = ghostCount;

    // ============================================================
    // Phase 8b — Populate sync_dirty sets for incremental enrichment
    // ============================================================
    if (verbose) log('  Populating dirty sets for incremental enrichment...');
    populateDirtySets(db, result, preDeleteModuleIds);
  });

  // Execute as exclusive transaction for concurrency safety
  syncTransaction.exclusive();

  return result;
}

/** Chunk size for IN queries to avoid SQLite variable limit */
const DIRTY_CHUNK_SIZE = 500;

/** Build SyncDirtyEntry array from a set of IDs */
function entriesToMark(layer: DirtyLayer, ids: Iterable<number>, reason: DirtyReason): SyncDirtyEntry[] {
  return [...ids].map((entityId) => ({ layer, entityId, reason }));
}

/**
 * Populate the sync_dirty table based on definition changes from the AST sync.
 * Each layer marks entities that need re-processing during incremental enrichment.
 *
 * Propagation order (bottom-up):
 *   definitions → metadata, relationships → modules → contracts, interactions → flows → features
 *
 * @param preCollectedModuleIds Module IDs collected before cascade-deletes removed
 *   the module_members rows for deleted/removed definitions.
 */
function populateDirtySets(db: IndexDatabase, result: SyncResult, preCollectedModuleIds: Set<number>): void {
  const { addedDefinitionIds, updatedDefinitionIds, removedDefinitionIds } = result;
  const conn = db.getConnection();

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
