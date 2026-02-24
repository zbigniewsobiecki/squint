import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database-facade.js';
import { computeHash } from '../../src/db/schema.js';
import { detectChanges } from '../../src/sync/change-detector.js';

describe('change-detector', () => {
  let tmpDir: string;
  let srcDir: string;
  let db: IndexDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-change-test-'));
    srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const dbPath = path.join(tmpDir, 'test.db');
    db = new IndexDatabase(dbPath);
    db.initialize();
    db.setMetadata('source_directory', srcDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectChanges', () => {
    it('detects new files', async () => {
      // Create a file on disk but not in DB
      const newFilePath = path.join(srcDir, 'new.ts');
      const newFileContent = 'export const x = 1;';
      fs.writeFileSync(newFilePath, newFileContent);

      const result = await detectChanges(srcDir, db);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].status).toBe('new');
      expect(result.changes[0].path).toBe('new.ts');
      expect(result.unchangedCount).toBe(0);
    });

    it('detects modified files by content hash', async () => {
      // Setup: Insert a file into DB
      const filePath = path.join(srcDir, 'modified.ts');
      const originalContent = 'export const a = 1;';
      fs.writeFileSync(filePath, originalContent);

      db.insertFile({
        path: 'modified.ts',
        language: 'typescript',
        contentHash: computeHash(originalContent),
        sizeBytes: Buffer.byteLength(originalContent),
        modifiedAt: new Date().toISOString(),
      });

      // Modify the file on disk
      const modifiedContent = 'export const a = 2;';
      fs.writeFileSync(filePath, modifiedContent);

      const result = await detectChanges(srcDir, db);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].status).toBe('modified');
      expect(result.changes[0].path).toBe('modified.ts');
      expect(result.changes[0].fileId).toBeDefined();
      expect(result.unchangedCount).toBe(0);
    });

    it('detects deleted files', async () => {
      // Setup: Insert a file into DB but don't create it on disk
      db.insertFile({
        path: 'deleted.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: new Date().toISOString(),
      });

      const result = await detectChanges(srcDir, db);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].status).toBe('deleted');
      expect(result.changes[0].path).toBe('deleted.ts');
      expect(result.changes[0].fileId).toBeDefined();
      expect(result.unchangedCount).toBe(0);
    });

    it('detects unchanged files', async () => {
      // Setup: Create a file on disk and in DB with matching hash
      const filePath = path.join(srcDir, 'unchanged.ts');
      const content = 'export const unchanged = true;';
      fs.writeFileSync(filePath, content);

      db.insertFile({
        path: 'unchanged.ts',
        language: 'typescript',
        contentHash: computeHash(content),
        sizeBytes: Buffer.byteLength(content),
        modifiedAt: new Date().toISOString(),
      });

      const result = await detectChanges(srcDir, db);

      expect(result.changes).toHaveLength(0);
      expect(result.unchangedCount).toBe(1);
    });

    it('handles mixed scenario with new, modified, deleted, and unchanged files', async () => {
      // Unchanged file
      const unchangedPath = path.join(srcDir, 'unchanged.ts');
      const unchangedContent = 'export const x = 1;';
      fs.writeFileSync(unchangedPath, unchangedContent);
      db.insertFile({
        path: 'unchanged.ts',
        language: 'typescript',
        contentHash: computeHash(unchangedContent),
        sizeBytes: Buffer.byteLength(unchangedContent),
        modifiedAt: new Date().toISOString(),
      });

      // Modified file
      const modifiedPath = path.join(srcDir, 'modified.ts');
      const originalModified = 'export const y = 1;';
      fs.writeFileSync(modifiedPath, 'export const y = 2;'); // Different content
      db.insertFile({
        path: 'modified.ts',
        language: 'typescript',
        contentHash: computeHash(originalModified),
        sizeBytes: Buffer.byteLength(originalModified),
        modifiedAt: new Date().toISOString(),
      });

      // New file
      const newPath = path.join(srcDir, 'new.ts');
      fs.writeFileSync(newPath, 'export const z = 3;');

      // Deleted file (in DB but not on disk)
      db.insertFile({
        path: 'deleted.ts',
        language: 'typescript',
        contentHash: computeHash('deleted'),
        sizeBytes: 100,
        modifiedAt: new Date().toISOString(),
      });

      const result = await detectChanges(srcDir, db);

      expect(result.changes).toHaveLength(3);
      expect(result.unchangedCount).toBe(1);

      const newChange = result.changes.find((c) => c.status === 'new');
      expect(newChange).toBeDefined();
      expect(newChange?.path).toBe('new.ts');

      const modifiedChange = result.changes.find((c) => c.status === 'modified');
      expect(modifiedChange).toBeDefined();
      expect(modifiedChange?.path).toBe('modified.ts');
      expect(modifiedChange?.fileId).toBeDefined();

      const deletedChange = result.changes.find((c) => c.status === 'deleted');
      expect(deletedChange).toBeDefined();
      expect(deletedChange?.path).toBe('deleted.ts');
      expect(deletedChange?.fileId).toBeDefined();
    });

    it('handles empty directory with no DB files', async () => {
      const result = await detectChanges(srcDir, db);

      expect(result.changes).toHaveLength(0);
      expect(result.unchangedCount).toBe(0);
    });

    it('handles subdirectories correctly', async () => {
      // Create nested directory structure
      const subDir = path.join(srcDir, 'utils');
      fs.mkdirSync(subDir, { recursive: true });

      const nestedFilePath = path.join(subDir, 'helper.ts');
      const nestedContent = 'export const helper = 1;';
      fs.writeFileSync(nestedFilePath, nestedContent);

      const result = await detectChanges(srcDir, db);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].status).toBe('new');
      expect(result.changes[0].path).toBe(path.join('utils', 'helper.ts'));
    });
  });
});
