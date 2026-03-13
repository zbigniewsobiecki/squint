import path from 'node:path';
import type { ParsedFile } from '../../parser/ast-parser.js';
import { parseFile } from '../../parser/ast-parser.js';
import type { WorkspaceMap } from '../../parser/workspace-resolver.js';
import type { FileChange } from '../change-detector.js';
import type { SyncContext } from './sync-context.js';

/**
 * Phase 2 — Parse all new + modified files (async, before transaction).
 *
 * Parses each changed file using the AST parser and stores the result
 * in ctx.parsedChanges (and ctx.allParsedFiles).
 */
export async function parseChangedFiles(
  added: FileChange[],
  modified: FileChange[],
  knownFiles: Set<string>,
  workspaceMap: WorkspaceMap | null,
  ctx: SyncContext
): Promise<void> {
  if (ctx.verbose) ctx.log(`  Parsing ${added.length + modified.length} file(s)...`);

  for (const change of [...modified, ...added]) {
    try {
      const parsed = await parseFile(change.absolutePath, knownFiles, workspaceMap);
      ctx.parsedChanges.set(change.absolutePath, parsed);
      ctx.allParsedFiles.set(change.absolutePath, parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`  Warning: Failed to parse ${change.path}: ${message}`);
    }
  }
}

/**
 * Phase 2b — Pre-parse dependent files (async, before transaction).
 *
 * These are unchanged files that import from modified/deleted files.
 * Pre-parsing here ensures Phase 6 (re-resolve dependents) is fully synchronous.
 */
export async function preParseDependentFiles(
  modified: FileChange[],
  deleted: FileChange[],
  knownFiles: Set<string>,
  workspaceMap: WorkspaceMap | null,
  ctx: SyncContext
): Promise<void> {
  const preKnownChangedFileIds = new Set<number>();
  for (const change of [...modified, ...deleted]) {
    if (change.fileId) preKnownChangedFileIds.add(change.fileId);
  }

  if (preKnownChangedFileIds.size === 0) return;

  const prePlaceholders = [...preKnownChangedFileIds].map(() => '?').join(',');
  const preDependentRows = ctx.conn
    .prepare(
      `SELECT DISTINCT i.from_file_id as fileId
       FROM imports i
       WHERE i.to_file_id IN (${prePlaceholders})
         AND i.from_file_id NOT IN (${prePlaceholders})`
    )
    .all(...preKnownChangedFileIds, ...preKnownChangedFileIds) as Array<{ fileId: number }>;

  if (ctx.verbose && preDependentRows.length > 0) {
    ctx.log(`  Pre-parsing ${preDependentRows.length} dependent file(s)...`);
  }

  for (const row of preDependentRows) {
    const depFileInfo = ctx.db.files.getById(row.fileId);
    if (!depFileInfo) continue;
    const depAbsPath = path.resolve(ctx.sourceDirectory, depFileInfo.path);

    if (!ctx.allParsedFiles.has(depAbsPath)) {
      try {
        const depParsed = await parseFile(depAbsPath, knownFiles, workspaceMap);
        ctx.allParsedFiles.set(depAbsPath, depParsed);
      } catch {
        // Will be skipped during Phase 6
      }
    }
  }
}

export type { ParsedFile };
