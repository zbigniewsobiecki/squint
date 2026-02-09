import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from '@oclif/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, withDatabase } from '../../../src/commands/_shared/db-helper.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('db-helper', () => {
  let mockCommand: Command;
  let errorThrown: Error | null;
  let tempDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    errorThrown = null;

    mockCommand = {
      log: vi.fn(),
      error: vi.fn((message: string) => {
        errorThrown = new Error(message);
        throw errorThrown;
      }),
    } as unknown as Command;

    // Create a temporary directory for test databases
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-helper-test-'));
    testDbPath = path.join(tempDir, 'test.db');
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function createTestDatabase(): Promise<void> {
    const db = new Database(testDbPath);
    db.exec(SCHEMA);
    db.close();
  }

  describe('openDatabase', () => {
    it('opens an existing database successfully', async () => {
      await createTestDatabase();

      const db = await openDatabase(testDbPath, mockCommand);

      expect(db).toBeDefined();
      expect(typeof db.close).toBe('function');
      db.close();
    });

    it('throws error for non-existent database', async () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.db');

      await expect(openDatabase(nonExistentPath, mockCommand)).rejects.toThrow();
      expect(mockCommand.error).toHaveBeenCalled();
    });

    it('resolves relative paths correctly', async () => {
      await createTestDatabase();
      const cwd = process.cwd();

      try {
        process.chdir(tempDir);
        const db = await openDatabase('./test.db', mockCommand);
        expect(db).toBeDefined();
        db.close();
      } finally {
        process.chdir(cwd);
      }
    });
  });

  describe('withDatabase', () => {
    it('opens database, executes callback, and closes', async () => {
      await createTestDatabase();
      let dbInCallback: any = null;

      const result = await withDatabase(testDbPath, mockCommand, async (db) => {
        dbInCallback = db;
        return 'callback-result';
      });

      expect(result).toBe('callback-result');
      expect(dbInCallback).toBeDefined();
    });

    it('passes query results through callback', async () => {
      await createTestDatabase();

      const result = await withDatabase(testDbPath, mockCommand, async (db) => {
        // Insert test data
        db.files.insert({
          path: '/test/file.ts',
          language: 'typescript',
          contentHash: 'abc123',
          sizeBytes: 100,
          modifiedAt: '2024-01-01T00:00:00.000Z',
        });

        const stats = db.getStats();
        return stats;
      });

      expect(result.files).toBe(1);
    });

    it('closes database even when callback throws', async () => {
      await createTestDatabase();
      const callbackError = new Error('Callback failed');

      await expect(
        withDatabase(testDbPath, mockCommand, async () => {
          throw callbackError;
        })
      ).rejects.toThrow('Callback failed');

      // Verify database can be opened again (meaning it was properly closed)
      const db = await openDatabase(testDbPath, mockCommand);
      expect(db).toBeDefined();
      db.close();
    });

    it('throws error when database does not exist', async () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.db');

      await expect(
        withDatabase(nonExistentPath, mockCommand, async () => {
          return 'should not reach here';
        })
      ).rejects.toThrow();
    });

    it('supports async operations in callback', async () => {
      await createTestDatabase();

      const result = await withDatabase(testDbPath, mockCommand, async (db) => {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        const stats = db.getStats();
        return stats.files;
      });

      expect(result).toBe(0);
    });
  });
});
