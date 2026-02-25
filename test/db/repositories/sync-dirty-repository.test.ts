import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncDirtyRepository } from '../../../src/db/repositories/sync-dirty-repository.js';
import type { DirtyLayer } from '../../../src/db/schema.js';

describe('SyncDirtyRepository', () => {
  let db: Database.Database;
  let repo: SyncDirtyRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    // SyncDirtyRepository constructor calls ensureSyncDirtyTable
    repo = new SyncDirtyRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('markDirty', () => {
    it('inserts a dirty entry', () => {
      repo.markDirty('metadata', 1, 'added');

      const entries = repo.getDirty('metadata');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ layer: 'metadata', entityId: 1, reason: 'added' });
    });

    it('overwrites reason on re-mark (INSERT OR REPLACE)', () => {
      repo.markDirty('metadata', 1, 'added');
      repo.markDirty('metadata', 1, 'modified');

      const entries = repo.getDirty('metadata');
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe('modified');
    });

    it('allows same entity in different layers', () => {
      repo.markDirty('metadata', 1, 'added');
      repo.markDirty('relationships', 1, 'added');

      expect(repo.getDirty('metadata')).toHaveLength(1);
      expect(repo.getDirty('relationships')).toHaveLength(1);
      expect(repo.countAll()).toBe(2);
    });
  });

  describe('markDirtyBatch', () => {
    it('inserts multiple entries', () => {
      repo.markDirtyBatch([
        { layer: 'metadata', entityId: 1, reason: 'added' },
        { layer: 'metadata', entityId: 2, reason: 'modified' },
        { layer: 'relationships', entityId: 3, reason: 'removed' },
      ]);

      expect(repo.count('metadata')).toBe(2);
      expect(repo.count('relationships')).toBe(1);
    });

    it('handles empty array', () => {
      repo.markDirtyBatch([]);
      expect(repo.countAll()).toBe(0);
    });

    it('overwrites reason on duplicate (INSERT OR REPLACE)', () => {
      repo.markDirtyBatch([
        { layer: 'metadata', entityId: 1, reason: 'added' },
        { layer: 'metadata', entityId: 1, reason: 'modified' },
      ]);

      const entries = repo.getDirty('metadata');
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe('modified');
    });
  });

  describe('getDirty', () => {
    it('returns entries for a specific layer', () => {
      repo.markDirtyBatch([
        { layer: 'metadata', entityId: 1, reason: 'added' },
        { layer: 'metadata', entityId: 2, reason: 'modified' },
        { layer: 'relationships', entityId: 3, reason: 'removed' },
      ]);

      const metadataEntries = repo.getDirty('metadata');
      expect(metadataEntries).toHaveLength(2);
      expect(metadataEntries.map((e) => e.entityId).sort()).toEqual([1, 2]);
    });

    it('returns empty array for layer with no entries', () => {
      expect(repo.getDirty('flows')).toEqual([]);
    });
  });

  describe('getDirtyIds', () => {
    it('returns entity IDs for a layer', () => {
      repo.markDirtyBatch([
        { layer: 'modules', entityId: 10, reason: 'modified' },
        { layer: 'modules', entityId: 20, reason: 'modified' },
        { layer: 'interactions', entityId: 30, reason: 'parent_dirty' },
      ]);

      const ids = repo.getDirtyIds('modules');
      expect(ids.sort()).toEqual([10, 20]);
    });

    it('returns empty array when no entries exist', () => {
      expect(repo.getDirtyIds('features')).toEqual([]);
    });
  });

  describe('drain', () => {
    it('deletes all entries for a layer and returns count', () => {
      repo.markDirtyBatch([
        { layer: 'metadata', entityId: 1, reason: 'added' },
        { layer: 'metadata', entityId: 2, reason: 'modified' },
        { layer: 'relationships', entityId: 3, reason: 'removed' },
      ]);

      const drained = repo.drain('metadata');
      expect(drained).toBe(2);
      expect(repo.count('metadata')).toBe(0);
      // Other layers unaffected
      expect(repo.count('relationships')).toBe(1);
    });

    it('returns 0 when layer is empty', () => {
      expect(repo.drain('flows')).toBe(0);
    });
  });

  describe('clear', () => {
    it('deletes all entries across all layers', () => {
      repo.markDirtyBatch([
        { layer: 'metadata', entityId: 1, reason: 'added' },
        { layer: 'relationships', entityId: 2, reason: 'modified' },
        { layer: 'modules', entityId: 3, reason: 'modified' },
      ]);

      const cleared = repo.clear();
      expect(cleared).toBe(3);
      expect(repo.countAll()).toBe(0);
    });

    it('returns 0 on empty table', () => {
      expect(repo.clear()).toBe(0);
    });
  });

  describe('hasAny', () => {
    it('returns true when layer has entries', () => {
      repo.markDirty('metadata', 1, 'added');
      expect(repo.hasAny('metadata')).toBe(true);
    });

    it('returns false when layer is empty', () => {
      expect(repo.hasAny('metadata')).toBe(false);
    });

    it('returns false for empty layer when other layers have entries', () => {
      repo.markDirty('metadata', 1, 'added');
      expect(repo.hasAny('flows')).toBe(false);
    });
  });

  describe('count', () => {
    it('returns count for a specific layer', () => {
      repo.markDirtyBatch([
        { layer: 'metadata', entityId: 1, reason: 'added' },
        { layer: 'metadata', entityId: 2, reason: 'modified' },
        { layer: 'metadata', entityId: 3, reason: 'added' },
      ]);

      expect(repo.count('metadata')).toBe(3);
    });

    it('returns 0 for empty layer', () => {
      expect(repo.count('contracts')).toBe(0);
    });
  });

  describe('countAll', () => {
    it('returns total count across all layers', () => {
      repo.markDirtyBatch([
        { layer: 'metadata', entityId: 1, reason: 'added' },
        { layer: 'relationships', entityId: 2, reason: 'modified' },
        { layer: 'modules', entityId: 3, reason: 'modified' },
      ]);

      expect(repo.countAll()).toBe(3);
    });

    it('returns 0 on empty table', () => {
      expect(repo.countAll()).toBe(0);
    });
  });

  describe('getSummary', () => {
    it('returns counts per layer', () => {
      repo.markDirtyBatch([
        { layer: 'metadata', entityId: 1, reason: 'added' },
        { layer: 'metadata', entityId: 2, reason: 'modified' },
        { layer: 'relationships', entityId: 3, reason: 'removed' },
        { layer: 'modules', entityId: 4, reason: 'modified' },
        { layer: 'interactions', entityId: 5, reason: 'parent_dirty' },
      ]);

      const summary = repo.getSummary();
      expect(summary.metadata).toBe(2);
      expect(summary.relationships).toBe(1);
      expect(summary.modules).toBe(1);
      expect(summary.interactions).toBe(1);
      expect(summary.contracts).toBe(0);
      expect(summary.flows).toBe(0);
      expect(summary.features).toBe(0);
    });

    it('returns all zeros on empty table', () => {
      const summary = repo.getSummary();
      const allLayers: DirtyLayer[] = [
        'metadata',
        'relationships',
        'modules',
        'contracts',
        'interactions',
        'flows',
        'features',
      ];
      for (const layer of allLayers) {
        expect(summary[layer]).toBe(0);
      }
    });
  });
});
