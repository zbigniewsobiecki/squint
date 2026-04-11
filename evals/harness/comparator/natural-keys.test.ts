import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../../src/db/database-facade.js';
import { computeHash } from '../../../src/db/schema.js';
import {
  contractKeyOfRow,
  definitionKeyOf,
  fileKeyOfRow,
  flowKeyOfRow,
  interactionKeyOfRow,
  moduleKeyOfRow,
} from './natural-keys.js';

/**
 * Natural-key extractors must be ID-agnostic. Two DBs created with different
 * insertion orders (and therefore different IDs) for the SAME logical content
 * must yield the SAME natural keys.
 */
describe('natural-keys', () => {
  let dbPath: string;
  let db: IndexDatabase;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-eval-nk-'));
    dbPath = path.join(dir, 'test.db');
    db = new IndexDatabase(dbPath);
    db.initialize();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  describe('fileKeyOfRow', () => {
    it('uses the path column verbatim', () => {
      expect(fileKeyOfRow({ path: 'src/index.ts' })).toBe('src/index.ts');
    });
  });

  describe('definitionKeyOf', () => {
    it('joins file path and definition name with ::', () => {
      const fileId = db.files.insert({
        path: 'src/foo.ts',
        language: 'typescript',
        contentHash: computeHash('x'),
        sizeBytes: 1,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      });
      const defId = db.files.insertDefinition(fileId, {
        name: 'MyClass',
        kind: 'class',
        isExported: true,
        isDefault: false,
        position: { row: 4, column: 0 },
        endPosition: { row: 10, column: 1 },
      });
      expect(definitionKeyOf(db, defId)).toBe('src/foo.ts::MyClass');
    });

    it('returns the same key regardless of insertion order', () => {
      // Insert two files in order A, B then build a fresh DB inserting B, A.
      const fileAId = db.files.insert({
        path: 'a.ts',
        language: 'typescript',
        contentHash: computeHash('a'),
        sizeBytes: 1,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      });
      const fileBId = db.files.insert({
        path: 'b.ts',
        language: 'typescript',
        contentHash: computeHash('b'),
        sizeBytes: 1,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      });
      const defAId = db.files.insertDefinition(fileAId, {
        name: 'a',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 1, column: 0 },
      });
      const defBId = db.files.insertDefinition(fileBId, {
        name: 'b',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 1, column: 0 },
      });

      expect(definitionKeyOf(db, defAId)).toBe('a.ts::a');
      expect(definitionKeyOf(db, defBId)).toBe('b.ts::b');

      // Reverse-order DB
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-eval-nk2-'));
      const dbPath2 = path.join(dir2, 'test.db');
      const db2 = new IndexDatabase(dbPath2);
      db2.initialize();
      const fileBId2 = db2.files.insert({
        path: 'b.ts',
        language: 'typescript',
        contentHash: computeHash('b'),
        sizeBytes: 1,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      });
      const fileAId2 = db2.files.insert({
        path: 'a.ts',
        language: 'typescript',
        contentHash: computeHash('a'),
        sizeBytes: 1,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      });
      const defBId2 = db2.files.insertDefinition(fileBId2, {
        name: 'b',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 1, column: 0 },
      });
      const defAId2 = db2.files.insertDefinition(fileAId2, {
        name: 'a',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 1, column: 0 },
      });

      // IDs differ but natural keys are stable
      expect(defAId2).not.toBe(defAId);
      expect(definitionKeyOf(db2, defAId2)).toBe('a.ts::a');
      expect(definitionKeyOf(db2, defBId2)).toBe('b.ts::b');

      db2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('throws on unknown definition id', () => {
      expect(() => definitionKeyOf(db, 99999)).toThrow();
    });
  });

  describe('moduleKeyOfRow', () => {
    it('uses the fullPath column', () => {
      expect(moduleKeyOfRow({ fullPath: 'project.controllers' })).toBe('project.controllers');
    });
  });

  describe('contractKeyOfRow', () => {
    it('joins protocol and normalizedKey with ::', () => {
      expect(contractKeyOfRow({ protocol: 'http', normalizedKey: 'POST /api/auth/login' })).toBe(
        'http::POST /api/auth/login'
      );
    });

    it('handles event-style normalized keys', () => {
      expect(contractKeyOfRow({ protocol: 'events', normalizedKey: 'task.completed' })).toBe('events::task.completed');
    });
  });

  describe('interactionKeyOfRow', () => {
    it('joins from and to module paths with arrow', () => {
      expect(
        interactionKeyOfRow({
          fromModulePath: 'project.controllers',
          toModulePath: 'project.services',
        })
      ).toBe('project.controllers->project.services');
    });
  });

  describe('flowKeyOfRow', () => {
    it('uses the slug', () => {
      expect(flowKeyOfRow({ slug: 'user-login' })).toBe('user-login');
    });
  });
});
