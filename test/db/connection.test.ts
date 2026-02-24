import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeConnection, createConnection, initializeSchema } from '../../src/db/connection.js';

describe('connection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-conn-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createConnection', () => {
    it('creates a database file and returns a connection', () => {
      const dbPath = path.join(tmpDir, 'test.db');
      const db = createConnection(dbPath);
      expect(db).toBeDefined();
      expect(fs.existsSync(dbPath)).toBe(true);
      db.close();
    });

    it('enables WAL mode', () => {
      const dbPath = path.join(tmpDir, 'wal.db');
      const db = createConnection(dbPath);
      const mode = db.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
      db.close();
    });

    it('sets busy_timeout to 5000ms', () => {
      const dbPath = path.join(tmpDir, 'busy.db');
      const db = createConnection(dbPath);
      const timeout = db.pragma('busy_timeout', { simple: true });
      expect(timeout).toBe(5000);
      db.close();
    });
  });

  describe('initializeSchema', () => {
    it('creates all tables', () => {
      const dbPath = path.join(tmpDir, 'schema.db');
      const db = createConnection(dbPath);
      initializeSchema(db);

      // Verify key tables exist
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('files');
      expect(tableNames).toContain('definitions');
      expect(tableNames).toContain('imports');
      expect(tableNames).toContain('usages');
      expect(tableNames).toContain('symbols');
      expect(tableNames).toContain('metadata');

      db.close();
    });

    it('creates all expected tables including flow tables', () => {
      const dbPath = path.join(tmpDir, 'alltables.db');
      const db = createConnection(dbPath);
      initializeSchema(db);

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('flows');
      expect(tableNames).toContain('flow_steps');
      expect(tableNames).toContain('flow_definition_steps');
      expect(tableNames).toContain('interactions');
      expect(tableNames).toContain('modules');
      expect(tableNames).toContain('module_members');
      expect(tableNames).toContain('relationship_annotations');

      db.close();
    });
  });

  describe('closeConnection', () => {
    it('closes the database connection', () => {
      const dbPath = path.join(tmpDir, 'close.db');
      const db = createConnection(dbPath);
      initializeSchema(db);

      closeConnection(db);

      // After closing, operations should throw
      expect(() => db.prepare('SELECT 1')).toThrow();
    });
  });
});
