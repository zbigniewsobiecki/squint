import type Database from 'better-sqlite3';
import { ensureSyncDirtyTable } from '../schema-manager.js';
import type { DirtyLayer, DirtyReason, SyncDirtyEntry } from '../schema.js';

export class SyncDirtyRepository {
  private conn: Database.Database;

  constructor(conn: Database.Database) {
    this.conn = conn;
    ensureSyncDirtyTable(conn);
  }

  /**
   * Mark an entity as dirty for a given layer.
   * Uses INSERT OR REPLACE so re-marking with a different reason overwrites.
   */
  markDirty(layer: DirtyLayer, entityId: number, reason: DirtyReason): void {
    this.conn
      .prepare('INSERT OR REPLACE INTO sync_dirty (layer, entity_id, reason) VALUES (?, ?, ?)')
      .run(layer, entityId, reason);
  }

  /**
   * Mark multiple entities as dirty in a batch.
   * Callers must ensure this runs inside an existing transaction for performance.
   */
  markDirtyBatch(entries: SyncDirtyEntry[]): void {
    if (entries.length === 0) return;
    const stmt = this.conn.prepare('INSERT OR REPLACE INTO sync_dirty (layer, entity_id, reason) VALUES (?, ?, ?)');
    for (const entry of entries) {
      stmt.run(entry.layer, entry.entityId, entry.reason);
    }
  }

  /**
   * Get all dirty entries for a given layer.
   */
  getDirty(layer: DirtyLayer): SyncDirtyEntry[] {
    return this.conn
      .prepare('SELECT layer, entity_id as entityId, reason FROM sync_dirty WHERE layer = ?')
      .all(layer) as SyncDirtyEntry[];
  }

  /**
   * Get dirty entity IDs for a given layer.
   */
  getDirtyIds(layer: DirtyLayer): number[] {
    const rows = this.conn.prepare('SELECT entity_id as entityId FROM sync_dirty WHERE layer = ?').all(layer) as Array<{
      entityId: number;
    }>;
    return rows.map((r) => r.entityId);
  }

  /**
   * Drain (delete) all dirty entries for a given layer.
   * Call after the layer has been processed.
   */
  drain(layer: DirtyLayer): number {
    const result = this.conn.prepare('DELETE FROM sync_dirty WHERE layer = ?').run(layer);
    return result.changes;
  }

  /**
   * Clear all dirty entries across all layers.
   */
  clear(): number {
    const result = this.conn.prepare('DELETE FROM sync_dirty').run();
    return result.changes;
  }

  /**
   * Check if any dirty entries exist for a given layer.
   */
  hasAny(layer: DirtyLayer): boolean {
    const row = this.conn.prepare('SELECT 1 FROM sync_dirty WHERE layer = ? LIMIT 1').get(layer);
    return row !== undefined;
  }

  /**
   * Count dirty entries for a given layer.
   */
  count(layer: DirtyLayer): number {
    const row = this.conn.prepare('SELECT COUNT(*) as count FROM sync_dirty WHERE layer = ?').get(layer) as {
      count: number;
    };
    return row.count;
  }

  /**
   * Count total dirty entries across all layers.
   */
  countAll(): number {
    const row = this.conn.prepare('SELECT COUNT(*) as count FROM sync_dirty').get() as { count: number };
    return row.count;
  }

  /**
   * Get a summary of dirty counts per layer.
   */
  getSummary(): Record<DirtyLayer, number> {
    const rows = this.conn.prepare('SELECT layer, COUNT(*) as count FROM sync_dirty GROUP BY layer').all() as Array<{
      layer: DirtyLayer;
      count: number;
    }>;

    const summary: Record<DirtyLayer, number> = {
      metadata: 0,
      relationships: 0,
      modules: 0,
      contracts: 0,
      interactions: 0,
      flows: 0,
      features: 0,
    };

    for (const row of rows) {
      summary[row.layer] = row.count;
    }

    return summary;
  }
}
