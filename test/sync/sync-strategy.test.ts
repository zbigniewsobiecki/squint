import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database-facade.js';
import type { SyncResult } from '../../src/sync/incremental-indexer.js';
import { DEFAULT_THRESHOLDS, selectStrategy } from '../../src/sync/sync-strategy.js';

function emptySyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    filesAdded: 0,
    filesModified: 0,
    filesDeleted: 0,
    definitionsAdded: 0,
    definitionsRemoved: 0,
    definitionsUpdated: 0,
    importsRefreshed: 0,
    staleMetadataCount: 0,
    unassignedCount: 0,
    interactionsRecalculated: false,
    dependentFilesReResolved: 0,
    danglingRefsCleaned: 0,
    ghostRowsCleaned: 0,
    inheritanceResult: { created: 0 },
    addedDefinitionIds: [],
    removedDefinitionIds: [],
    updatedDefinitionIds: [],
    ...overrides,
  };
}

describe('selectStrategy', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
    db.setMetadata('source_directory', '/tmp/test');
  });

  afterEach(() => {
    db.close();
  });

  /** Insert N definitions into the database */
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
        position: { row: i, column: 0 },
        endPosition: { row: i + 1, column: 0 },
      });
      ids.push(id);
    }
    return ids;
  }

  /** Set up modules and assign definitions to them */
  function setupModules(moduleCount: number, defIds: number[]): number[] {
    const conn = db.getConnection();
    const moduleIds: number[] = [];
    for (let i = 0; i < moduleCount; i++) {
      const moduleId = conn
        .prepare('INSERT INTO modules (slug, full_path, name, depth) VALUES (?, ?, ?, 0)')
        .run(`mod${i}`, `project.mod${i}`, `Module ${i}`).lastInsertRowid as number;
      moduleIds.push(moduleId);
    }
    // Assign definitions round-robin to modules
    for (let i = 0; i < defIds.length; i++) {
      const moduleId = moduleIds[i % moduleIds.length];
      conn.prepare('INSERT INTO module_members (module_id, definition_id) VALUES (?, ?)').run(moduleId, defIds[i]);
    }
    return moduleIds;
  }

  /** Set up interactions between modules */
  function setupInteractions(moduleIds: number[], count: number): void {
    const conn = db.getConnection();
    for (let i = 0; i < count && i + 1 < moduleIds.length; i++) {
      conn
        .prepare("INSERT INTO interactions (from_module_id, to_module_id, weight, source) VALUES (?, ?, 1, 'ast')")
        .run(moduleIds[i], moduleIds[i + 1]);
    }
  }

  it('returns "none" when no definition changes', () => {
    insertDefinitions(10);
    const result = emptySyncResult();

    const decision = selectStrategy(db, result);

    expect(decision.strategy).toBe('none');
    expect(decision.reason).toContain('No definition changes');
    expect(decision.metrics.changedDefinitions).toBe(0);
  });

  it('returns "full" when no modules exist', () => {
    insertDefinitions(10);
    const result = emptySyncResult({
      addedDefinitionIds: [100],
      definitionsAdded: 1,
    });

    const decision = selectStrategy(db, result);

    expect(decision.strategy).toBe('full');
    expect(decision.reason).toContain('No modules exist');
  });

  it('returns "full" when definition change ratio exceeds threshold', () => {
    const defIds = insertDefinitions(10);
    setupModules(3, defIds);

    // Change 5 out of 10 definitions (50% > 40% threshold)
    const changedIds = defIds.slice(0, 5);
    const result = emptySyncResult({
      updatedDefinitionIds: changedIds,
      definitionsUpdated: changedIds.length,
    });

    const decision = selectStrategy(db, result);

    expect(decision.strategy).toBe('full');
    expect(decision.reason).toContain('Definition change ratio');
    expect(decision.metrics.changeRatio).toBeCloseTo(0.5);
  });

  it('returns "full" when module affected ratio exceeds threshold', () => {
    const defIds = insertDefinitions(100);
    const moduleIds = setupModules(5, defIds);

    // Mark 4 out of 5 modules dirty (80% > 60% threshold)
    for (let i = 0; i < 4; i++) {
      db.syncDirty.markDirty('modules', moduleIds[i], 'modified');
    }

    // Change only 2 definitions (2% of 100, well below 40% threshold)
    const result = emptySyncResult({
      updatedDefinitionIds: [defIds[0], defIds[1]],
      definitionsUpdated: 2,
    });

    const decision = selectStrategy(db, result);

    expect(decision.strategy).toBe('full');
    expect(decision.reason).toContain('Module affected ratio');
    expect(decision.metrics.moduleRatio).toBeCloseTo(0.8);
  });

  it('returns "full" when interaction affected ratio exceeds threshold', () => {
    const defIds = insertDefinitions(100);
    const moduleIds = setupModules(10, defIds);
    setupInteractions(moduleIds, 9);

    // Mark 8 out of 9 interactions dirty (89% > 70% threshold)
    const conn = db.getConnection();
    const interactions = conn.prepare('SELECT id FROM interactions').all() as Array<{ id: number }>;
    for (let i = 0; i < 8 && i < interactions.length; i++) {
      db.syncDirty.markDirty('interactions', interactions[i].id, 'parent_dirty');
    }

    // Change 1 definition (1% — below defs threshold)
    const result = emptySyncResult({
      updatedDefinitionIds: [defIds[0]],
      definitionsUpdated: 1,
    });

    const decision = selectStrategy(db, result);

    expect(decision.strategy).toBe('full');
    expect(decision.reason).toContain('Interaction affected ratio');
  });

  it('returns "incremental" when all ratios are within thresholds', () => {
    const defIds = insertDefinitions(100);
    const moduleIds = setupModules(10, defIds);
    setupInteractions(moduleIds, 9);

    // Mark 1 module dirty (10% < 60%)
    db.syncDirty.markDirty('modules', moduleIds[0], 'modified');

    // Change 2 definitions (2% < 40%)
    const result = emptySyncResult({
      updatedDefinitionIds: [defIds[0], defIds[1]],
      definitionsUpdated: 2,
    });

    const decision = selectStrategy(db, result);

    expect(decision.strategy).toBe('incremental');
    expect(decision.reason).toContain('within incremental thresholds');
  });

  it('uses custom thresholds when provided', () => {
    const defIds = insertDefinitions(100);
    setupModules(10, defIds);

    // Change 5 definitions (5%) — below default 40% but above custom 3%
    const changedIds = defIds.slice(0, 5);
    const result = emptySyncResult({
      updatedDefinitionIds: changedIds,
      definitionsUpdated: changedIds.length,
    });

    const decision = selectStrategy(db, result, {
      ...DEFAULT_THRESHOLDS,
      defsChangedRatio: 0.03,
    });

    expect(decision.strategy).toBe('full');
    expect(decision.reason).toContain('Definition change ratio');
  });

  it('includes accurate metrics in the decision', () => {
    const defIds = insertDefinitions(20);
    const moduleIds = setupModules(4, defIds);
    setupInteractions(moduleIds, 3);

    db.syncDirty.markDirty('modules', moduleIds[0], 'modified');

    const conn = db.getConnection();
    const interactions = conn.prepare('SELECT id FROM interactions').all() as Array<{ id: number }>;
    db.syncDirty.markDirty('interactions', interactions[0].id, 'parent_dirty');

    const result = emptySyncResult({
      addedDefinitionIds: [100],
      updatedDefinitionIds: [defIds[0]],
      definitionsAdded: 1,
      definitionsUpdated: 1,
    });

    const decision = selectStrategy(db, result);
    const m = decision.metrics;

    expect(m.totalDefinitions).toBe(20);
    expect(m.changedDefinitions).toBe(2); // 1 added + 1 updated
    expect(m.totalModules).toBe(4);
    expect(m.affectedModules).toBe(1);
    expect(m.totalInteractions).toBe(3);
    expect(m.affectedInteractions).toBe(1);
  });
});
