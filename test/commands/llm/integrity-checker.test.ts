import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../../src/commands/llm/_shared/verify/integrity-checker.js';
import { IndexDatabase } from '../../../src/db/database.js';

describe('checkReferentialIntegrity', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  function insertFile(filePath: string) {
    return db.files.insert({
      path: filePath,
      language: 'typescript',
      contentHash: `hash-${filePath}`,
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDefinition(
    fileId: number,
    name: string,
    kind = 'function',
    opts?: {
      line?: number;
      endLine?: number;
      isExported?: boolean;
      extends?: string;
      implements?: string[];
    }
  ) {
    return db.files.insertDefinition(fileId, {
      name,
      kind,
      isExported: opts?.isExported ?? true,
      isDefault: false,
      position: { row: (opts?.line ?? 1) - 1, column: 0 },
      endPosition: { row: (opts?.endLine ?? 10) - 1, column: 1 },
      extends: opts?.extends,
      implements: opts?.implements,
    });
  }

  it('clean state passes', () => {
    const result = checkReferentialIntegrity(db);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('ghost relationship detected (delete definition after creating relationship)', () => {
    const fileId = insertFile('/src/a.ts');
    const def1 = insertDefinition(fileId, 'funcA');
    const def2 = insertDefinition(fileId, 'funcB', 'function', { line: 20, endLine: 30 });
    db.relationships.set(def1, def2, 'calls', 'uses');

    // Delete def2 to create orphan — disable FK enforcement
    (db as any).conn.pragma('foreign_keys = OFF');
    (db as any).conn.prepare('DELETE FROM definitions WHERE id = ?').run(def2);
    (db as any).conn.pragma('foreign_keys = ON');

    const result = checkReferentialIntegrity(db);
    expect(result.passed).toBe(false);
    const ghostRels = result.issues.filter((i) => i.category === 'ghost-relationship');
    expect(ghostRels.length).toBeGreaterThanOrEqual(1);
    expect(ghostRels[0].fixData?.action).toBe('remove-ghost');
  });

  it('ghost member detected (delete definition after module assignment)', () => {
    const rootId = db.modules.ensureRoot();
    const modId = db.modules.insert(rootId, 'mod', 'Mod');
    const fileId = insertFile('/src/a.ts');
    const defId = insertDefinition(fileId, 'funcA');
    db.modules.assignSymbol(defId, modId);

    // Delete definition to create orphan member
    (db as any).conn.pragma('foreign_keys = OFF');
    (db as any).conn.prepare('DELETE FROM definitions WHERE id = ?').run(defId);
    (db as any).conn.pragma('foreign_keys = ON');

    const result = checkReferentialIntegrity(db);
    expect(result.passed).toBe(false);
    const ghostMembers = result.issues.filter((i) => i.category === 'ghost-member');
    expect(ghostMembers.length).toBeGreaterThanOrEqual(1);
  });

  it('ghost entry point detected (flow references deleted definition)', () => {
    const rootId = db.modules.ensureRoot();
    const modId = db.modules.insert(rootId, 'mod', 'Mod');
    const fileId = insertFile('/src/a.ts');
    const defId = insertDefinition(fileId, 'funcA');
    db.modules.assignSymbol(defId, modId);

    db.flows.insert('Flow', 'flow', { entryPointModuleId: modId, entryPointId: defId });

    // Delete definition to create ghost entry point
    (db as any).conn.pragma('foreign_keys = OFF');
    (db as any).conn.prepare('DELETE FROM definitions WHERE id = ?').run(defId);
    (db as any).conn.pragma('foreign_keys = ON');

    const result = checkReferentialIntegrity(db);
    expect(result.passed).toBe(false);
    const ghostEntries = result.issues.filter((i) => i.category === 'ghost-entry-point');
    expect(ghostEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('ghost interaction detected (interaction references deleted module)', () => {
    const rootId = db.modules.ensureRoot();
    const modA = db.modules.insert(rootId, 'a', 'A');
    const modB = db.modules.insert(rootId, 'b', 'B');
    db.interactions.insert(modA, modB);

    // Delete modB to create ghost interaction
    (db as any).conn.pragma('foreign_keys = OFF');
    (db as any).conn.prepare('DELETE FROM modules WHERE id = ?').run(modB);
    (db as any).conn.pragma('foreign_keys = ON');

    const result = checkReferentialIntegrity(db);
    expect(result.passed).toBe(false);
    const ghostInteractions = result.issues.filter((i) => i.category === 'ghost-interaction');
    expect(ghostInteractions.length).toBeGreaterThanOrEqual(1);
  });

  it('ghost subflow detected (subflow step references deleted flow)', () => {
    const rootId = db.modules.ensureRoot();
    const modA = db.modules.insert(rootId, 'a', 'A');

    const flow1 = db.flows.insert('Parent', 'parent', { entryPointModuleId: modA });
    const flow2 = db.flows.insert('Child', 'child', { entryPointModuleId: modA });
    db.flows.addSubflowSteps(flow1, [flow2]);

    // Delete child flow to create ghost subflow
    (db as any).conn.pragma('foreign_keys = OFF');
    (db as any).conn.prepare('DELETE FROM flows WHERE id = ?').run(flow2);
    (db as any).conn.pragma('foreign_keys = ON');

    const result = checkReferentialIntegrity(db);
    expect(result.passed).toBe(false);
    const ghostSubflows = result.issues.filter((i) => i.category === 'ghost-subflow');
    expect(ghostSubflows.length).toBeGreaterThanOrEqual(1);
  });

  it('ghost entry module detected (flow references deleted module)', () => {
    const rootId = db.modules.ensureRoot();
    const modA = db.modules.insert(rootId, 'a', 'A');

    db.flows.insert('Flow', 'flow', { entryPointModuleId: modA });

    // Delete module to create ghost entry module
    (db as any).conn.pragma('foreign_keys = OFF');
    (db as any).conn.prepare('DELETE FROM modules WHERE id = ?').run(modA);
    (db as any).conn.pragma('foreign_keys = ON');

    const result = checkReferentialIntegrity(db);
    expect(result.passed).toBe(false);
    const ghostEntryModules = result.issues.filter((i) => i.category === 'ghost-entry-module');
    expect(ghostEntryModules.length).toBeGreaterThanOrEqual(1);
  });
});
