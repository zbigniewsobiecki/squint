import type Database from 'better-sqlite3';

export interface AspectCoverage {
  aspect: string;
  covered: number;
  total: number;
  percentage: number;
}

export interface SymbolWithDomain {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  domains: string[];
  purpose: string | null;
}

export interface SymbolWithPurity {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  purpose: string | null;
}

/**
 * Repository for definition metadata operations.
 * Handles CRUD operations for the definition_metadata table.
 */
export class MetadataRepository {
  constructor(private db: Database.Database) {}

  /**
   * Set metadata on a definition (insert or replace)
   */
  set(definitionId: number, key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO definition_metadata (definition_id, key, value)
      VALUES (?, ?, ?)
    `);
    stmt.run(definitionId, key, value);
  }

  /**
   * Remove a metadata key from a definition
   */
  remove(definitionId: number, key: string): boolean {
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
  get(definitionId: number): Record<string, string> {
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
   * Get a single metadata value for a definition
   */
  getValue(definitionId: number, key: string): string | null {
    const stmt = this.db.prepare(`
      SELECT value FROM definition_metadata
      WHERE definition_id = ? AND key = ?
    `);
    const row = stmt.get(definitionId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Get definition IDs that have a specific metadata key set
   */
  getDefinitionsWith(key: string): number[] {
    const stmt = this.db.prepare(`
      SELECT definition_id FROM definition_metadata
      WHERE key = ?
    `);
    const rows = stmt.all(key) as Array<{ definition_id: number }>;
    return rows.map((row) => row.definition_id);
  }

  /**
   * Get definition IDs that do NOT have a specific metadata key set
   */
  getDefinitionsWithout(key: string): number[] {
    const stmt = this.db.prepare(`
      SELECT d.id FROM definitions d
      WHERE NOT EXISTS (
        SELECT 1 FROM definition_metadata dm
        WHERE dm.definition_id = d.id AND dm.key = ?
      )
    `);
    const rows = stmt.all(key) as Array<{ id: number }>;
    return rows.map((row) => row.id);
  }

  /**
   * Get all unique metadata keys (aspects) in use
   */
  getKeys(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT key FROM definition_metadata
      ORDER BY key
    `);
    const rows = stmt.all() as Array<{ key: string }>;
    return rows.map((row) => row.key);
  }

  /**
   * Get count of definitions matching filters
   */
  getFilteredCount(filters?: { kind?: string; filePattern?: string }): number {
    let sql = `
      SELECT COUNT(*) as count FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE 1=1
    `;
    const params: string[] = [];

    if (filters?.kind) {
      sql += ' AND d.kind = ?';
      params.push(filters.kind);
    }
    if (filters?.filePattern) {
      sql += ' AND f.path LIKE ?';
      params.push(`%${filters.filePattern}%`);
    }

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }

  /**
   * Get coverage stats for aspects (metadata keys).
   * Returns the number of definitions that have each aspect defined.
   */
  getAspectCoverage(filters?: { kind?: string; filePattern?: string }): AspectCoverage[] {
    // Build the base query for counting total definitions
    let totalSql = `
      SELECT COUNT(*) as count FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE 1=1
    `;
    const totalParams: string[] = [];

    if (filters?.kind) {
      totalSql += ' AND d.kind = ?';
      totalParams.push(filters.kind);
    }
    if (filters?.filePattern) {
      totalSql += ' AND f.path LIKE ?';
      totalParams.push(`%${filters.filePattern}%`);
    }

    const totalStmt = this.db.prepare(totalSql);
    const totalRow = totalStmt.get(...totalParams) as { count: number };
    const total = totalRow.count;

    if (total === 0) {
      return [];
    }

    // Get all unique metadata keys
    const keys = this.getKeys();

    // For each key, count how many of the filtered definitions have it set
    const results: AspectCoverage[] = [];

    for (const key of keys) {
      let coveredSql = `
        SELECT COUNT(DISTINCT d.id) as count
        FROM definitions d
        JOIN files f ON d.file_id = f.id
        JOIN definition_metadata dm ON dm.definition_id = d.id
        WHERE dm.key = ?
      `;
      const coveredParams: string[] = [key];

      if (filters?.kind) {
        coveredSql += ' AND d.kind = ?';
        coveredParams.push(filters.kind);
      }
      if (filters?.filePattern) {
        coveredSql += ' AND f.path LIKE ?';
        coveredParams.push(`%${filters.filePattern}%`);
      }

      const coveredStmt = this.db.prepare(coveredSql);
      const coveredRow = coveredStmt.get(...coveredParams) as { count: number };
      const covered = coveredRow.count;

      results.push({
        aspect: key,
        covered,
        total,
        percentage: Math.round((covered / total) * 1000) / 10, // One decimal place
      });
    }

    return results;
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
  getSymbolsByDomain(domain: string): SymbolWithDomain[] {
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

    return rows.map((row) => ({
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
   * Get definitions that have no metadata at all (not in definition_metadata table).
   */
  getDefinitionsWithNoMetadata(options?: { kind?: string; limit?: number }): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
  }> {
    const limit = options?.limit ?? 20;
    let sql = `
      SELECT d.id, d.name, d.kind, f.path as filePath, d.line
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.id NOT IN (SELECT DISTINCT definition_id FROM definition_metadata)
    `;
    const params: (string | number)[] = [];

    if (options?.kind) {
      sql += ' AND d.kind = ?';
      params.push(options.kind);
    }

    sql += ' ORDER BY f.path, d.line LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
    }>;
  }

  /**
   * Get count of definitions that have no metadata at all.
   */
  getDefinitionsWithNoMetadataCount(options?: { kind?: string }): number {
    let sql = `
      SELECT COUNT(*) as count
      FROM definitions d
      WHERE d.id NOT IN (SELECT DISTINCT definition_id FROM definition_metadata)
    `;
    const params: string[] = [];

    if (options?.kind) {
      sql += ' AND d.kind = ?';
      params.push(options.kind);
    }

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }

  /**
   * Get symbols filtered by purity (pure = no side effects).
   * Returns symbols where 'pure' metadata matches the specified value.
   */
  getSymbolsByPurity(isPure: boolean): SymbolWithPurity[] {
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
    return stmt.all(pureValue) as SymbolWithPurity[];
  }
}
