import path from 'node:path';
import type { IndexDatabase } from '../../db/database.js';

/**
 * Resolve a file path to a database file ID.
 *
 * Tries three lookup strategies in order:
 * 1. Relative path (db.toRelativePath of the resolved absolute path)
 * 2. Absolute resolved path
 * 3. The original path as-is (handles suffix/partial matches stored in the db)
 *
 * Returns `null` if no match is found.
 */
export function resolveFileId(db: IndexDatabase, filePath: string): number | null {
  const resolvedPath = path.resolve(filePath);
  const relativePath = db.toRelativePath(resolvedPath);
  return db.files.getIdByPath(relativePath) ?? db.files.getIdByPath(resolvedPath) ?? db.files.getIdByPath(filePath);
}
