import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database-facade.js';

describe('Incremental Enrichment', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
    db.setMetadata('source_directory', '/tmp/test');
  });

  afterEach(() => {
    db.close();
  });

  /** Insert definitions and return their IDs */
  function insertDefinitions(count: number): number[] {
    const fileId = db.insertFile({
      path: 'test.ts',
      language: 'typescript',
      contentHash: `hash-${count}`,
      sizeBytes: 100,
      modifiedAt: new Date().toISOString(),
    });
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const id = db.insertDefinition(fileId, {
        name: `def${i}`,
        kind: 'function',
        isExported: true,
        isDefault: false,
        position: { row: i * 10, column: 0 },
        endPosition: { row: i * 10 + 5, column: 0 },
      });
      ids.push(id);
    }
    return ids;
  }

  describe('cleanStaleAnnotations (metadata + relationship cleanup)', () => {
    it('deletes metadata for modified defs only (not added)', () => {
      const defIds = insertDefinitions(3);

      // Set metadata on all
      for (const id of defIds) {
        db.metadata.set(id, 'purpose', `purpose of ${id}`);
        db.metadata.set(id, 'domain', '["test"]');
        db.metadata.set(id, 'pure', 'true');
      }

      // Mark first as modified, second as added in dirty tracking
      db.syncDirty.markDirty('metadata', defIds[0], 'modified');
      db.syncDirty.markDirty('metadata', defIds[1], 'added');

      // Get modified entries
      const dirtyEntries = db.syncDirty.getDirty('metadata');
      const modifiedDefIds = dirtyEntries.filter((e) => e.reason === 'modified').map((e) => e.entityId);

      expect(modifiedDefIds).toHaveLength(1);
      expect(modifiedDefIds[0]).toBe(defIds[0]);

      // Clean stale annotations for modified defs
      const metaRemoved = db.metadata.removeForDefinitions(modifiedDefIds, ['purpose', 'domain', 'pure']);
      expect(metaRemoved).toBe(3); // 3 keys for 1 def

      // Modified def has no metadata
      expect(db.metadata.getValue(defIds[0], 'purpose')).toBeNull();
      expect(db.metadata.getValue(defIds[0], 'domain')).toBeNull();
      expect(db.metadata.getValue(defIds[0], 'pure')).toBeNull();

      // Added def still has metadata
      expect(db.metadata.getValue(defIds[1], 'purpose')).toBe(`purpose of ${defIds[1]}`);

      // Unaffected def still has metadata
      expect(db.metadata.getValue(defIds[2], 'purpose')).toBe(`purpose of ${defIds[2]}`);
    });

    it('deletes relationship annotations for modified defs', () => {
      const defIds = insertDefinitions(3);

      // Create relationship annotations
      db.relationships.set(defIds[0], defIds[1], 'def0 calls def1');
      db.relationships.set(defIds[0], defIds[2], 'def0 uses def2');
      db.relationships.set(defIds[1], defIds[2], 'def1 uses def2');

      // Clean for modified def 0
      const removed = db.relationships.deleteAnnotationsForDefinitions([defIds[0]]);
      expect(removed).toBe(2); // 2 annotations from def0

      // def0 annotations gone
      expect(db.relationships.get(defIds[0], defIds[1])).toBeNull();
      expect(db.relationships.get(defIds[0], defIds[2])).toBeNull();

      // def1 → def2 preserved
      expect(db.relationships.get(defIds[1], defIds[2])).not.toBeNull();
    });
  });

  describe('dirty entry persistence on failure', () => {
    it('dirty entries persist when not explicitly drained (simulating step failure)', () => {
      db.syncDirty.markDirty('metadata', 1, 'modified');
      db.syncDirty.markDirty('relationships', 2, 'modified');

      // Simulate: enrichment step for metadata succeeds → drain
      db.syncDirty.drain('metadata');
      expect(db.syncDirty.count('metadata')).toBe(0);

      // Simulate: enrichment step for relationships fails → no drain
      // Dirty entries persist for retry on next sync
      expect(db.syncDirty.count('relationships')).toBe(1);
    });

    it('drain inside try block means failure preserves entries', () => {
      db.syncDirty.markDirty('metadata', 1, 'modified');
      db.syncDirty.markDirty('metadata', 2, 'added');

      // Simulate the pattern: drain only on success
      const stepSucceeds = false;
      try {
        if (!stepSucceeds) throw new Error('LLM call failed');
        db.syncDirty.drain('metadata');
      } catch {
        // Error swallowed, drain NOT called
      }

      // Dirty entries survive for retry
      expect(db.syncDirty.count('metadata')).toBe(2);
      expect(db.syncDirty.getDirtyIds('metadata')).toEqual([1, 2]);
    });

    it('drain inside try block means success clears entries', () => {
      db.syncDirty.markDirty('metadata', 1, 'modified');
      db.syncDirty.markDirty('metadata', 2, 'added');

      // Simulate the pattern: drain only on success
      const stepSucceeds = true;
      try {
        if (!stepSucceeds) throw new Error('LLM call failed');
        db.syncDirty.drain('metadata');
      } catch {
        // Not reached
      }

      // Dirty entries cleared after success
      expect(db.syncDirty.count('metadata')).toBe(0);
    });
  });

  describe('layer skipping', () => {
    it('reports 0 for layers with no dirty entries', () => {
      expect(db.syncDirty.count('flows')).toBe(0);

      db.syncDirty.markDirty('metadata', 1, 'modified');
      expect(db.syncDirty.count('metadata')).toBe(1);
    });

    it('hasAny returns false for empty layers', () => {
      expect(db.syncDirty.hasAny('flows')).toBe(false);
      expect(db.syncDirty.hasAny('interactions')).toBe(false);

      db.syncDirty.markDirty('flows', 1, 'parent_dirty');
      expect(db.syncDirty.hasAny('flows')).toBe(true);
    });
  });
});
