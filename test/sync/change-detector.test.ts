import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database.js';
import { computeHash } from '../../src/db/schema.js';
import { detectChanges } from '../../src/sync/change-detector.js';

describe('change-detector', () => {
  let db: IndexDatabase;
  let tempDir: string;

  beforeEach(async () => {
    db = new IndexDatabase(':memory:');
    db.initialize();

    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'squint-test-'));
  });

  afterEach(async () => {
    db.close();
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function createFile(relativePath: string, content: string): Promise<string> {
    const fullPath = path.join(tempDir, relativePath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    return fullPath;
  }

  function insertFile(relativePath: string, content: string): number {
    const hash = computeHash(content);
    return db.files.insert({
      path: relativePath,
      language: 'typescript',
      contentHash: hash,
      sizeBytes: content.length,
      modifiedAt: '2024-01-01',
    });
  }

  describe('detectChanges', () => {
    it('detects new files', async () => {
      await createFile('new.ts', 'export const x = 1;');

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].status).toBe('new');
      expect(result.changes[0].path).toBe('new.ts');
      expect(result.unchangedCount).toBe(0);
    });

    it('detects modified files', async () => {
      const content = 'export const x = 1;';
      const newContent = 'export const x = 2;';

      await createFile('modified.ts', newContent);
      insertFile('modified.ts', content); // Insert with old content hash

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].status).toBe('modified');
      expect(result.changes[0].path).toBe('modified.ts');
      expect(result.changes[0].fileId).toBeDefined();
      expect(result.unchangedCount).toBe(0);
    });

    it('detects deleted files', async () => {
      insertFile('deleted.ts', 'export const x = 1;');
      // Don't create the file on disk

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].status).toBe('deleted');
      expect(result.changes[0].path).toBe('deleted.ts');
      expect(result.changes[0].fileId).toBeDefined();
      expect(result.unchangedCount).toBe(0);
    });

    it('detects unchanged files', async () => {
      const content = 'export const x = 1;';
      await createFile('unchanged.ts', content);
      insertFile('unchanged.ts', content);

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(0);
      expect(result.unchangedCount).toBe(1);
    });

    it('handles mixed scenarios', async () => {
      // Unchanged file
      const unchanged = 'export const a = 1;';
      await createFile('unchanged.ts', unchanged);
      insertFile('unchanged.ts', unchanged);

      // Modified file
      await createFile('modified.ts', 'export const b = 2;');
      insertFile('modified.ts', 'export const b = 1;');

      // New file
      await createFile('new.ts', 'export const c = 3;');

      // Deleted file
      insertFile('deleted.ts', 'export const d = 4;');

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(3);
      expect(result.unchangedCount).toBe(1);

      const newFile = result.changes.find((c) => c.status === 'new');
      const modifiedFile = result.changes.find((c) => c.status === 'modified');
      const deletedFile = result.changes.find((c) => c.status === 'deleted');

      expect(newFile?.path).toBe('new.ts');
      expect(modifiedFile?.path).toBe('modified.ts');
      expect(modifiedFile?.fileId).toBeDefined();
      expect(deletedFile?.path).toBe('deleted.ts');
      expect(deletedFile?.fileId).toBeDefined();
    });

    it('handles empty directory and empty database', async () => {
      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(0);
      expect(result.unchangedCount).toBe(0);
    });

    it('handles files in subdirectories', async () => {
      await createFile('src/utils/helper.ts', 'export const helper = 1;');

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].status).toBe('new');
      expect(result.changes[0].path).toBe(path.join('src', 'utils', 'helper.ts'));
    });

    it('correctly sets absolutePath for all change types', async () => {
      await createFile('new.ts', 'export const x = 1;');
      await createFile('modified.ts', 'export const y = 2;');
      insertFile('modified.ts', 'export const y = 1;');
      insertFile('deleted.ts', 'export const z = 3;');

      const result = await detectChanges(tempDir, db);

      for (const change of result.changes) {
        expect(path.isAbsolute(change.absolutePath)).toBe(true);
        if (change.status !== 'deleted') {
          // Verify file exists
          await expect(fs.access(change.absolutePath)).resolves.toBeUndefined();
        }
      }
    });

    it('detects multiple new files', async () => {
      await createFile('a.ts', 'export const a = 1;');
      await createFile('b.ts', 'export const b = 2;');
      await createFile('c.ts', 'export const c = 3;');

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(3);
      expect(result.changes.every((c) => c.status === 'new')).toBe(true);
    });

    it('detects multiple modified files', async () => {
      await createFile('a.ts', 'export const a = 2;');
      await createFile('b.ts', 'export const b = 3;');
      insertFile('a.ts', 'export const a = 1;');
      insertFile('b.ts', 'export const b = 2;');

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(2);
      expect(result.changes.every((c) => c.status === 'modified')).toBe(true);
      expect(result.changes.every((c) => c.fileId !== undefined)).toBe(true);
    });

    it('detects multiple deleted files', async () => {
      insertFile('a.ts', 'export const a = 1;');
      insertFile('b.ts', 'export const b = 2;');
      insertFile('c.ts', 'export const c = 3;');

      const result = await detectChanges(tempDir, db);

      expect(result.changes).toHaveLength(3);
      expect(result.changes.every((c) => c.status === 'deleted')).toBe(true);
      expect(result.changes.every((c) => c.fileId !== undefined)).toBe(true);
    });
  });
});
