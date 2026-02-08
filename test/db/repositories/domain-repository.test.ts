import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DomainRepository } from '../../../src/db/repositories/domain-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { MetadataRepository } from '../../../src/db/repositories/metadata-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('DomainRepository', () => {
  let db: Database.Database;
  let repo: DomainRepository;
  let fileRepo: FileRepository;
  let metadataRepo: MetadataRepository;
  let fileId: number;
  let defId1: number;
  let defId2: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new DomainRepository(db);
    fileRepo = new FileRepository(db);
    metadataRepo = new MetadataRepository(db);

    fileId = fileRepo.insert({
      path: '/test/file.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    defId1 = fileRepo.insertDefinition(fileId, {
      name: 'AuthService',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    defId2 = fileRepo.insertDefinition(fileId, {
      name: 'UserController',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 25, column: 0 },
      endPosition: { row: 45, column: 1 },
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('add', () => {
    it('adds a new domain and returns its ID', () => {
      const id = repo.add('authentication', 'Handles user authentication');

      expect(id).toBe(1);

      const domain = repo.get('authentication');
      expect(domain).not.toBeNull();
      expect(domain!.name).toBe('authentication');
      expect(domain!.description).toBe('Handles user authentication');
    });

    it('returns null for duplicate domain', () => {
      repo.add('authentication');
      const id = repo.add('authentication');

      expect(id).toBeNull();
    });

    it('adds domain without description', () => {
      const id = repo.add('core');

      expect(id).not.toBeNull();
      const domain = repo.get('core');
      expect(domain!.description).toBeNull();
    });
  });

  describe('get', () => {
    it('returns domain by name', () => {
      repo.add('authentication', 'Auth domain');

      const domain = repo.get('authentication');
      expect(domain).not.toBeNull();
      expect(domain!.name).toBe('authentication');
    });

    it('returns null for non-existent domain', () => {
      const domain = repo.get('nonexistent');
      expect(domain).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns all domains', () => {
      repo.add('auth');
      repo.add('api');
      repo.add('core');

      const domains = repo.getAll();
      expect(domains).toHaveLength(3);
      expect(domains.map(d => d.name)).toEqual(['api', 'auth', 'core']); // sorted
    });

    it('returns empty array when no domains', () => {
      const domains = repo.getAll();
      expect(domains).toHaveLength(0);
    });
  });

  describe('getAllWithCounts', () => {
    it('returns domains with symbol counts', () => {
      repo.add('auth');
      repo.add('api');

      metadataRepo.set(defId1, 'domain', '["auth"]');
      metadataRepo.set(defId2, 'domain', '["auth", "api"]');

      const domains = repo.getAllWithCounts();

      const authDomain = domains.find(d => d.name === 'auth');
      expect(authDomain!.symbolCount).toBe(2);

      const apiDomain = domains.find(d => d.name === 'api');
      expect(apiDomain!.symbolCount).toBe(1);
    });
  });

  describe('updateDescription', () => {
    it('updates domain description', () => {
      repo.add('auth', 'Old description');
      const updated = repo.updateDescription('auth', 'New description');

      expect(updated).toBe(true);
      const domain = repo.get('auth');
      expect(domain!.description).toBe('New description');
    });

    it('returns false for non-existent domain', () => {
      const updated = repo.updateDescription('nonexistent', 'Description');
      expect(updated).toBe(false);
    });
  });

  describe('rename', () => {
    it('renames domain in registry and metadata', () => {
      repo.add('authentication');
      metadataRepo.set(defId1, 'domain', '["authentication"]');
      metadataRepo.set(defId2, 'domain', '["authentication", "api"]');

      const result = repo.rename('authentication', 'auth');

      expect(result.updated).toBe(true);
      expect(result.symbolsUpdated).toBe(2);

      expect(repo.get('authentication')).toBeNull();
      expect(repo.get('auth')).not.toBeNull();

      // Check metadata was updated
      const meta1 = metadataRepo.getValue(defId1, 'domain');
      expect(JSON.parse(meta1!)).toEqual(['auth']);
    });
  });

  describe('merge', () => {
    it('merges one domain into another', () => {
      repo.add('authentication');
      repo.add('auth');
      metadataRepo.set(defId1, 'domain', '["authentication"]');
      metadataRepo.set(defId2, 'domain', '["auth"]');

      const result = repo.merge('authentication', 'auth');

      expect(result.symbolsUpdated).toBe(1);
      expect(result.registryRemoved).toBe(true);

      expect(repo.get('authentication')).toBeNull();

      // Check metadata was updated
      const meta1 = metadataRepo.getValue(defId1, 'domain');
      expect(JSON.parse(meta1!)).toEqual(['auth']);
    });

    it('does not duplicate domain in target', () => {
      repo.add('old-auth');
      repo.add('auth');
      metadataRepo.set(defId1, 'domain', '["old-auth", "auth"]');

      repo.merge('old-auth', 'auth');

      const meta1 = metadataRepo.getValue(defId1, 'domain');
      const domains = JSON.parse(meta1!) as string[];
      expect(domains.filter(d => d === 'auth').length).toBe(1);
    });
  });

  describe('remove', () => {
    it('removes domain from registry', () => {
      repo.add('auth');

      const result = repo.remove('auth');

      expect(result.removed).toBe(true);
      expect(result.symbolsUsingDomain).toBe(0);
      expect(repo.get('auth')).toBeNull();
    });

    it('does not remove domain with symbols by default', () => {
      repo.add('auth');
      metadataRepo.set(defId1, 'domain', '["auth"]');

      const result = repo.remove('auth');

      expect(result.removed).toBe(false);
      expect(result.symbolsUsingDomain).toBe(1);
      expect(repo.get('auth')).not.toBeNull();
    });

    it('removes domain with symbols when forced', () => {
      repo.add('auth');
      metadataRepo.set(defId1, 'domain', '["auth"]');

      const result = repo.remove('auth', true);

      expect(result.removed).toBe(true);
      expect(repo.get('auth')).toBeNull();
    });
  });

  describe('syncFromMetadata', () => {
    it('registers domains found in metadata', () => {
      metadataRepo.set(defId1, 'domain', '["auth", "core"]');
      metadataRepo.set(defId2, 'domain', '["api"]');

      const newlyRegistered = repo.syncFromMetadata();

      expect(newlyRegistered).toHaveLength(3);
      expect(newlyRegistered.sort()).toEqual(['api', 'auth', 'core']);
    });

    it('does not duplicate existing domains', () => {
      repo.add('auth');
      metadataRepo.set(defId1, 'domain', '["auth", "core"]');

      const newlyRegistered = repo.syncFromMetadata();

      expect(newlyRegistered).toEqual(['core']);
    });
  });

  describe('getUnregistered', () => {
    it('returns domains in use but not registered', () => {
      repo.add('auth');
      metadataRepo.set(defId1, 'domain', '["auth", "core"]');
      metadataRepo.set(defId2, 'domain', '["api"]');

      const unregistered = repo.getUnregistered();

      expect(unregistered.sort()).toEqual(['api', 'core']);
    });
  });

  describe('isRegistered', () => {
    it('returns true for registered domain', () => {
      repo.add('auth');
      expect(repo.isRegistered('auth')).toBe(true);
    });

    it('returns false for unregistered domain', () => {
      expect(repo.isRegistered('auth')).toBe(false);
    });
  });

  describe('getSymbolsByDomain', () => {
    it('returns symbols with specific domain', () => {
      metadataRepo.set(defId1, 'domain', '["auth"]');
      metadataRepo.set(defId1, 'purpose', 'Auth service');
      metadataRepo.set(defId2, 'domain', '["api"]');

      const symbols = repo.getSymbolsByDomain('auth');

      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe('AuthService');
      expect(symbols[0].purpose).toBe('Auth service');
    });
  });

  describe('getSymbolsByPurity', () => {
    it('returns pure symbols', () => {
      metadataRepo.set(defId1, 'pure', 'true');
      metadataRepo.set(defId2, 'pure', 'false');

      const pureSymbols = repo.getSymbolsByPurity(true);
      expect(pureSymbols).toHaveLength(1);
      expect(pureSymbols[0].name).toBe('AuthService');
    });

    it('returns impure symbols', () => {
      metadataRepo.set(defId1, 'pure', 'true');
      metadataRepo.set(defId2, 'pure', 'false');

      const impureSymbols = repo.getSymbolsByPurity(false);
      expect(impureSymbols).toHaveLength(1);
      expect(impureSymbols[0].name).toBe('UserController');
    });
  });
});
