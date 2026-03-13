import path from 'node:path';
import { followReExportChain, resolveSymbolToDefinition } from '../reference-resolver.js';
import type { SyncContext } from './sync-context.js';

/**
 * Phase 6 — Dependent file re-resolution.
 *
 * Re-resolves symbols in unchanged files that import from changed files.
 * All dependent files were pre-parsed in Phase 2b, so this phase is
 * fully synchronous (no async parsing).
 *
 * Runs inside the exclusive transaction.
 */
export function reResolveDependents(ctx: SyncContext): void {
  if (ctx.changedFileIds.size === 0) return;

  const changedPlaceholders = [...ctx.changedFileIds].map(() => '?').join(',');
  const dependentRows = ctx.conn
    .prepare(
      `SELECT DISTINCT i.from_file_id as fileId
       FROM imports i
       WHERE i.to_file_id IN (${changedPlaceholders})
         AND i.from_file_id NOT IN (${changedPlaceholders})`
    )
    .all(...ctx.changedFileIds, ...ctx.changedFileIds) as Array<{ fileId: number }>;

  for (const row of dependentRows) {
    const depFileId = row.fileId;

    // Delete symbols + usages for imports FROM this dependent TO changed files
    ctx.conn
      .prepare(
        `DELETE FROM usages WHERE symbol_id IN (
          SELECT s.id FROM symbols s
          JOIN imports i ON s.reference_id = i.id
          WHERE i.from_file_id = ? AND i.to_file_id IN (${changedPlaceholders})
        )`
      )
      .run(depFileId, ...ctx.changedFileIds);

    ctx.conn
      .prepare(
        `DELETE FROM symbols WHERE reference_id IN (
          SELECT i.id FROM imports i
          WHERE i.from_file_id = ? AND i.to_file_id IN (${changedPlaceholders})
        )`
      )
      .run(depFileId, ...ctx.changedFileIds);

    // Re-resolve symbols for those imports
    const importsToReResolve = ctx.conn
      .prepare(
        `SELECT id, to_file_id as toFileId, type, source, is_external as isExternal
         FROM imports
         WHERE from_file_id = ? AND to_file_id IN (${changedPlaceholders})`
      )
      .all(depFileId, ...ctx.changedFileIds) as Array<{
      id: number;
      toFileId: number | null;
      type: string;
      source: string;
      isExternal: number;
    }>;

    // Get the dependent file's path to find its parsed data
    const depFileInfo = ctx.db.files.getById(depFileId);
    if (!depFileInfo) continue;

    const depAbsPath = path.resolve(ctx.sourceDirectory, depFileInfo.path);
    // Use pre-parsed data (from Phase 2b); skip if not available
    const depParsed = ctx.allParsedFiles.get(depAbsPath);
    if (!depParsed) continue;

    // For each import to a changed file, re-insert its symbols
    for (const imp of importsToReResolve) {
      // Find matching reference in parsed data
      const matchingRef = depParsed.references.find((ref) => {
        const refToFileId = ref.resolvedPath ? (ctx.fileIdMap.get(ref.resolvedPath) ?? null) : null;
        return refToFileId === imp.toFileId;
      });
      if (!matchingRef) continue;

      for (const sym of matchingRef.imports) {
        let defId = resolveSymbolToDefinition(sym, matchingRef, ctx.definitionMap, ctx.fileIdMap, ctx.db);

        if (defId === null && matchingRef.resolvedPath && !matchingRef.isExternal) {
          defId = followReExportChain(
            sym.kind === 'default' ? 'default' : sym.name,
            matchingRef.resolvedPath,
            ctx.allParsedFiles,
            ctx.definitionMap,
            new Set(),
            ctx.conn,
            ctx.fileIdMap
          );
        }

        const symbolId = ctx.db.insertSymbol(imp.id, defId, sym);
        for (const usage of sym.usages) {
          ctx.db.insertUsage(symbolId, usage);
        }
      }
    }

    ctx.result.dependentFilesReResolved++;
  }
}
