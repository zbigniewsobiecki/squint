import fs from 'node:fs/promises';
import path from 'node:path';
import type { IndexDatabase } from '../db/database-facade.js';
import { computeHash } from '../db/schema.js';
import { scanDirectory } from '../utils/file-scanner.js';

export interface FileChange {
  path: string; // relative to sourceDir
  absolutePath: string;
  status: 'new' | 'modified' | 'deleted';
  fileId?: number; // present for modified/deleted (existing DB id)
}

export interface ChangeDetectionResult {
  changes: FileChange[];
  unchangedCount: number;
}

/**
 * Detect which files changed since last indexing by comparing content hashes.
 */
export async function detectChanges(sourceDirectory: string, db: IndexDatabase): Promise<ChangeDetectionResult> {
  // 1. Scan current files on disk
  const currentFiles = await scanDirectory(sourceDirectory);

  // 2. Get known files from DB with their content hashes
  const dbFiles = db.files.getAllWithHash();
  const dbFileMap = new Map<string, { id: number; contentHash: string }>();
  for (const f of dbFiles) {
    dbFileMap.set(f.path, { id: f.id, contentHash: f.contentHash });
  }

  // 3. Build set of current relative paths for deletion detection
  const currentRelativePaths = new Set<string>();
  const changes: FileChange[] = [];
  let unchangedCount = 0;

  for (const absolutePath of currentFiles) {
    const relativePath = path.relative(sourceDirectory, absolutePath);
    currentRelativePaths.add(relativePath);

    const dbEntry = dbFileMap.get(relativePath);
    if (!dbEntry) {
      // New file
      changes.push({ path: relativePath, absolutePath, status: 'new' });
    } else {
      // Existing file — compare content hash
      const content = await fs.readFile(absolutePath, 'utf-8');
      const currentHash = computeHash(content);
      if (currentHash !== dbEntry.contentHash) {
        changes.push({
          path: relativePath,
          absolutePath,
          status: 'modified',
          fileId: dbEntry.id,
        });
      } else {
        unchangedCount++;
      }
    }
  }

  // 4. Detect deleted files (in DB but not on disk)
  for (const [relativePath, dbEntry] of dbFileMap) {
    if (!currentRelativePaths.has(relativePath)) {
      changes.push({
        path: relativePath,
        absolutePath: path.resolve(sourceDirectory, relativePath),
        status: 'deleted',
        fileId: dbEntry.id,
      });
    }
  }

  return { changes, unchangedCount };
}
