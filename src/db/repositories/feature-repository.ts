import type Database from 'better-sqlite3';
import { ensureFeaturesTables, ensureFlowsTables } from '../schema-manager.js';
import type { Feature, FeatureWithFlows, Flow } from '../schema.js';

export interface FeatureInsertOptions {
  description?: string;
}

/**
 * Repository for feature (product-level flow grouping) operations.
 */
export class FeatureRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert a new feature.
   */
  insert(name: string, slug: string, options?: FeatureInsertOptions): number {
    ensureFeaturesTables(this.db);

    const stmt = this.db.prepare(`
      INSERT INTO features (name, slug, description)
      VALUES (?, ?, ?)
    `);

    const result = stmt.run(name, slug, options?.description ?? null);
    return result.lastInsertRowid as number;
  }

  /**
   * Add flow associations to a feature.
   */
  addFlows(featureId: number, flowIds: number[]): void {
    ensureFeaturesTables(this.db);

    const stmt = this.db.prepare(`
      INSERT INTO feature_flows (feature_id, flow_id)
      VALUES (?, ?)
    `);

    for (const flowId of flowIds) {
      stmt.run(featureId, flowId);
    }
  }

  /**
   * Get feature by ID.
   */
  getById(id: number): Feature | null {
    ensureFeaturesTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        name,
        slug,
        description,
        created_at as createdAt
      FROM features
      WHERE id = ?
    `);
    const row = stmt.get(id) as Feature | undefined;
    return row ?? null;
  }

  /**
   * Get feature by slug.
   */
  getBySlug(slug: string): Feature | null {
    ensureFeaturesTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        name,
        slug,
        description,
        created_at as createdAt
      FROM features
      WHERE slug = ?
    `);
    const row = stmt.get(slug) as Feature | undefined;
    return row ?? null;
  }

  /**
   * Get all features.
   */
  getAll(): Feature[] {
    ensureFeaturesTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        name,
        slug,
        description,
        created_at as createdAt
      FROM features
      ORDER BY name
    `);
    return stmt.all() as Feature[];
  }

  /**
   * Get a feature with its associated flows.
   */
  getWithFlows(featureId: number): FeatureWithFlows | null {
    ensureFeaturesTables(this.db);
    ensureFlowsTables(this.db);

    const feature = this.getById(featureId);
    if (!feature) return null;

    const stmt = this.db.prepare(`
      SELECT
        f.id,
        f.name,
        f.slug,
        f.entry_point_module_id as entryPointModuleId,
        f.entry_point_id as entryPointId,
        f.entry_path as entryPath,
        f.stakeholder,
        f.description,
        f.action_type as actionType,
        f.target_entity as targetEntity,
        f.tier,
        f.created_at as createdAt
      FROM flows f
      JOIN feature_flows ff ON f.id = ff.flow_id
      WHERE ff.feature_id = ?
      ORDER BY f.name
    `);

    const flows = stmt.all(featureId) as Flow[];
    return { ...feature, flows };
  }

  /**
   * Get features associated with a specific flow.
   */
  getFeaturesForFlow(flowId: number): Feature[] {
    ensureFeaturesTables(this.db);
    return this.db
      .prepare(
        `SELECT f.id, f.name, f.slug, f.description, f.created_at as createdAt
        FROM features f
        JOIN feature_flows ff ON f.id = ff.feature_id
        WHERE ff.flow_id = ?
        ORDER BY f.name`
      )
      .all(flowId) as Feature[];
  }

  /**
   * Get count of features.
   */
  getCount(): number {
    ensureFeaturesTables(this.db);
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM features');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get count of flows assigned to at least one feature.
   */
  getAssignedFlowCount(): number {
    ensureFeaturesTables(this.db);
    const stmt = this.db.prepare('SELECT COUNT(DISTINCT flow_id) as count FROM feature_flows');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Update a feature's name and/or description.
   */
  update(id: number, updates: { name?: string; description?: string }): boolean {
    ensureFeaturesTables(this.db);

    const sets: string[] = [];
    const params: (string | null)[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      params.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description);
    }

    if (sets.length === 0) return false;

    params.push(String(id));
    const stmt = this.db.prepare(`UPDATE features SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Delete a feature and cascade delete its flow associations.
   */
  delete(id: number): boolean {
    ensureFeaturesTables(this.db);

    // Delete flow associations first
    this.db.prepare('DELETE FROM feature_flows WHERE feature_id = ?').run(id);

    const stmt = this.db.prepare('DELETE FROM features WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Remove a flow-feature association.
   */
  removeFlow(featureId: number, flowId: number): boolean {
    ensureFeaturesTables(this.db);
    const stmt = this.db.prepare('DELETE FROM feature_flows WHERE feature_id = ? AND flow_id = ?');
    const result = stmt.run(featureId, flowId);
    return result.changes > 0;
  }

  /**
   * Delete all features and their flow associations.
   */
  clear(): number {
    ensureFeaturesTables(this.db);
    const stmt = this.db.prepare('DELETE FROM features');
    const result = stmt.run();
    return result.changes;
  }
}
