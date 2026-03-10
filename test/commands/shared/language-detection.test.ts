import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFileLanguageMap, detectProjectLanguage } from '../../../src/commands/_shared/language-detection.js';
import type { IndexDatabase } from '../../../src/db/database.js';

/**
 * Create a minimal mock that satisfies the IndexDatabase interface
 * enough for language-detection to work (just needs getConnection()).
 */
function createMockDb(): { db: IndexDatabase; conn: Database.Database } {
  const conn = new Database(':memory:');
  conn.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      language TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      modified_at TEXT NOT NULL
    );
  `);
  const db = { getConnection: () => conn } as unknown as IndexDatabase;
  return { db, conn };
}

function insertFile(conn: Database.Database, path: string, language: string): void {
  conn
    .prepare('INSERT INTO files (path, language, content_hash, size_bytes, modified_at) VALUES (?, ?, ?, ?, ?)')
    .run(path, language, 'abc123', 100, '2025-01-01');
}

describe('language-detection', () => {
  let db: IndexDatabase;
  let conn: Database.Database;

  beforeEach(() => {
    const mock = createMockDb();
    db = mock.db;
    conn = mock.conn;
  });

  afterEach(() => {
    conn.close();
  });

  // ===========================================
  // detectProjectLanguage
  // ===========================================
  describe('detectProjectLanguage', () => {
    it('returns typescript when no files exist', () => {
      expect(detectProjectLanguage(db)).toBe('typescript');
    });

    it('returns typescript when majority is TypeScript', () => {
      insertFile(conn, '/src/a.ts', 'TypeScript');
      insertFile(conn, '/src/b.ts', 'TypeScript');
      insertFile(conn, '/src/c.js', 'JavaScript');
      expect(detectProjectLanguage(db)).toBe('typescript');
    });

    it('returns javascript when majority is JavaScript', () => {
      insertFile(conn, '/src/a.js', 'JavaScript');
      insertFile(conn, '/src/b.js', 'JavaScript');
      insertFile(conn, '/src/c.ts', 'TypeScript');
      expect(detectProjectLanguage(db)).toBe('javascript');
    });

    it('returns ruby when majority is Ruby', () => {
      insertFile(conn, '/app/models/user.rb', 'Ruby');
      insertFile(conn, '/app/models/post.rb', 'Ruby');
      insertFile(conn, '/config/app.js', 'JavaScript');
      expect(detectProjectLanguage(db)).toBe('ruby');
    });

    it('is case-insensitive for language column', () => {
      insertFile(conn, '/app/a.rb', 'ruby');
      insertFile(conn, '/app/b.rb', 'RUBY');
      expect(detectProjectLanguage(db)).toBe('ruby');
    });

    it('returns typescript for unknown languages', () => {
      insertFile(conn, '/src/a.py', 'Python');
      expect(detectProjectLanguage(db)).toBe('typescript');
    });
  });

  // ===========================================
  // buildFileLanguageMap
  // ===========================================
  describe('buildFileLanguageMap', () => {
    it('returns empty map when no files exist', () => {
      const map = buildFileLanguageMap(db);
      expect(map.size).toBe(0);
    });

    it('maps TypeScript files correctly', () => {
      insertFile(conn, '/src/a.ts', 'TypeScript');
      const map = buildFileLanguageMap(db);
      expect(map.get('/src/a.ts')).toBe('typescript');
    });

    it('maps JavaScript files correctly', () => {
      insertFile(conn, '/src/a.js', 'JavaScript');
      const map = buildFileLanguageMap(db);
      expect(map.get('/src/a.js')).toBe('javascript');
    });

    it('maps Ruby files correctly', () => {
      insertFile(conn, '/app/models/user.rb', 'Ruby');
      const map = buildFileLanguageMap(db);
      expect(map.get('/app/models/user.rb')).toBe('ruby');
    });

    it('maps mixed-language project correctly', () => {
      insertFile(conn, '/src/index.ts', 'TypeScript');
      insertFile(conn, '/app/models/user.rb', 'Ruby');
      insertFile(conn, '/lib/helper.js', 'JavaScript');

      const map = buildFileLanguageMap(db);
      expect(map.size).toBe(3);
      expect(map.get('/src/index.ts')).toBe('typescript');
      expect(map.get('/app/models/user.rb')).toBe('ruby');
      expect(map.get('/lib/helper.js')).toBe('javascript');
    });

    it('falls back to typescript for unknown languages', () => {
      insertFile(conn, '/src/a.py', 'Python');
      const map = buildFileLanguageMap(db);
      expect(map.get('/src/a.py')).toBe('typescript');
    });

    it('is case-insensitive for language column', () => {
      insertFile(conn, '/app/a.rb', 'ruby');
      insertFile(conn, '/app/b.rb', 'RUBY');
      const map = buildFileLanguageMap(db);
      expect(map.get('/app/a.rb')).toBe('ruby');
      expect(map.get('/app/b.rb')).toBe('ruby');
    });
  });
});
