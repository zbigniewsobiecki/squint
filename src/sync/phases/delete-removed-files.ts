import { cascadeDeleteFile } from '../cascade-delete.js';
import type { FileChange } from '../change-detector.js';
import type { SyncContext } from './sync-context.js';

/**
 * Phase 1 — Delete removed files.
 *
 * For each deleted file:
 * 1. Collects definition IDs (for removedDefinitionIds tracking).
 * 2. Collects module IDs *before* cascade-delete removes module_members rows
 *    (these are needed later by populateDirtySets).
 * 3. Cascade-deletes the file record and all related DB rows.
 *
 * Runs inside the exclusive transaction.
 */
export function deleteRemovedFiles(deleted: FileChange[], ctx: SyncContext): void {
  if (deleted.length === 0) return;

  if (ctx.verbose) ctx.log(`  Deleting ${deleted.length} removed file(s)...`);

  for (const change of deleted) {
    // Collect definition IDs before cascade-delete (for removedDefinitionIds tracking)
    const deletedFileDefs = ctx.conn
      .prepare('SELECT id FROM definitions WHERE file_id = ?')
      .all(change.fileId!) as Array<{ id: number }>;
    const deletedDefIds = deletedFileDefs.map((d) => d.id);
    for (const d of deletedFileDefs) {
      ctx.result.removedDefinitionIds.push(d.id);
      ctx.result.definitionsRemoved++;
    }

    // Collect module IDs before cascade-delete removes module_members rows
    if (deletedDefIds.length > 0) {
      const placeholders = deletedDefIds.map(() => '?').join(',');
      const moduleRows = ctx.conn
        .prepare(
          `SELECT DISTINCT module_id as moduleId FROM module_members
           WHERE definition_id IN (${placeholders})`
        )
        .all(...deletedDefIds) as Array<{ moduleId: number }>;
      for (const row of moduleRows) {
        ctx.preDeleteModuleIds.add(row.moduleId);
      }
    }

    cascadeDeleteFile(ctx.conn, change.fileId!);
  }
}
