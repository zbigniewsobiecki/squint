import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('Domain Registry', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  describe('addDomain', () => {
    it('adds a new domain and returns its ID', () => {
      const id = db.domains.add('auth', 'User authentication');
      expect(id).toBe(1);
    });

    it('returns null if domain already exists', () => {
      db.domains.add('auth', 'User authentication');
      const id = db.domains.add('auth', 'Different description');
      expect(id).toBeNull();
    });

    it('allows adding domain without description', () => {
      const id = db.domains.add('payment');
      expect(id).toBe(1);
    });
  });

  describe('getDomain', () => {
    it('returns domain by name', () => {
      db.domains.add('auth', 'User authentication');
      const domain = db.domains.get('auth');
      expect(domain).toBeDefined();
      expect(domain!.name).toBe('auth');
      expect(domain!.description).toBe('User authentication');
    });

    it('returns null for non-existent domain', () => {
      const domain = db.domains.get('nonexistent');
      expect(domain).toBeNull();
    });
  });

  describe('getDomainsFromRegistry', () => {
    it('returns all registered domains', () => {
      db.domains.add('auth', 'Authentication');
      db.domains.add('payment', 'Payment processing');
      db.domains.add('customer', 'Customer management');

      const domains = db.domains.getAll();
      expect(domains).toHaveLength(3);
      expect(domains.map((d) => d.name)).toEqual(['auth', 'customer', 'payment']);
    });

    it('returns empty array when no domains registered', () => {
      const domains = db.domains.getAll();
      expect(domains).toEqual([]);
    });
  });

  describe('getDomainsWithCounts', () => {
    it('returns domains with symbol counts', () => {
      // Add domains
      db.domains.add('auth', 'Authentication');
      db.domains.add('payment', 'Payment processing');

      // Create symbols with domain metadata
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'processPayment',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.metadata.set(def1, 'domain', '["auth"]');
      db.metadata.set(def2, 'domain', '["payment", "auth"]');

      const domainsWithCounts = db.domains.getAllWithCounts();
      expect(domainsWithCounts).toHaveLength(2);

      const authDomain = domainsWithCounts.find((d) => d.name === 'auth');
      expect(authDomain?.symbolCount).toBe(2);

      const paymentDomain = domainsWithCounts.find((d) => d.name === 'payment');
      expect(paymentDomain?.symbolCount).toBe(1);
    });

    it('returns 0 count for domains with no symbols', () => {
      db.domains.add('unused', 'Unused domain');
      const domainsWithCounts = db.domains.getAllWithCounts();
      expect(domainsWithCounts[0].symbolCount).toBe(0);
    });
  });

  describe('updateDomainDescription', () => {
    it('updates domain description', () => {
      db.domains.add('auth', 'Old description');
      const updated = db.domains.updateDescription('auth', 'New description');
      expect(updated).toBe(true);

      const domain = db.domains.get('auth');
      expect(domain?.description).toBe('New description');
    });

    it('returns false for non-existent domain', () => {
      const updated = db.domains.updateDescription('nonexistent', 'Description');
      expect(updated).toBe(false);
    });
  });

  describe('renameDomain', () => {
    it('renames domain in registry', () => {
      db.domains.add('auth', 'Authentication');
      const result = db.domains.rename('auth', 'authentication');
      expect(result.updated).toBe(true);

      expect(db.domains.get('auth')).toBeNull();
      expect(db.domains.get('authentication')).toBeDefined();
    });

    it('updates domain in symbol metadata', () => {
      db.domains.add('auth', 'Authentication');

      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'domain', '["auth", "user"]');

      const result = db.domains.rename('auth', 'authentication');
      expect(result.symbolsUpdated).toBe(1);

      const metadata = db.metadata.get(defId);
      expect(metadata.domain).toBe('["authentication","user"]');
    });
  });

  describe('mergeDomains', () => {
    it('merges source domain into target', () => {
      db.domains.add('user-mgmt', 'User management');
      db.domains.add('customer', 'Customer');

      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'getUser',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'domain', '["user-mgmt"]');

      const result = db.domains.merge('user-mgmt', 'customer');
      expect(result.symbolsUpdated).toBe(1);
      expect(result.registryRemoved).toBe(true);

      const metadata = db.metadata.get(defId);
      expect(metadata.domain).toBe('["customer"]');

      expect(db.domains.get('user-mgmt')).toBeNull();
    });

    it('does not duplicate target domain if already present', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'getUser',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'domain', '["user-mgmt", "customer"]');

      db.domains.merge('user-mgmt', 'customer');

      const metadata = db.metadata.get(defId);
      expect(metadata.domain).toBe('["customer"]');
    });
  });

  describe('removeDomain', () => {
    it('removes domain from registry', () => {
      db.domains.add('deprecated', 'Old domain');
      const result = db.domains.remove('deprecated');
      expect(result.removed).toBe(true);
      expect(db.domains.get('deprecated')).toBeNull();
    });

    it('prevents removal if symbols still use domain', () => {
      db.domains.add('auth', 'Authentication');

      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'domain', '["auth"]');

      const result = db.domains.remove('auth');
      expect(result.removed).toBe(false);
      expect(result.symbolsUsingDomain).toBe(1);
    });

    it('removes domain with force flag even if symbols use it', () => {
      db.domains.add('auth', 'Authentication');

      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'domain', '["auth"]');

      const result = db.domains.remove('auth', true);
      expect(result.removed).toBe(true);
      expect(result.symbolsUsingDomain).toBe(1);
    });
  });

  describe('syncDomainsFromMetadata', () => {
    it('registers all domains from symbol metadata', () => {
      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.files.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.files.insertDefinition(fileId, {
        name: 'pay',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.metadata.set(def1, 'domain', '["auth", "user"]');
      db.metadata.set(def2, 'domain', '["payment"]');

      const registered = db.domains.syncFromMetadata();
      expect(registered.sort()).toEqual(['auth', 'payment', 'user']);

      expect(db.domains.getAll()).toHaveLength(3);
    });

    it('does not duplicate already registered domains', () => {
      db.domains.add('auth', 'Already registered');

      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'domain', '["auth", "payment"]');

      const registered = db.domains.syncFromMetadata();
      expect(registered).toEqual(['payment']);

      expect(db.domains.getAll()).toHaveLength(2);
    });
  });

  describe('getUnregisteredDomains', () => {
    it('returns domains in use but not registered', () => {
      db.domains.add('auth', 'Registered');

      const fileId = db.files.insert({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.files.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.metadata.set(defId, 'domain', '["auth", "payment", "user"]');

      const unregistered = db.domains.getUnregistered();
      expect(unregistered.sort()).toEqual(['payment', 'user']);
    });
  });

  describe('isDomainRegistered', () => {
    it('returns true for registered domain', () => {
      db.domains.add('auth', 'Auth');
      expect(db.domains.isRegistered('auth')).toBe(true);
    });

    it('returns false for unregistered domain', () => {
      expect(db.domains.isRegistered('nonexistent')).toBe(false);
    });
  });
});
