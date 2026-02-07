import type Database from 'better-sqlite3';
import type { RelationshipAnnotation, RelationshipWithDetails, EnhancedRelationshipContext } from '../schema.js';

/**
 * Repository for relationship annotation operations.
 * Handles CRUD operations for the relationship_annotations table.
 */
export class RelationshipRepository {
  constructor(private db: Database.Database) {}

  /**
   * Set (insert or update) a semantic annotation for a relationship between two definitions.
   */
  setRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number, semantic: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO relationship_annotations (from_definition_id, to_definition_id, semantic, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    stmt.run(fromDefinitionId, toDefinitionId, semantic);
  }

  /**
   * Get a relationship annotation between two definitions.
   */
  getRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number): RelationshipAnnotation | null {
    const stmt = this.db.prepare(`
      SELECT id, from_definition_id as fromDefinitionId, to_definition_id as toDefinitionId,
             semantic, created_at as createdAt
      FROM relationship_annotations
      WHERE from_definition_id = ? AND to_definition_id = ?
    `);
    const row = stmt.get(fromDefinitionId, toDefinitionId) as RelationshipAnnotation | undefined;
    return row ?? null;
  }

  /**
   * Remove a relationship annotation.
   */
  removeRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM relationship_annotations
      WHERE from_definition_id = ? AND to_definition_id = ?
    `);
    const result = stmt.run(fromDefinitionId, toDefinitionId);
    return result.changes > 0;
  }

  /**
   * Get all relationship annotations from a specific definition.
   */
  getRelationshipsFrom(fromDefinitionId: number): RelationshipWithDetails[] {
    const stmt = this.db.prepare(`
      SELECT
        ra.id,
        ra.from_definition_id as fromDefinitionId,
        fd.name as fromName,
        fd.kind as fromKind,
        ff.path as fromFilePath,
        fd.line as fromLine,
        ra.to_definition_id as toDefinitionId,
        td.name as toName,
        td.kind as toKind,
        tf.path as toFilePath,
        td.line as toLine,
        ra.semantic
      FROM relationship_annotations ra
      JOIN definitions fd ON ra.from_definition_id = fd.id
      JOIN files ff ON fd.file_id = ff.id
      JOIN definitions td ON ra.to_definition_id = td.id
      JOIN files tf ON td.file_id = tf.id
      WHERE ra.from_definition_id = ?
      ORDER BY td.name
    `);
    return stmt.all(fromDefinitionId) as RelationshipWithDetails[];
  }

  /**
   * Get all relationship annotations to a specific definition.
   */
  getRelationshipsTo(toDefinitionId: number): RelationshipWithDetails[] {
    const stmt = this.db.prepare(`
      SELECT
        ra.id,
        ra.from_definition_id as fromDefinitionId,
        fd.name as fromName,
        fd.kind as fromKind,
        ff.path as fromFilePath,
        fd.line as fromLine,
        ra.to_definition_id as toDefinitionId,
        td.name as toName,
        td.kind as toKind,
        tf.path as toFilePath,
        td.line as toLine,
        ra.semantic
      FROM relationship_annotations ra
      JOIN definitions fd ON ra.from_definition_id = fd.id
      JOIN files ff ON fd.file_id = ff.id
      JOIN definitions td ON ra.to_definition_id = td.id
      JOIN files tf ON td.file_id = tf.id
      WHERE ra.to_definition_id = ?
      ORDER BY fd.name
    `);
    return stmt.all(toDefinitionId) as RelationshipWithDetails[];
  }

  /**
   * Get all relationship annotations.
   */
  getAllRelationshipAnnotations(options?: { limit?: number }): RelationshipWithDetails[] {
    const limit = options?.limit ?? 100;
    const stmt = this.db.prepare(`
      SELECT
        ra.id,
        ra.from_definition_id as fromDefinitionId,
        fd.name as fromName,
        fd.kind as fromKind,
        ff.path as fromFilePath,
        fd.line as fromLine,
        ra.to_definition_id as toDefinitionId,
        td.name as toName,
        td.kind as toKind,
        tf.path as toFilePath,
        td.line as toLine,
        ra.semantic
      FROM relationship_annotations ra
      JOIN definitions fd ON ra.from_definition_id = fd.id
      JOIN files ff ON fd.file_id = ff.id
      JOIN definitions td ON ra.to_definition_id = td.id
      JOIN files tf ON td.file_id = tf.id
      ORDER BY ff.path, fd.line
      LIMIT ?
    `);
    return stmt.all(limit) as RelationshipWithDetails[];
  }

  /**
   * Get count of relationship annotations.
   */
  getRelationshipAnnotationCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM relationship_annotations');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get definitions that have calls to other definitions but no annotation.
   * Finds "call" edges without semantic annotations.
   */
  getUnannotatedRelationships(options?: { limit?: number; fromDefinitionId?: number }): Array<{
    fromDefinitionId: number;
    fromName: string;
    fromKind: string;
    fromFilePath: string;
    fromLine: number;
    toDefinitionId: number;
    toName: string;
    toKind: string;
    toFilePath: string;
    toLine: number;
  }> {
    const limit = options?.limit ?? 20;

    let whereClause = '';
    const params: (string | number)[] = [];

    if (options?.fromDefinitionId !== undefined) {
      whereClause = 'WHERE source.id = ?';
      params.push(options.fromDefinitionId);
    }

    const sql = `
      SELECT DISTINCT
        source.id as fromDefinitionId,
        source.name as fromName,
        source.kind as fromKind,
        sf.path as fromFilePath,
        source.line as fromLine,
        dep_def.id as toDefinitionId,
        dep_def.name as toName,
        dep_def.kind as toKind,
        df.path as toFilePath,
        dep_def.line as toLine
      FROM definitions source
      JOIN files sf ON source.file_id = sf.id
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files df ON dep_def.file_id = df.id
      LEFT JOIN relationship_annotations ra
        ON ra.from_definition_id = source.id AND ra.to_definition_id = dep_def.id
      ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} dep_def.id != source.id
        AND ra.id IS NULL
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
      ORDER BY sf.path, source.line
      LIMIT ?
    `;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Array<{
      fromDefinitionId: number;
      fromName: string;
      fromKind: string;
      fromFilePath: string;
      fromLine: number;
      toDefinitionId: number;
      toName: string;
      toKind: string;
      toFilePath: string;
      toLine: number;
    }>;
  }

  /**
   * Get count of unannotated relationships.
   */
  getUnannotatedRelationshipCount(fromDefinitionId?: number): number {
    let whereClause = '';
    const params: number[] = [];

    if (fromDefinitionId !== undefined) {
      whereClause = 'WHERE source.id = ?';
      params.push(fromDefinitionId);
    }

    const sql = `
      SELECT COUNT(DISTINCT source.id || '-' || dep_def.id) as count
      FROM definitions source
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      LEFT JOIN relationship_annotations ra
        ON ra.from_definition_id = source.id AND ra.to_definition_id = dep_def.id
      ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} dep_def.id != source.id
        AND ra.id IS NULL
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
    `;

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }

  /**
   * Get the next relationship(s) that need annotation with rich context.
   * Returns relationships ordered by: symbols with most dependencies first,
   * then by file path and line number.
   */
  getNextRelationshipToAnnotate(
    options: { limit?: number; fromDefinitionId?: number } | undefined,
    getDefinitionMetadata: (id: number) => Record<string, string>,
    getRelationshipsFrom: (id: number) => RelationshipWithDetails[],
    getRelationshipsTo: (id: number) => RelationshipWithDetails[]
  ): EnhancedRelationshipContext[] {
    const limit = options?.limit ?? 1;

    let whereClause = '';
    const params: (string | number)[] = [];

    if (options?.fromDefinitionId !== undefined) {
      whereClause = 'WHERE source.id = ?';
      params.push(options.fromDefinitionId);
    }

    // Get unannotated relationships with basic info
    const sql = `
      SELECT DISTINCT
        source.id as fromDefinitionId,
        source.name as fromName,
        source.kind as fromKind,
        sf.path as fromFilePath,
        source.line as fromLine,
        source.end_line as fromEndLine,
        dep_def.id as toDefinitionId,
        dep_def.name as toName,
        dep_def.kind as toKind,
        df.path as toFilePath,
        dep_def.line as toLine,
        dep_def.end_line as toEndLine,
        u.line as usageLine
      FROM definitions source
      JOIN files sf ON source.file_id = sf.id
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files df ON dep_def.file_id = df.id
      LEFT JOIN relationship_annotations ra
        ON ra.from_definition_id = source.id AND ra.to_definition_id = dep_def.id
      ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} dep_def.id != source.id
        AND ra.id IS NULL
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
      ORDER BY sf.path, source.line
      LIMIT ?
    `;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      fromDefinitionId: number;
      fromName: string;
      fromKind: string;
      fromFilePath: string;
      fromLine: number;
      fromEndLine: number;
      toDefinitionId: number;
      toName: string;
      toKind: string;
      toFilePath: string;
      toLine: number;
      toEndLine: number;
      usageLine: number;
    }>;

    // Enhance with metadata and other relationships
    return rows.map(row => {
      const fromMetadata = getDefinitionMetadata(row.fromDefinitionId);
      const toMetadata = getDefinitionMetadata(row.toDefinitionId);

      // Get other relationships for context
      const fromRelationships = getRelationshipsFrom(row.fromDefinitionId);
      const toRelationships = getRelationshipsTo(row.toDefinitionId);

      // Parse domains for shared domain calculation
      let fromDomains: string[] | null = null;
      let toDomains: string[] | null = null;

      try {
        if (fromMetadata['domain']) {
          fromDomains = JSON.parse(fromMetadata['domain']) as string[];
        }
      } catch { /* ignore */ }

      try {
        if (toMetadata['domain']) {
          toDomains = JSON.parse(toMetadata['domain']) as string[];
        }
      } catch { /* ignore */ }

      // Calculate shared domains
      const sharedDomains: string[] = [];
      if (fromDomains && toDomains) {
        for (const d of fromDomains) {
          if (toDomains.includes(d)) {
            sharedDomains.push(d);
          }
        }
      }

      // Determine relationship type
      let relationshipType: 'call' | 'import' | 'extends' | 'implements' = 'call';
      // For now, we'll assume 'call' as the default since we're finding usage-based relationships

      return {
        ...row,
        fromPurpose: fromMetadata['purpose'] || null,
        fromDomains,
        fromRole: fromMetadata['role'] || null,
        fromPure: fromMetadata['pure'] ? fromMetadata['pure'] === 'true' : null,
        toPurpose: toMetadata['purpose'] || null,
        toDomains,
        toRole: toMetadata['role'] || null,
        toPure: toMetadata['pure'] ? toMetadata['pure'] === 'true' : null,
        relationshipType,
        otherFromRelationships: fromRelationships.map(r => `${r.toName}: ${r.semantic}`),
        otherToRelationships: toRelationships.map(r => `${r.fromName}: ${r.semantic}`),
        sharedDomains,
      };
    });
  }
}
