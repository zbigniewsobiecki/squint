import type Database from 'better-sqlite3';
import type { Domain, DomainWithCount } from '../schema.js';

/**
 * Repository for domain registry operations.
 * Handles CRUD operations for the domains table and domain-related queries.
 */
export class DomainRepository {
  constructor(private db: Database.Database) {}

  /**
   * Ensure the domains table exists (for existing databases).
   * Called automatically by domain methods to support legacy databases.
   */
  ensureDomainsTable(): void {
    const tableExists = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='domains'
    `).get();

    if (!tableExists) {
      this.db.exec(`
        CREATE TABLE domains (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_domains_name ON domains(name);
      `);
    }
  }

  /**
   * Add a new domain to the registry.
   * @returns The domain ID if created, or null if already exists.
   */
  addDomain(name: string, description?: string): number | null {
    this.ensureDomainsTable();
    try {
      const stmt = this.db.prepare(`
        INSERT INTO domains (name, description) VALUES (?, ?)
      `);
      const result = stmt.run(name, description ?? null);
      return result.lastInsertRowid as number;
    } catch (error) {
      // Domain already exists (UNIQUE constraint)
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get a domain by name.
   */
  getDomain(name: string): Domain | null {
    this.ensureDomainsTable();
    const stmt = this.db.prepare(`
      SELECT id, name, description, created_at as createdAt
      FROM domains WHERE name = ?
    `);
    const row = stmt.get(name) as Domain | undefined;
    return row ?? null;
  }

  /**
   * Get all domains from the registry.
   */
  getDomainsFromRegistry(): Domain[] {
    this.ensureDomainsTable();
    const stmt = this.db.prepare(`
      SELECT id, name, description, created_at as createdAt
      FROM domains ORDER BY name
    `);
    return stmt.all() as Domain[];
  }

  /**
   * Get all domains with their symbol counts.
   */
  getDomainsWithCounts(): DomainWithCount[] {
    this.ensureDomainsTable();

    // Get all registered domains
    const domains = this.getDomainsFromRegistry();

    // Get all domain values from metadata
    const metadataStmt = this.db.prepare(`
      SELECT value FROM definition_metadata WHERE key = 'domain'
    `);
    const rows = metadataStmt.all() as Array<{ value: string }>;

    // Count symbols per domain
    const domainCounts = new Map<string, number>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as string[];
        for (const d of parsed) {
          domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
        }
      } catch {
        // Skip invalid JSON
      }
    }

    return domains.map(domain => ({
      ...domain,
      symbolCount: domainCounts.get(domain.name) || 0,
    }));
  }

  /**
   * Update a domain's description.
   */
  updateDomainDescription(name: string, description: string): boolean {
    this.ensureDomainsTable();
    const stmt = this.db.prepare(`
      UPDATE domains SET description = ? WHERE name = ?
    `);
    const result = stmt.run(description, name);
    return result.changes > 0;
  }

  /**
   * Rename a domain in both the registry and all symbol metadata.
   * @returns Number of symbols updated.
   */
  renameDomain(oldName: string, newName: string): { updated: boolean; symbolsUpdated: number } {
    this.ensureDomainsTable();

    // Update registry
    const updateRegistry = this.db.prepare(`
      UPDATE domains SET name = ? WHERE name = ?
    `);
    const registryResult = updateRegistry.run(newName, oldName);

    // Update all symbol metadata
    const getMetadata = this.db.prepare(`
      SELECT id, definition_id, value FROM definition_metadata WHERE key = 'domain'
    `);
    const rows = getMetadata.all() as Array<{ id: number; definition_id: number; value: string }>;

    let symbolsUpdated = 0;
    const updateMetadata = this.db.prepare(`
      UPDATE definition_metadata SET value = ? WHERE id = ?
    `);

    for (const row of rows) {
      try {
        const domains = JSON.parse(row.value) as string[];
        const idx = domains.indexOf(oldName);
        if (idx !== -1) {
          domains[idx] = newName;
          updateMetadata.run(JSON.stringify(domains), row.id);
          symbolsUpdated++;
        }
      } catch {
        // Skip invalid JSON
      }
    }

    return {
      updated: registryResult.changes > 0,
      symbolsUpdated,
    };
  }

  /**
   * Merge one domain into another. The source domain is removed from all symbols
   * and replaced with the target domain.
   * @returns Number of symbols updated.
   */
  mergeDomains(fromName: string, intoName: string): { symbolsUpdated: number; registryRemoved: boolean } {
    this.ensureDomainsTable();

    // Update all symbol metadata
    const getMetadata = this.db.prepare(`
      SELECT id, definition_id, value FROM definition_metadata WHERE key = 'domain'
    `);
    const rows = getMetadata.all() as Array<{ id: number; definition_id: number; value: string }>;

    let symbolsUpdated = 0;
    const updateMetadata = this.db.prepare(`
      UPDATE definition_metadata SET value = ? WHERE id = ?
    `);

    for (const row of rows) {
      try {
        const domains = JSON.parse(row.value) as string[];
        const fromIdx = domains.indexOf(fromName);
        if (fromIdx !== -1) {
          // Remove the old domain
          domains.splice(fromIdx, 1);
          // Add the new domain if not already present
          if (!domains.includes(intoName)) {
            domains.push(intoName);
          }
          updateMetadata.run(JSON.stringify(domains.sort()), row.id);
          symbolsUpdated++;
        }
      } catch {
        // Skip invalid JSON
      }
    }

    // Remove the source domain from registry
    const removeRegistry = this.db.prepare(`
      DELETE FROM domains WHERE name = ?
    `);
    const registryResult = removeRegistry.run(fromName);

    return {
      symbolsUpdated,
      registryRemoved: registryResult.changes > 0,
    };
  }

  /**
   * Remove a domain from the registry.
   * @param force If true, removes even if symbols still use this domain.
   * @param getSymbolsByDomain Function to count symbols using this domain.
   * @returns Object with removed status and count of symbols still using the domain.
   */
  removeDomain(
    name: string,
    force: boolean,
    getSymbolsByDomain: (domain: string) => { length: number }
  ): { removed: boolean; symbolsUsingDomain: number } {
    this.ensureDomainsTable();

    // Count symbols using this domain
    const symbolsUsingDomain = getSymbolsByDomain(name).length;

    if (symbolsUsingDomain > 0 && !force) {
      return { removed: false, symbolsUsingDomain };
    }

    // Remove from registry
    const stmt = this.db.prepare(`
      DELETE FROM domains WHERE name = ?
    `);
    const result = stmt.run(name);

    return {
      removed: result.changes > 0,
      symbolsUsingDomain,
    };
  }

  /**
   * Sync all domains currently in use to the registry.
   * Registers any domain found in symbol metadata that isn't already registered.
   * @param getAllDomains Function to get all domains from metadata.
   * @returns Array of newly registered domain names.
   */
  syncDomainsFromMetadata(getAllDomains: () => string[]): string[] {
    this.ensureDomainsTable();

    // Get all unique domains from metadata
    const domainsInUse = getAllDomains();

    // Get registered domains
    const registeredDomains = new Set(this.getDomainsFromRegistry().map(d => d.name));

    // Register any missing domains
    const newlyRegistered: string[] = [];
    for (const domain of domainsInUse) {
      if (!registeredDomains.has(domain)) {
        const id = this.addDomain(domain);
        if (id !== null) {
          newlyRegistered.push(domain);
        }
      }
    }

    return newlyRegistered;
  }

  /**
   * Get all unregistered domains currently in use.
   * @param getAllDomains Function to get all domains from metadata.
   */
  getUnregisteredDomains(getAllDomains: () => string[]): string[] {
    this.ensureDomainsTable();
    const domainsInUse = getAllDomains();
    const registeredDomains = new Set(this.getDomainsFromRegistry().map(d => d.name));
    return domainsInUse.filter(d => !registeredDomains.has(d));
  }

  /**
   * Check if a domain is registered.
   */
  isDomainRegistered(name: string): boolean {
    this.ensureDomainsTable();
    const stmt = this.db.prepare(`
      SELECT 1 FROM domains WHERE name = ?
    `);
    return stmt.get(name) !== undefined;
  }
}
