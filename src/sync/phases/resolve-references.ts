import type { FileChange } from '../change-detector.js';
import { insertFileReferences, insertInternalUsages } from '../reference-resolver.js';
import type { SyncContext } from './sync-context.js';

/**
 * Phase 5 — Resolve references for changed files.
 *
 * 1. Builds full definition maps for ALL files (loading unchanged files from DB).
 * 2. Inserts imports, symbols, and usages for each changed file.
 *
 * Runs inside the exclusive transaction.
 */
export function resolveReferences(
  added: FileChange[],
  modified: FileChange[],
  allDiskFiles: string[],
  ctx: SyncContext
): void {
  // Build full definition maps for ALL files (needed for cross-file resolution).
  // For unchanged files, load from DB.
  for (const absPath of allDiskFiles) {
    if (ctx.definitionMap.has(absPath)) continue; // Already populated for changed files
    const fId = ctx.fileIdMap.get(absPath);
    if (!fId) continue;

    const defs = ctx.db.definitions.getByFileId(fId);
    const expMap = new Map<string, number>();
    const allMap = new Map<string, number>();
    for (const d of defs) {
      allMap.set(d.name, d.id);
      if (d.isExported) {
        expMap.set(d.name, d.id);
      }
    }
    ctx.definitionMap.set(absPath, expMap);
    ctx.allDefinitionMap.set(absPath, allMap);
  }

  // Insert references and symbols for changed files
  for (const change of [...modified, ...added]) {
    const parsed = ctx.parsedChanges.get(change.absolutePath);
    if (!parsed) continue;
    const fromFileId = ctx.fileIdMap.get(change.absolutePath)!;

    insertFileReferences(parsed, fromFileId, ctx.db, ctx.fileIdMap, ctx.definitionMap, ctx.allParsedFiles, ctx.conn);
  }

  // Insert internal usages for changed files
  for (const change of [...modified, ...added]) {
    const parsed = ctx.parsedChanges.get(change.absolutePath);
    if (!parsed) continue;
    const fileId = ctx.fileIdMap.get(change.absolutePath)!;

    insertInternalUsages(parsed, fileId, change.absolutePath, ctx.allDefinitionMap, ctx.db);
  }
}
