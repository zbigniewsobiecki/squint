import type Database from 'better-sqlite3';

/**
 * Repository for definition metadata operations.
 * Handles CRUD operations for the definition_metadata table.
 */
export class MetadataRepository {
  constructor(private db: Database.Database) {}

  /**
   * Set metadata on a definition (insert or replace)
   */
  setDefinitionMetadata(definitionId: number, key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO definition_metadata (definition_id, key, value)
      VALUES (?, ?, ?)
    `);
    stmt.run(definitionId, key, value);
  }

  /**
   * Remove a metadata key from a definition
   */
  removeDefinitionMetadata(definitionId: number, key: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM definition_metadata
      WHERE definition_id = ? AND key = ?
    `);
    const result = stmt.run(definitionId, key);
    return result.changes > 0;
  }

  /**
   * Get all metadata for a definition
   */
  getDefinitionMetadata(definitionId: number): Record<string, string> {
    const stmt = this.db.prepare(`
      SELECT key, value FROM definition_metadata
      WHERE definition_id = ?
    `);
    const rows = stmt.all(definitionId) as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Get definition IDs that have a specific metadata key set
   */
  getDefinitionsWithMetadata(key: string): number[] {
    const stmt = this.db.prepare(`
      SELECT definition_id FROM definition_metadata
      WHERE key = ?
    `);
    const rows = stmt.all(key) as Array<{ definition_id: number }>;
    return rows.map(row => row.definition_id);
  }

  /**
   * Get definition IDs that do NOT have a specific metadata key set
   */
  getDefinitionsWithoutMetadata(key: string): number[] {
    const stmt = this.db.prepare(`
      SELECT d.id FROM definitions d
      WHERE NOT EXISTS (
        SELECT 1 FROM definition_metadata dm
        WHERE dm.definition_id = d.id AND dm.key = ?
      )
    `);
    const rows = stmt.all(key) as Array<{ id: number }>;
    return rows.map(row => row.id);
  }

  /**
   * Get all unique metadata keys (aspects) in use
   */
  getMetadataKeys(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT key FROM definition_metadata
      ORDER BY key
    `);
    const rows = stmt.all() as Array<{ key: string }>;
    return rows.map(row => row.key);
  }

  /**
   * Get all unique domains used across all symbols.
   * Domain is stored as a JSON array in the 'domain' metadata key.
   */
  getAllDomains(): string[] {
    const stmt = this.db.prepare(`
      SELECT value FROM definition_metadata WHERE key = 'domain'
    `);
    const rows = stmt.all() as Array<{ value: string }>;

    const domains = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as string[];
        for (const d of parsed) {
          domains.add(d);
        }
      } catch {
        // Skip invalid JSON
      }
    }
    return Array.from(domains).sort();
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
    // Use LIKE with JSON pattern to find domain in the array
    const pattern = `%"${domain}"%`;
    const stmt = this.db.prepare(`
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        dm_domain.value as domains,
        dm_purpose.value as purpose
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      JOIN definition_metadata dm_domain ON dm_domain.definition_id = d.id AND dm_domain.key = 'domain'
      LEFT JOIN definition_metadata dm_purpose ON dm_purpose.definition_id = d.id AND dm_purpose.key = 'purpose'
      WHERE dm_domain.value LIKE ?
      ORDER BY f.path, d.line
    `);
    const rows = stmt.all(pattern) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      domains: string;
      purpose: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.filePath,
      line: row.line,
      domains: JSON.parse(row.domains) as string[],
      purpose: row.purpose,
    }));
  }

  /**
   * Get symbols filtered by purity (pure = no side effects).
   * Returns symbols where 'pure' metadata matches the specified value.
   */
  getSymbolsByPurity(isPure: boolean): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    purpose: string | null;
  }> {
    const pureValue = isPure ? 'true' : 'false';
    const stmt = this.db.prepare(`
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        dm_purpose.value as purpose
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      JOIN definition_metadata dm_pure ON dm_pure.definition_id = d.id AND dm_pure.key = 'pure'
      LEFT JOIN definition_metadata dm_purpose ON dm_purpose.definition_id = d.id AND dm_purpose.key = 'purpose'
      WHERE dm_pure.value = ?
      ORDER BY f.path, d.line
    `);
    return stmt.all(pureValue) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      purpose: string | null;
    }>;
  }
}
