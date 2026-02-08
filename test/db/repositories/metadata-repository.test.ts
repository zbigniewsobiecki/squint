import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MetadataRepository } from '../../../src/db/repositories/metadata-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';
import type { Definition } from '../../../src/parser/definition-extractor.js';

describe('MetadataRepository', () => {
  let db: Database.Database;
  let repo: MetadataRepository;
  let fileRepo: FileRepository;
  let fileId: number;
  let defId1: number;
  let defId2: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new MetadataRepository(db);
    fileRepo = new FileRepository(db);

    fileId = fileRepo.insert({
      path: '/test/file.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    defId1 = fileRepo.insertDefinition(fileId, {
      name: 'func1',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 10, column: 1 },
    });

    defId2 = fileRepo.insertDefinition(fileId, {
      name: 'func2',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 15, column: 0 },
      endPosition: { row: 25, column: 1 },
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('set', () => {
    it('sets metadata on a definition', () => {
      repo.set(defId1, 'purpose', 'Calculates the sum of two numbers');

      const value = repo.getValue(defId1, 'purpose');
      expect(value).toBe('Calculates the sum of two numbers');
    });

    it('replaces existing metadata', () => {
      repo.set(defId1, 'purpose', 'Original purpose');
      repo.set(defId1, 'purpose', 'Updated purpose');

      const value = repo.getValue(defId1, 'purpose');
      expect(value).toBe('Updated purpose');
    });
  });

  describe('remove', () => {
    it('removes metadata from a definition', () => {
      repo.set(defId1, 'purpose', 'Some purpose');
      const removed = repo.remove(defId1, 'purpose');

      expect(removed).toBe(true);
      expect(repo.getValue(defId1, 'purpose')).toBeNull();
    });

    it('returns false when removing non-existent metadata', () => {
      const removed = repo.remove(defId1, 'nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('get', () => {
    it('returns all metadata for a definition', () => {
      repo.set(defId1, 'purpose', 'Does something');
      repo.set(defId1, 'domain', '["core"]');
      repo.set(defId1, 'pure', 'true');

      const metadata = repo.get(defId1);
      expect(metadata).toEqual({
        purpose: 'Does something',
        domain: '["core"]',
        pure: 'true',
      });
    });

    it('returns empty object when no metadata', () => {
      const metadata = repo.get(defId1);
      expect(metadata).toEqual({});
    });
  });

  describe('getValue', () => {
    it('returns specific metadata value', () => {
      repo.set(defId1, 'purpose', 'Test purpose');

      const value = repo.getValue(defId1, 'purpose');
      expect(value).toBe('Test purpose');
    });

    it('returns null for non-existent key', () => {
      const value = repo.getValue(defId1, 'nonexistent');
      expect(value).toBeNull();
    });
  });

  describe('getDefinitionsWith', () => {
    it('returns definition IDs that have a specific key', () => {
      repo.set(defId1, 'purpose', 'Purpose 1');
      repo.set(defId2, 'purpose', 'Purpose 2');

      const ids = repo.getDefinitionsWith('purpose');
      expect(ids).toHaveLength(2);
      expect(ids).toContain(defId1);
      expect(ids).toContain(defId2);
    });

    it('returns empty array when no definitions have the key', () => {
      const ids = repo.getDefinitionsWith('nonexistent');
      expect(ids).toHaveLength(0);
    });
  });

  describe('getDefinitionsWithout', () => {
    it('returns definition IDs that do not have a specific key', () => {
      repo.set(defId1, 'purpose', 'Purpose 1');
      // defId2 has no purpose

      const ids = repo.getDefinitionsWithout('purpose');
      expect(ids).toHaveLength(1);
      expect(ids).toContain(defId2);
    });

    it('returns all definitions when none have the key', () => {
      const ids = repo.getDefinitionsWithout('purpose');
      expect(ids).toHaveLength(2);
    });
  });

  describe('getKeys', () => {
    it('returns all unique metadata keys', () => {
      repo.set(defId1, 'purpose', 'Purpose 1');
      repo.set(defId1, 'domain', '["core"]');
      repo.set(defId2, 'purpose', 'Purpose 2');
      repo.set(defId2, 'role', 'utility');

      const keys = repo.getKeys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain('purpose');
      expect(keys).toContain('domain');
      expect(keys).toContain('role');
    });

    it('returns keys in sorted order', () => {
      repo.set(defId1, 'z-key', 'value');
      repo.set(defId1, 'a-key', 'value');
      repo.set(defId1, 'm-key', 'value');

      const keys = repo.getKeys();
      expect(keys).toEqual(['a-key', 'm-key', 'z-key']);
    });
  });

  describe('getFilteredCount', () => {
    it('returns count of definitions matching filters', () => {
      expect(repo.getFilteredCount()).toBe(2);
      expect(repo.getFilteredCount({ kind: 'function' })).toBe(2);
      expect(repo.getFilteredCount({ kind: 'class' })).toBe(0);
      expect(repo.getFilteredCount({ filePattern: 'file.ts' })).toBe(2);
    });
  });

  describe('getAspectCoverage', () => {
    it('returns coverage stats for all aspects', () => {
      repo.set(defId1, 'purpose', 'Purpose 1');
      repo.set(defId1, 'domain', '["core"]');
      repo.set(defId2, 'purpose', 'Purpose 2');
      // defId2 has no domain

      const coverage = repo.getAspectCoverage();

      const purposeCoverage = coverage.find(c => c.aspect === 'purpose');
      expect(purposeCoverage).toBeDefined();
      expect(purposeCoverage!.covered).toBe(2);
      expect(purposeCoverage!.total).toBe(2);
      expect(purposeCoverage!.percentage).toBe(100);

      const domainCoverage = coverage.find(c => c.aspect === 'domain');
      expect(domainCoverage).toBeDefined();
      expect(domainCoverage!.covered).toBe(1);
      expect(domainCoverage!.total).toBe(2);
      expect(domainCoverage!.percentage).toBe(50);
    });

    it('returns empty array when no definitions', () => {
      // Delete all definitions first
      db.exec('DELETE FROM definitions');

      const coverage = repo.getAspectCoverage();
      expect(coverage).toHaveLength(0);
    });

    it('respects filters', () => {
      repo.set(defId1, 'purpose', 'Purpose 1');

      const coverage = repo.getAspectCoverage({ kind: 'function' });
      expect(coverage).toHaveLength(1);
      expect(coverage[0].total).toBe(2);
    });
  });

  describe('getAllDomains', () => {
    it('returns all unique domains from metadata', () => {
      repo.set(defId1, 'domain', '["auth", "core"]');
      repo.set(defId2, 'domain', '["core", "api"]');

      const domains = repo.getAllDomains();
      expect(domains).toHaveLength(3);
      expect(domains).toContain('auth');
      expect(domains).toContain('core');
      expect(domains).toContain('api');
    });

    it('returns sorted domains', () => {
      repo.set(defId1, 'domain', '["zebra", "alpha"]');

      const domains = repo.getAllDomains();
      expect(domains).toEqual(['alpha', 'zebra']);
    });

    it('skips invalid JSON', () => {
      repo.set(defId1, 'domain', 'invalid json');
      repo.set(defId2, 'domain', '["valid"]');

      const domains = repo.getAllDomains();
      expect(domains).toEqual(['valid']);
    });
  });

  describe('getSymbolsByDomain', () => {
    it('returns symbols with a specific domain', () => {
      repo.set(defId1, 'domain', '["auth", "core"]');
      repo.set(defId1, 'purpose', 'Auth function');
      repo.set(defId2, 'domain', '["api"]');

      const symbols = repo.getSymbolsByDomain('auth');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe('func1');
      expect(symbols[0].domains).toEqual(['auth', 'core']);
      expect(symbols[0].purpose).toBe('Auth function');
    });

    it('returns empty array when no symbols have domain', () => {
      const symbols = repo.getSymbolsByDomain('nonexistent');
      expect(symbols).toHaveLength(0);
    });
  });

  describe('getSymbolsByPurity', () => {
    it('returns pure symbols', () => {
      repo.set(defId1, 'pure', 'true');
      repo.set(defId1, 'purpose', 'Pure function');
      repo.set(defId2, 'pure', 'false');

      const pureSymbols = repo.getSymbolsByPurity(true);
      expect(pureSymbols).toHaveLength(1);
      expect(pureSymbols[0].name).toBe('func1');
      expect(pureSymbols[0].purpose).toBe('Pure function');
    });

    it('returns impure symbols', () => {
      repo.set(defId1, 'pure', 'true');
      repo.set(defId2, 'pure', 'false');
      repo.set(defId2, 'purpose', 'Impure function');

      const impureSymbols = repo.getSymbolsByPurity(false);
      expect(impureSymbols).toHaveLength(1);
      expect(impureSymbols[0].name).toBe('func2');
    });
  });
});
