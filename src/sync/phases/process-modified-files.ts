import path from 'node:path';
import { computeHash } from '../../db/schema.js';
import { cascadeDeleteDefinitions } from '../cascade-delete.js';
import type { FileChange } from '../change-detector.js';
import { deleteFileImportsAndSymbols } from '../reference-resolver.js';
import type { SyncContext } from './sync-context.js';

/**
 * Phase 3 — Process modified files (definition identity matching).
 *
 * For each modified file:
 * 1. Pre-populates fileIdMap from all existing DB files (for re-export resolution).
 * 2. Matches new parsed definitions against existing DB definitions by name+kind.
 * 3. Updates matched definitions in-place (preserving their IDs).
 * 4. Inserts genuinely new definitions that have no DB counterpart.
 * 5. Cascade-deletes definitions that no longer exist in the source.
 * 6. Collects module IDs for removed definitions (before cascade removes rows).
 * 7. Deletes all imports/symbols/usages for the file (re-inserted in Phase 5).
 * 8. Updates the file's content hash.
 *
 * Runs inside the exclusive transaction.
 */
export function processModifiedFiles(modified: FileChange[], ctx: SyncContext): void {
  // Pre-populate fileIdMap from all existing DB files (for re-export resolution)
  const allDbFiles = ctx.db.files.getAllWithHash();
  for (const f of allDbFiles) {
    const absPath = path.resolve(ctx.sourceDirectory, f.path);
    ctx.fileIdMap.set(absPath, f.id);
  }

  for (const change of modified) {
    const parsed = ctx.parsedChanges.get(change.absolutePath);
    if (!parsed) continue;

    const fileId = change.fileId!;
    ctx.changedFileIds.add(fileId);
    ctx.fileIdMap.set(change.absolutePath, fileId);

    // Load existing definitions
    const oldDefs = ctx.db.definitions.getByFileId(fileId);
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
        ctx.db.definitions.updateDefinition(oldDef.id, {
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
        ctx.result.definitionsUpdated++;
        ctx.result.updatedDefinitionIds.push(oldDef.id);

        allDefMap.set(newDef.name, oldDef.id);
        if (newDef.isExported) {
          exportedDefMap.set(newDef.name, oldDef.id);
        }

        // Check if this def has metadata (counts as stale)
        const hasMetadata = ctx.conn
          .prepare('SELECT COUNT(*) as count FROM definition_metadata WHERE definition_id = ?')
          .get(oldDef.id) as { count: number };
        if (hasMetadata.count > 0) {
          ctx.result.staleMetadataCount++;
        }
      } else {
        // ADDED — insert new definition
        const defId = ctx.db.insertDefinition(fileId, newDef);
        ctx.result.definitionsAdded++;
        ctx.result.unassignedCount++;
        ctx.result.addedDefinitionIds.push(defId);

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
        ctx.result.definitionsRemoved++;
        ctx.result.removedDefinitionIds.push(oldDef.id);
      }
    }
    if (removedDefIds.length > 0) {
      // Collect module IDs before cascade-delete removes module_members rows
      const rmPlaceholders = removedDefIds.map(() => '?').join(',');
      const moduleRows = ctx.conn
        .prepare(
          `SELECT DISTINCT module_id as moduleId FROM module_members
           WHERE definition_id IN (${rmPlaceholders})`
        )
        .all(...removedDefIds) as Array<{ moduleId: number }>;
      for (const row of moduleRows) {
        ctx.preDeleteModuleIds.add(row.moduleId);
      }

      cascadeDeleteDefinitions(ctx.conn, removedDefIds);
    }

    ctx.definitionMap.set(change.absolutePath, exportedDefMap);
    ctx.allDefinitionMap.set(change.absolutePath, allDefMap);

    // Delete ALL imports, symbols, usages originating from this file
    deleteFileImportsAndSymbols(ctx.conn, fileId);
    ctx.result.importsRefreshed++;

    // Update file record
    ctx.db.files.updateHash(fileId, computeHash(parsed.content), parsed.sizeBytes, parsed.modifiedAt);
  }
}
