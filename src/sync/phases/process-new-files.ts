import { computeHash } from '../../db/schema.js';
import type { FileChange } from '../change-detector.js';
import type { SyncContext } from './sync-context.js';

/**
 * Phase 4 — Process new files.
 *
 * For each added file:
 * 1. Inserts a new file record into the DB.
 * 2. Inserts all parsed definitions.
 * 3. Populates fileIdMap, definitionMap, and allDefinitionMap.
 *
 * Runs inside the exclusive transaction.
 */
export function processNewFiles(added: FileChange[], ctx: SyncContext): void {
  for (const change of added) {
    const parsed = ctx.parsedChanges.get(change.absolutePath);
    if (!parsed) continue;

    const fileId = ctx.db.insertFile({
      path: change.path,
      language: parsed.language,
      contentHash: computeHash(parsed.content),
      sizeBytes: parsed.sizeBytes,
      modifiedAt: parsed.modifiedAt,
    });
    ctx.changedFileIds.add(fileId);
    ctx.fileIdMap.set(change.absolutePath, fileId);

    const exportedDefMap = new Map<string, number>();
    const allDefMap = new Map<string, number>();
    for (const def of parsed.definitions) {
      const defId = ctx.db.insertDefinition(fileId, def);
      allDefMap.set(def.name, defId);
      if (def.isExported) {
        exportedDefMap.set(def.name, defId);
      }
      ctx.result.definitionsAdded++;
      ctx.result.unassignedCount++;
      ctx.result.addedDefinitionIds.push(defId);
    }
    ctx.definitionMap.set(change.absolutePath, exportedDefMap);
    ctx.allDefinitionMap.set(change.absolutePath, allDefMap);
  }
}
