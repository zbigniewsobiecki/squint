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
      const id = db.addDomain('auth', 'User authentication');
      expect(id).toBe(1);
    });

    it('returns null if domain already exists', () => {
      db.addDomain('auth', 'User authentication');
      const id = db.addDomain('auth', 'Different description');
      expect(id).toBeNull();
    });

    it('allows adding domain without description', () => {
      const id = db.addDomain('payment');
      expect(id).toBe(1);
    });
  });

  describe('getDomain', () => {
    it('returns domain by name', () => {
      db.addDomain('auth', 'User authentication');
      const domain = db.getDomain('auth');
      expect(domain).toBeDefined();
      expect(domain!.name).toBe('auth');
      expect(domain!.description).toBe('User authentication');
    });

    it('returns null for non-existent domain', () => {
      const domain = db.getDomain('nonexistent');
      expect(domain).toBeNull();
    });
  });

  describe('getDomainsFromRegistry', () => {
    it('returns all registered domains', () => {
      db.addDomain('auth', 'Authentication');
      db.addDomain('payment', 'Payment processing');
      db.addDomain('customer', 'Customer management');

      const domains = db.getDomainsFromRegistry();
      expect(domains).toHaveLength(3);
      expect(domains.map((d) => d.name)).toEqual(['auth', 'customer', 'payment']);
    });

    it('returns empty array when no domains registered', () => {
      const domains = db.getDomainsFromRegistry();
      expect(domains).toEqual([]);
    });
  });

  describe('getDomainsWithCounts', () => {
    it('returns domains with symbol counts', () => {
      // Add domains
      db.addDomain('auth', 'Authentication');
      db.addDomain('payment', 'Payment processing');

      // Create symbols with domain metadata
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.insertDefinition(fileId, {
        name: 'processPayment',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.setDefinitionMetadata(def1, 'domain', '["auth"]');
      db.setDefinitionMetadata(def2, 'domain', '["payment", "auth"]');

      const domainsWithCounts = db.getDomainsWithCounts();
      expect(domainsWithCounts).toHaveLength(2);

      const authDomain = domainsWithCounts.find((d) => d.name === 'auth');
      expect(authDomain?.symbolCount).toBe(2);

      const paymentDomain = domainsWithCounts.find((d) => d.name === 'payment');
      expect(paymentDomain?.symbolCount).toBe(1);
    });

    it('returns 0 count for domains with no symbols', () => {
      db.addDomain('unused', 'Unused domain');
      const domainsWithCounts = db.getDomainsWithCounts();
      expect(domainsWithCounts[0].symbolCount).toBe(0);
    });
  });

  describe('updateDomainDescription', () => {
    it('updates domain description', () => {
      db.addDomain('auth', 'Old description');
      const updated = db.updateDomainDescription('auth', 'New description');
      expect(updated).toBe(true);

      const domain = db.getDomain('auth');
      expect(domain?.description).toBe('New description');
    });

    it('returns false for non-existent domain', () => {
      const updated = db.updateDomainDescription('nonexistent', 'Description');
      expect(updated).toBe(false);
    });
  });

  describe('renameDomain', () => {
    it('renames domain in registry', () => {
      db.addDomain('auth', 'Authentication');
      const result = db.renameDomain('auth', 'authentication');
      expect(result.updated).toBe(true);

      expect(db.getDomain('auth')).toBeNull();
      expect(db.getDomain('authentication')).toBeDefined();
    });

    it('updates domain in symbol metadata', () => {
      db.addDomain('auth', 'Authentication');

      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.setDefinitionMetadata(defId, 'domain', '["auth", "user"]');

      const result = db.renameDomain('auth', 'authentication');
      expect(result.symbolsUpdated).toBe(1);

      const metadata = db.getDefinitionMetadata(defId);
      expect(metadata.domain).toBe('["authentication","user"]');
    });
  });

  describe('mergeDomains', () => {
    it('merges source domain into target', () => {
      db.addDomain('user-mgmt', 'User management');
      db.addDomain('customer', 'Customer');

      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.insertDefinition(fileId, {
        name: 'getUser',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.setDefinitionMetadata(defId, 'domain', '["user-mgmt"]');

      const result = db.mergeDomains('user-mgmt', 'customer');
      expect(result.symbolsUpdated).toBe(1);
      expect(result.registryRemoved).toBe(true);

      const metadata = db.getDefinitionMetadata(defId);
      expect(metadata.domain).toBe('["customer"]');

      expect(db.getDomain('user-mgmt')).toBeNull();
    });

    it('does not duplicate target domain if already present', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.insertDefinition(fileId, {
        name: 'getUser',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.setDefinitionMetadata(defId, 'domain', '["user-mgmt", "customer"]');

      db.mergeDomains('user-mgmt', 'customer');

      const metadata = db.getDefinitionMetadata(defId);
      expect(metadata.domain).toBe('["customer"]');
    });
  });

  describe('removeDomain', () => {
    it('removes domain from registry', () => {
      db.addDomain('deprecated', 'Old domain');
      const result = db.removeDomain('deprecated');
      expect(result.removed).toBe(true);
      expect(db.getDomain('deprecated')).toBeNull();
    });

    it('prevents removal if symbols still use domain', () => {
      db.addDomain('auth', 'Authentication');

      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.setDefinitionMetadata(defId, 'domain', '["auth"]');

      const result = db.removeDomain('auth');
      expect(result.removed).toBe(false);
      expect(result.symbolsUsingDomain).toBe(1);
    });

    it('removes domain with force flag even if symbols use it', () => {
      db.addDomain('auth', 'Authentication');

      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.setDefinitionMetadata(defId, 'domain', '["auth"]');

      const result = db.removeDomain('auth', true);
      expect(result.removed).toBe(true);
      expect(result.symbolsUsingDomain).toBe(1);
    });
  });

  describe('syncDomainsFromMetadata', () => {
    it('registers all domains from symbol metadata', () => {
      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const def1 = db.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      const def2 = db.insertDefinition(fileId, {
        name: 'pay',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 3, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      db.setDefinitionMetadata(def1, 'domain', '["auth", "user"]');
      db.setDefinitionMetadata(def2, 'domain', '["payment"]');

      const registered = db.syncDomainsFromMetadata();
      expect(registered.sort()).toEqual(['auth', 'payment', 'user']);

      expect(db.getDomainsFromRegistry()).toHaveLength(3);
    });

    it('does not duplicate already registered domains', () => {
      db.addDomain('auth', 'Already registered');

      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.setDefinitionMetadata(defId, 'domain', '["auth", "payment"]');

      const registered = db.syncDomainsFromMetadata();
      expect(registered).toEqual(['payment']);

      expect(db.getDomainsFromRegistry()).toHaveLength(2);
    });
  });

  describe('getUnregisteredDomains', () => {
    it('returns domains in use but not registered', () => {
      db.addDomain('auth', 'Registered');

      const fileId = db.insertFile({
        path: '/project/utils.ts',
        language: 'typescript',
        contentHash: computeHash('content'),
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      const defId = db.insertDefinition(fileId, {
        name: 'login',
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 2, column: 1 },
      });

      db.setDefinitionMetadata(defId, 'domain', '["auth", "payment", "user"]');

      const unregistered = db.getUnregisteredDomains();
      expect(unregistered.sort()).toEqual(['payment', 'user']);
    });
  });

  describe('isDomainRegistered', () => {
    it('returns true for registered domain', () => {
      db.addDomain('auth', 'Auth');
      expect(db.isDomainRegistered('auth')).toBe(true);
    });

    it('returns false for unregistered domain', () => {
      expect(db.isDomainRegistered('nonexistent')).toBe(false);
    });
  });
});
