import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureInteractionsTables } from '../../src/db/schema-manager.js';

describe('schema-manager', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('ensureInteractionsTables', () => {
    it('creates interactions table from scratch with confidence column', () => {
      // Need modules table first (FK reference)
      db.exec(`
        CREATE TABLE modules (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER,
          slug TEXT NOT NULL,
          full_path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          depth INTEGER NOT NULL DEFAULT 0,
          color_index INTEGER NOT NULL DEFAULT 0,
          is_test INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      ensureInteractionsTables(db);

      // Verify confidence column exists
      const columns = db.prepare("SELECT name FROM pragma_table_info('interactions')").all() as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain('confidence');
    });

    it('migrates existing table to add confidence column', () => {
      // Create old-style interactions table without confidence
      db.exec(`
        CREATE TABLE modules (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER,
          slug TEXT NOT NULL,
          full_path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          depth INTEGER NOT NULL DEFAULT 0,
          color_index INTEGER NOT NULL DEFAULT 0,
          is_test INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      db.exec(`
        CREATE TABLE interactions (
          id INTEGER PRIMARY KEY,
          from_module_id INTEGER NOT NULL,
          to_module_id INTEGER NOT NULL,
          direction TEXT NOT NULL DEFAULT 'uni',
          weight INTEGER NOT NULL DEFAULT 1,
          pattern TEXT,
          symbols TEXT,
          semantic TEXT,
          source TEXT NOT NULL DEFAULT 'ast',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(from_module_id, to_module_id)
        );
        CREATE INDEX idx_interactions_source ON interactions(source);
      `);

      // Insert data before migration
      db.exec(`
        INSERT INTO modules (id, slug, full_path, name) VALUES (1, 'a', 'project.a', 'A');
        INSERT INTO modules (id, slug, full_path, name) VALUES (2, 'b', 'project.b', 'B');
        INSERT INTO interactions (from_module_id, to_module_id, source) VALUES (1, 2, 'ast');
      `);

      // Run migration
      ensureInteractionsTables(db);

      // Verify confidence column was added
      const columns = db.prepare("SELECT name FROM pragma_table_info('interactions')").all() as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain('confidence');

      // Verify existing data was preserved
      const row = db.prepare('SELECT * FROM interactions').get() as any;
      expect(row.from_module_id).toBe(1);
      expect(row.to_module_id).toBe(2);
      expect(row.confidence).toBeNull();
    });
  });
});
