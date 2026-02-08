import type Database from 'better-sqlite3';
import { ensureRelationshipTypeColumn } from '../schema-manager.js';
import type {
  EnhancedRelationshipContext,
  RelationshipAnnotation,
  RelationshipType,
  RelationshipWithDetails,
} from '../schema.js';

export interface UnannotatedInheritance {
  id: number;
  fromId: number;
  fromName: string;
  fromKind: string;
  fromFilePath: string;
  toId: number;
  toName: string;
  toKind: string;
  toFilePath: string;
  relationshipType: 'extends' | 'implements';
}

export interface UnannotatedRelationship {
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
}

/**
 * Repository for relationship annotation operations.
 * Handles CRUD operations for the relationship_annotations table.
 */
export class RelationshipRepository {
  constructor(private db: Database.Database) {}

  /**
   * Set (insert or update) a semantic annotation for a relationship between two definitions.
   */
  set(
    fromDefinitionId: number,
    toDefinitionId: number,
    semantic: string,
    relationshipType: RelationshipType = 'uses'
  ): void {
    ensureRelationshipTypeColumn(this.db);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO relationship_annotations (from_definition_id, to_definition_id, relationship_type, semantic, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(fromDefinitionId, toDefinitionId, relationshipType, semantic);
  }

  /**
   * Get a relationship annotation between two definitions.
   */
  get(fromDefinitionId: number, toDefinitionId: number): RelationshipAnnotation | null {
    ensureRelationshipTypeColumn(this.db);
    const stmt = this.db.prepare(`
      SELECT id, from_definition_id as fromDefinitionId, to_definition_id as toDefinitionId,
             relationship_type as relationshipType, semantic, created_at as createdAt
      FROM relationship_annotations
      WHERE from_definition_id = ? AND to_definition_id = ?
    `);
    const row = stmt.get(fromDefinitionId, toDefinitionId) as RelationshipAnnotation | undefined;
    return row ?? null;
  }

  /**
   * Remove a relationship annotation.
   */
  remove(fromDefinitionId: number, toDefinitionId: number): boolean {
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
  getFrom(fromDefinitionId: number): RelationshipWithDetails[] {
    ensureRelationshipTypeColumn(this.db);
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
        ra.relationship_type as relationshipType,
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
  getTo(toDefinitionId: number): RelationshipWithDetails[] {
    ensureRelationshipTypeColumn(this.db);
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
        ra.relationship_type as relationshipType,
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
  getAll(options?: { limit?: number }): RelationshipWithDetails[] {
    ensureRelationshipTypeColumn(this.db);
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
        ra.relationship_type as relationshipType,
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
  getCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM relationship_annotations');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get unannotated inheritance relationships (extends/implements with placeholder semantic).
   */
  getUnannotatedInheritance(limit = 50): UnannotatedInheritance[] {
    ensureRelationshipTypeColumn(this.db);
    const stmt = this.db.prepare(`
      SELECT
        ra.id,
        ra.from_definition_id as fromId,
        fd.name as fromName,
        fd.kind as fromKind,
        ff.path as fromFilePath,
        ra.to_definition_id as toId,
        td.name as toName,
        td.kind as toKind,
        tf.path as toFilePath,
        ra.relationship_type as relationshipType
      FROM relationship_annotations ra
      JOIN definitions fd ON ra.from_definition_id = fd.id
      JOIN files ff ON fd.file_id = ff.id
      JOIN definitions td ON ra.to_definition_id = td.id
      JOIN files tf ON td.file_id = tf.id
      WHERE ra.semantic = 'PENDING_LLM_ANNOTATION'
        AND ra.relationship_type IN ('extends', 'implements')
      ORDER BY ff.path, fd.line
      LIMIT ?
    `);
    return stmt.all(limit) as UnannotatedInheritance[];
  }

  /**
   * Get count of unannotated inheritance relationships.
   */
  getUnannotatedInheritanceCount(): number {
    ensureRelationshipTypeColumn(this.db);
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM relationship_annotations
      WHERE semantic = 'PENDING_LLM_ANNOTATION'
        AND relationship_type IN ('extends', 'implements')
    `);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get definitions that have calls to other definitions but no annotation.
   */
  getUnannotated(options?: { limit?: number; fromDefinitionId?: number }): UnannotatedRelationship[] {
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
    return stmt.all(...params) as UnannotatedRelationship[];
  }

  /**
   * Get count of unannotated relationships.
   */
  getUnannotatedCount(fromDefinitionId?: number): number {
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
   */
  getNextToAnnotate(
    options: { limit?: number; fromDefinitionId?: number } | undefined,
    getDefinitionMetadata: (id: number) => Record<string, string>,
    getDefinitionDependencies: (id: number) => Array<{ dependencyId: number; name: string }>
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

    // Enhance each relationship with metadata and context
    const results: EnhancedRelationshipContext[] = [];

    for (const row of rows) {
      // Get metadata for both symbols
      const fromMeta = getDefinitionMetadata(row.fromDefinitionId);
      const toMeta = getDefinitionMetadata(row.toDefinitionId);

      // Parse domains
      let fromDomains: string[] | null = null;
      let toDomains: string[] | null = null;
      try {
        if (fromMeta.domain) {
          fromDomains = JSON.parse(fromMeta.domain) as string[];
        }
      } catch {
        /* ignore */
      }
      try {
        if (toMeta.domain) {
          toDomains = JSON.parse(toMeta.domain) as string[];
        }
      } catch {
        /* ignore */
      }

      // Calculate shared domains
      const sharedDomains: string[] = [];
      if (fromDomains && toDomains) {
        for (const d of fromDomains) {
          if (toDomains.includes(d)) {
            sharedDomains.push(d);
          }
        }
      }

      // Get other relationships from source (what else does source call?)
      const otherFromRels = getDefinitionDependencies(row.fromDefinitionId)
        .filter((d) => d.dependencyId !== row.toDefinitionId)
        .map((d) => d.name);

      // Get other relationships to target (what else calls target?)
      const otherToRelsStmt = this.db.prepare(`
        SELECT DISTINCT source.name
        FROM definitions source
        JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
        JOIN symbols s ON u.symbol_id = s.id
        WHERE s.definition_id = ?
          AND source.id != ?
          AND (
            s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
            OR s.file_id = source.file_id
          )
        ORDER BY source.name
        LIMIT 10
      `);
      const otherToRels = otherToRelsStmt.all(row.toDefinitionId, row.fromDefinitionId) as Array<{ name: string }>;

      results.push({
        fromDefinitionId: row.fromDefinitionId,
        fromName: row.fromName,
        fromKind: row.fromKind,
        fromFilePath: row.fromFilePath,
        fromLine: row.fromLine,
        fromEndLine: row.fromEndLine,
        toDefinitionId: row.toDefinitionId,
        toName: row.toName,
        toKind: row.toKind,
        toFilePath: row.toFilePath,
        toLine: row.toLine,
        toEndLine: row.toEndLine,
        fromPurpose: fromMeta.purpose ?? null,
        fromDomains,
        fromRole: fromMeta.role ?? null,
        fromPure: fromMeta.pure ? fromMeta.pure === 'true' : null,
        toPurpose: toMeta.purpose ?? null,
        toDomains,
        toRole: toMeta.role ?? null,
        toPure: toMeta.pure ? toMeta.pure === 'true' : null,
        relationshipType: 'call', // Default to call for now
        usageLine: row.usageLine,
        otherFromRelationships: otherFromRels.slice(0, 10),
        otherToRelationships: otherToRels.map((r) => r.name),
        sharedDomains,
      });
    }

    return results;
  }
}
