import type Database from 'better-sqlite3';
import { ensureDomainsTable } from '../schema-manager.js';
import type { Domain, DomainWithCount } from '../schema.js';
import { MetadataRepository } from './metadata-repository.js';

/**
 * Repository for domain registry operations.
 * Handles CRUD operations for the domains table and domain-related queries.
 */
export class DomainRepository {
  private metadata: MetadataRepository;

  constructor(private db: Database.Database) {
    this.metadata = new MetadataRepository(db);
  }

  /**
   * Add a new domain to the registry.
   * @returns The domain ID if created, or null if already exists.
   */
  add(name: string, description?: string): number | null {
    ensureDomainsTable(this.db);
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
  get(name: string): Domain | null {
    ensureDomainsTable(this.db);
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
  getAll(): Domain[] {
    ensureDomainsTable(this.db);
    const stmt = this.db.prepare(`
      SELECT id, name, description, created_at as createdAt
      FROM domains ORDER BY name
    `);
    return stmt.all() as Domain[];
  }

  /**
   * Get all domains with their symbol counts.
   */
  getAllWithCounts(): DomainWithCount[] {
    ensureDomainsTable(this.db);

    // Get all registered domains
    const domains = this.getAll();

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

    return domains.map((domain) => ({
      ...domain,
      symbolCount: domainCounts.get(domain.name) || 0,
    }));
  }

  /**
   * Update a domain's description.
   */
  updateDescription(name: string, description: string): boolean {
    ensureDomainsTable(this.db);
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
  rename(oldName: string, newName: string): { updated: boolean; symbolsUpdated: number } {
    ensureDomainsTable(this.db);

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
  merge(fromName: string, intoName: string): { symbolsUpdated: number; registryRemoved: boolean } {
    ensureDomainsTable(this.db);

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
   * @returns Object with removed status and count of symbols still using the domain.
   */
  remove(name: string, force = false): { removed: boolean; symbolsUsingDomain: number } {
    ensureDomainsTable(this.db);

    // Count symbols using this domain
    const symbolsUsingDomain = this.getSymbolsByDomain(name).length;

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
   * @returns Array of newly registered domain names.
   */
  syncFromMetadata(): string[] {
    ensureDomainsTable(this.db);

    // Get all unique domains from metadata
    const domainsInUse = this.metadata.getAllDomains();

    // Get registered domains
    const registeredDomains = new Set(this.getAll().map((d) => d.name));

    // Register any missing domains
    const newlyRegistered: string[] = [];
    for (const domain of domainsInUse) {
      if (!registeredDomains.has(domain)) {
        const id = this.add(domain);
        if (id !== null) {
          newlyRegistered.push(domain);
        }
      }
    }

    return newlyRegistered;
  }

  /**
   * Get all unregistered domains currently in use.
   */
  getUnregistered(): string[] {
    ensureDomainsTable(this.db);
    const domainsInUse = this.metadata.getAllDomains();
    const registeredDomains = new Set(this.getAll().map((d) => d.name));
    return domainsInUse.filter((d) => !registeredDomains.has(d));
  }

  /**
   * Check if a domain is registered.
   */
  isRegistered(name: string): boolean {
    ensureDomainsTable(this.db);
    const stmt = this.db.prepare(`
      SELECT 1 FROM domains WHERE name = ?
    `);
    return stmt.get(name) !== undefined;
  }

  /**
   * Get symbols that have a specific domain tag.
   * Domain is stored as a JSON array in the 'domain' metadata key.
   */
  getSymbolsByDomain(domain: string): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    domains: string[];
    purpose: string | null;
  }> {
    return this.metadata.getSymbolsByDomain(domain);
  }

  /**
   * Get symbols filtered by purity (pure = no side effects).
   */
  getSymbolsByPurity(isPure: boolean): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    purpose: string | null;
  }> {
    return this.metadata.getSymbolsByPurity(isPure);
  }
}
