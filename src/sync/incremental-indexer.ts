import path from 'node:path';
import type { IndexDatabase } from '../db/database-facade.js';
import { computeHash } from '../db/schema.js';
import type { ParsedFile } from '../parser/ast-parser.js';
import { parseFile } from '../parser/ast-parser.js';
import { buildWorkspaceMap } from '../parser/workspace-resolver.js';
import { scanDirectory } from '../utils/file-scanner.js';
import { cascadeDeleteDefinitions, cascadeDeleteFile, cleanDanglingSymbolRefs } from './cascade-delete.js';
import type { FileChange } from './change-detector.js';

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
  };

  if (changes.length === 0) return result;

  // Build workspace map and known files set for parsing
  const allDiskFiles = await scanDirectory(sourceDirectory);
  const knownFiles = new Set(allDiskFiles);
  const workspaceMap = buildWorkspaceMap(sourceDirectory, knownFiles);

  // ============================================================
  // Phase 1 — Delete removed files
  // ============================================================
  if (deleted.length > 0) {
    if (verbose) log(`  Deleting ${deleted.length} removed file(s)...`);
    const deleteTransaction = conn.transaction(() => {
      for (const change of deleted) {
        cascadeDeleteFile(conn, change.fileId!);
      }
    });
    deleteTransaction();
  }

  // ============================================================
  // Phase 2 — Parse all new + modified files
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
      }
    }
    if (removedDefIds.length > 0) {
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

  // Build parsedFiles map for re-export chain resolution (need all parsed files)
  // For unchanged files we only need their references for re-export chain following
  const allParsedFiles = new Map<string, ParsedFile>(parsedChanges);

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
    const allDefMap = allDefinitionMap.get(change.absolutePath);

    for (const internalUsage of parsed.internalUsages) {
      const defId = allDefMap?.get(internalUsage.definitionName) ?? null;
      const symbolId = db.insertSymbol(
        null,
        defId,
        {
          name: internalUsage.definitionName,
          localName: internalUsage.definitionName,
          kind: 'named',
          usages: internalUsage.usages,
        },
        fileId
      );
      for (const usage of internalUsage.usages) {
        db.insertUsage(symbolId, usage);
      }
    }
  }

  // ============================================================
  // Phase 6 — Dependent file re-resolution
  //           (unchanged files importing from changed files)
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
      // Parse the dependent file to get its symbol information
      let depParsed = allParsedFiles.get(depAbsPath);
      if (!depParsed) {
        try {
          depParsed = await parseFile(depAbsPath, knownFiles, workspaceMap);
          allParsedFiles.set(depAbsPath, depParsed);
        } catch {
          continue;
        }
      }

      // For each import to a changed file, re-insert its symbols
      for (const imp of importsToReResolve) {
        // Find matching reference in parsed data
        const matchingRef = depParsed.references.find((ref) => {
          const refToFileId = ref.resolvedPath ? (fileIdMap.get(ref.resolvedPath) ?? null) : null;
          return refToFileId === imp.toFileId;
        });
        if (!matchingRef) continue;

        for (const sym of matchingRef.imports) {
          let defId: number | null = null;
          if (matchingRef.resolvedPath && !matchingRef.isExternal) {
            const targetDefMap = definitionMap.get(matchingRef.resolvedPath);
            if (targetDefMap) {
              const lookupName = sym.kind === 'default' ? 'default' : sym.name;
              defId = targetDefMap.get(lookupName) ?? null;

              if (defId === null && sym.kind === 'default') {
                const targetFileId = fileIdMap.get(matchingRef.resolvedPath);
                if (targetFileId) {
                  for (const [name, id] of targetDefMap) {
                    const defCheck = db.getDefinitionByName(targetFileId, name);
                    if (defCheck !== null) {
                      defId = id;
                      break;
                    }
                  }
                }
              }
            }
          }

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

  return result;
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Delete all imports, symbols, and usages originating from a file.
 */
function deleteFileImportsAndSymbols(conn: import('better-sqlite3').Database, fileId: number): void {
  // Delete usages for import-based symbols
  conn
    .prepare(
      `DELETE FROM usages WHERE symbol_id IN
      (SELECT s.id FROM symbols s JOIN imports i ON s.reference_id = i.id
       WHERE i.from_file_id = ?)`
    )
    .run(fileId);

  // Delete usages for internal symbols
  conn
    .prepare(
      `DELETE FROM usages WHERE symbol_id IN
      (SELECT id FROM symbols WHERE file_id = ?)`
    )
    .run(fileId);

  // Delete import-based symbols
  conn
    .prepare(
      `DELETE FROM symbols WHERE reference_id IN
      (SELECT id FROM imports WHERE from_file_id = ?)`
    )
    .run(fileId);

  // Delete internal symbols
  conn.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);

  // Delete imports
  conn.prepare('DELETE FROM imports WHERE from_file_id = ?').run(fileId);
}

/**
 * Insert references, symbols, and usages for a single parsed file.
 * Mirrors the logic in indexParsedFiles pass 2.
 */
function insertFileReferences(
  parsed: ParsedFile,
  fromFileId: number,
  db: IndexDatabase,
  fileIdMap: Map<string, number>,
  definitionMap: Map<string, Map<string, number>>,
  allParsedFiles: Map<string, ParsedFile>,
  conn: import('better-sqlite3').Database
): void {
  for (const ref of parsed.references) {
    const toFileId = ref.resolvedPath ? (fileIdMap.get(ref.resolvedPath) ?? null) : null;
    const refId = db.insertReference(fromFileId, toFileId, ref);

    for (const sym of ref.imports) {
      let defId: number | null = null;
      if (ref.resolvedPath && !ref.isExternal) {
        const targetDefMap = definitionMap.get(ref.resolvedPath);
        if (targetDefMap) {
          const lookupName = sym.kind === 'default' ? 'default' : sym.name;
          defId = targetDefMap.get(lookupName) ?? null;

          if (defId === null && sym.kind === 'default') {
            const targetFileId = fileIdMap.get(ref.resolvedPath);
            if (targetFileId) {
              for (const [name, id] of targetDefMap) {
                const defCheck = db.getDefinitionByName(targetFileId, name);
                if (defCheck !== null) {
                  defId = id;
                  break;
                }
              }
            }
          }
        }
      }

      // Follow re-export chains (with DB fallback for unchanged files)
      if (defId === null && ref.resolvedPath && !ref.isExternal) {
        defId = followReExportChain(
          sym.kind === 'default' ? 'default' : sym.name,
          ref.resolvedPath,
          allParsedFiles,
          definitionMap,
          new Set(),
          conn,
          fileIdMap
        );
      }

      const symbolId = db.insertSymbol(refId, defId, sym);
      for (const usage of sym.usages) {
        db.insertUsage(symbolId, usage);
      }
    }
  }
}

/**
 * Follow re-export chains to find the original definition.
 * Mirrors the logic in parse.ts followReExportChain.
 *
 * When a file isn't in the parsedFiles map (unchanged file not re-parsed),
 * falls back to querying the imports table in the DB.
 */
function followReExportChain(
  symbolName: string,
  filePath: string,
  parsedFiles: Map<string, ParsedFile>,
  definitionMap: Map<string, Map<string, number>>,
  visited: Set<string>,
  conn?: import('better-sqlite3').Database,
  fileIdMap?: Map<string, number>
): number | null {
  if (visited.has(filePath) || visited.size >= 5) return null;
  visited.add(filePath);

  const parsed = parsedFiles.get(filePath);
  if (parsed) {
    // Use parsed data when available
    for (const ref of parsed.references) {
      if ((ref.type !== 're-export' && ref.type !== 'export-all') || !ref.resolvedPath) continue;

      if (ref.type === 'export-all') {
        const defId = definitionMap.get(ref.resolvedPath)?.get(symbolName) ?? null;
        if (defId !== null) return defId;
        const found = followReExportChain(
          symbolName,
          ref.resolvedPath,
          parsedFiles,
          definitionMap,
          visited,
          conn,
          fileIdMap
        );
        if (found !== null) return found;
      } else {
        for (const sym of ref.imports) {
          if (sym.name === symbolName || sym.localName === symbolName) {
            const defId = definitionMap.get(ref.resolvedPath)?.get(sym.name) ?? null;
            if (defId !== null) return defId;
            const found = followReExportChain(
              sym.name,
              ref.resolvedPath,
              parsedFiles,
              definitionMap,
              visited,
              conn,
              fileIdMap
            );
            if (found !== null) return found;
          }
        }
      }
    }
    return null;
  }

  // Fallback: use DB imports table for unchanged files not in parsedFiles
  if (!conn || !fileIdMap) return null;
  const fileId = fileIdMap.get(filePath);
  if (!fileId) return null;

  const reExports = conn
    .prepare(
      `SELECT i.type, i.to_file_id as toFileId, tf.path as toFilePath
       FROM imports i
       LEFT JOIN files tf ON i.to_file_id = tf.id
       WHERE i.from_file_id = ? AND i.type IN ('re-export', 'export-all') AND i.to_file_id IS NOT NULL`
    )
    .all(fileId) as Array<{ type: string; toFileId: number; toFilePath: string }>;

  for (const reExp of reExports) {
    // Reconstruct absolute path to look up in definitionMap
    // definitionMap is keyed by absolute path
    let absResolvedPath: string | undefined;
    for (const [absPath, fId] of fileIdMap) {
      if (fId === reExp.toFileId) {
        absResolvedPath = absPath;
        break;
      }
    }
    if (!absResolvedPath) continue;

    if (reExp.type === 'export-all') {
      const defId = definitionMap.get(absResolvedPath)?.get(symbolName) ?? null;
      if (defId !== null) return defId;
      const found = followReExportChain(
        symbolName,
        absResolvedPath,
        parsedFiles,
        definitionMap,
        visited,
        conn,
        fileIdMap
      );
      if (found !== null) return found;
    } else {
      // re-export: check symbols on that import for the name
      const reExpSymbols = conn
        .prepare(
          `SELECT s.name, s.local_name as localName
           FROM symbols s
           JOIN imports i ON s.reference_id = i.id
           WHERE i.from_file_id = ? AND i.to_file_id = ? AND i.type = 're-export'`
        )
        .all(fileId, reExp.toFileId) as Array<{ name: string; localName: string }>;

      for (const sym of reExpSymbols) {
        if (sym.name === symbolName || sym.localName === symbolName) {
          const defId = definitionMap.get(absResolvedPath)?.get(sym.name) ?? null;
          if (defId !== null) return defId;
          const found = followReExportChain(
            sym.name,
            absResolvedPath,
            parsedFiles,
            definitionMap,
            visited,
            conn,
            fileIdMap
          );
          if (found !== null) return found;
        }
      }
    }
  }
  return null;
}
