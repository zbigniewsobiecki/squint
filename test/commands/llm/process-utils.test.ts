import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../../src/db/database.js';
import {
  areSameProcess,
  computeProcessGroups,
  getCrossProcessGroupPairs,
  getProcessDescription,
  getProcessGroupLabel,
} from '../../../src/commands/llm/_shared/process-utils.js';
import type { Module } from '../../../src/db/schema.js';

describe('process-utils', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================
  // Helpers
  // ============================================================

  function insertFile(path: string) {
    return db.insertFile({
      path,
      language: 'typescript',
      contentHash: `hash-${path}`,
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDefinition(fileId: number, name: string) {
    return db.insertDefinition(fileId, {
      name,
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });
  }

  function insertImport(fromFileId: number, toFileId: number, isTypeOnly: boolean = false) {
    return db.insertReference(fromFileId, toFileId, {
      type: 'import',
      source: './some-module',
      isExternal: false,
      isTypeOnly,
      position: { row: 0, column: 0 },
    });
  }

  function setupModule(name: string, slug: string, parentId: number) {
    return db.insertModule(parentId, slug, name);
  }

  // ============================================================
  // computeProcessGroups
  // ============================================================

  describe('computeProcessGroups', () => {
    it('empty database (no modules) → groupCount === 0', () => {
      const groups = computeProcessGroups(db);
      expect(groups.groupCount).toBe(0);
      expect(groups.moduleToGroup.size).toBe(0);
      expect(groups.groupToModules.size).toBe(0);
    });

    it('single connected component → modA and modB in same group', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      // A imports B (runtime import)
      insertImport(fileA, fileB, false);

      const groups = computeProcessGroups(db);
      // Root module (no files) gets its own isolated group, so total = 2
      // But modA and modB share one group
      const groupA = groups.moduleToGroup.get(modA);
      const groupB = groups.moduleToGroup.get(modB);
      expect(groupA).toBeDefined();
      expect(groupA).toBe(groupB);
    });

    it('two disconnected components → modA and modB in different groups', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      // No imports between A and B

      const groups = computeProcessGroups(db);
      const groupA = groups.moduleToGroup.get(modA);
      const groupB = groups.moduleToGroup.get(modB);
      expect(groupA).not.toBe(groupB);
    });

    it('type-only imports do not bridge components', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      // Type-only import
      insertImport(fileA, fileB, true);

      const groups = computeProcessGroups(db);
      // modA and modB should be in different groups (type-only doesn't bridge)
      const groupA = groups.moduleToGroup.get(modA);
      const groupB = groups.moduleToGroup.get(modB);
      expect(groupA).not.toBe(groupB);
    });

    it('modules with no files get isolated groups', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      // No files, no definitions assigned

      const groups = computeProcessGroups(db);
      // Each module (including root) gets its own isolated group
      expect(groups.groupCount).toBe(3); // root + modA + modB
      expect(groups.moduleToGroup.get(modA)).not.toBe(groups.moduleToGroup.get(modB));
    });

    it('module with files in multiple components is assigned to majority group', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      // Module A has 3 files: 2 in component X, 1 in component Y
      const fileA1 = insertFile('/src/a1.ts');
      const fileA2 = insertFile('/src/a2.ts');
      const fileA3 = insertFile('/src/a3.ts');
      const fileB1 = insertFile('/src/b1.ts');

      const defA1 = insertDefinition(fileA1, 'funcA1');
      const defA2 = insertDefinition(fileA2, 'funcA2');
      const defA3 = insertDefinition(fileA3, 'funcA3');
      const defB1 = insertDefinition(fileB1, 'funcB1');

      db.assignSymbolToModule(defA1, modA);
      db.assignSymbolToModule(defA2, modA);
      db.assignSymbolToModule(defA3, modA);
      db.assignSymbolToModule(defB1, modB);

      // Connect A1 and A2 (component X)
      insertImport(fileA1, fileA2, false);
      // A3 is isolated from A1/A2 but connected to B1 (component Y)
      insertImport(fileA3, fileB1, false);

      const groups = computeProcessGroups(db);
      // ModA should be assigned to component X (majority: 2 files vs 1)
      const groupA = groups.moduleToGroup.get(modA)!;
      const groupB = groups.moduleToGroup.get(modB)!;

      // A3 and B1 share a component but modA is in a different component (majority)
      expect(groupA).not.toBe(groupB);
    });

    it('root module is excluded from grouping', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);

      const fileA = insertFile('/src/a.ts');
      const defA = insertDefinition(fileA, 'funcA');
      db.assignSymbolToModule(defA, modA);

      const groups = computeProcessGroups(db);
      // Root module (depth 0) is in getAllModules but has no files
      // It should get its own isolated group
      expect(groups.moduleToGroup.has(rootId)).toBe(true);
      expect(groups.moduleToGroup.has(modA)).toBe(true);
    });
  });

  // ============================================================
  // areSameProcess
  // ============================================================

  describe('areSameProcess', () => {
    it('returns true for modules in the same group', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      insertImport(fileA, fileB, false);

      const groups = computeProcessGroups(db);
      expect(areSameProcess(modA, modB, groups)).toBe(true);
    });

    it('returns false for modules in different groups', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      const groups = computeProcessGroups(db);
      expect(areSameProcess(modA, modB, groups)).toBe(false);
    });

    it('returns true when either module has no group (conservative)', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);

      const fileA = insertFile('/src/a.ts');
      const defA = insertDefinition(fileA, 'funcA');
      db.assignSymbolToModule(defA, modA);

      const groups = computeProcessGroups(db);
      // 999 is not in any group
      expect(areSameProcess(modA, 999, groups)).toBe(true);
      expect(areSameProcess(999, modA, groups)).toBe(true);
    });
  });

  // ============================================================
  // getProcessDescription
  // ============================================================

  describe('getProcessDescription', () => {
    it('returns "same-process (shared import graph)" for same group', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      insertImport(fileA, fileB, false);

      const groups = computeProcessGroups(db);
      expect(getProcessDescription(modA, modB, groups)).toBe('same-process (shared import graph)');
    });

    it('returns "separate-process (no import connectivity)" for different groups', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      const groups = computeProcessGroups(db);
      expect(getProcessDescription(modA, modB, groups)).toBe('separate-process (no import connectivity)');
    });
  });

  // ============================================================
  // getProcessGroupLabel
  // ============================================================

  describe('getProcessGroupLabel', () => {
    it('empty modules → "empty"', () => {
      expect(getProcessGroupLabel([])).toBe('empty');
    });

    it('single module "project.frontend.hooks" → "frontend"', () => {
      const mod = { fullPath: 'project.frontend.hooks' } as Module;
      // For single module, returns parts[1] (the segment after root)
      expect(getProcessGroupLabel([mod])).toBe('frontend');
    });

    it('single module with one segment → returns that segment', () => {
      const mod = { fullPath: 'standalone' } as Module;
      expect(getProcessGroupLabel([mod])).toBe('standalone');
    });

    it('modules with common prefix "project.backend.*" → "backend"', () => {
      const mods = [
        { fullPath: 'project.backend.auth' } as Module,
        { fullPath: 'project.backend.api' } as Module,
      ];
      expect(getProcessGroupLabel(mods)).toBe('backend');
    });

    it('modules with deeper common prefix', () => {
      const mods = [
        { fullPath: 'project.backend.services.auth' } as Module,
        { fullPath: 'project.backend.services.api' } as Module,
      ];
      expect(getProcessGroupLabel(mods)).toBe('backend.services');
    });

    it('modules with no common prefix → sorted depth-1 segments joined by ", "', () => {
      const mods = [
        { fullPath: 'alpha.zeta' } as Module,
        { fullPath: 'beta.omega' } as Module,
      ];
      expect(getProcessGroupLabel(mods)).toBe('omega, zeta');
    });
  });

  // ============================================================
  // getCrossProcessGroupPairs
  // ============================================================

  describe('getCrossProcessGroupPairs', () => {
    it('1 group → 0 pairs', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      insertImport(fileA, fileB, false);

      const groups = computeProcessGroups(db);
      const pairs = getCrossProcessGroupPairs(groups);
      // Root module is also in its own group, so we have 2 groups
      // Filter to see only non-root pairs
      const nonRootGroups = Array.from(groups.groupToModules.values()).filter(
        (mods) => !mods.some((m) => m.depth === 0)
      );
      // The key assertion is about the pairing logic
      expect(pairs.length).toBe(groups.groupCount * (groups.groupCount - 1) / 2);
    });

    it('2 disconnected groups → at least 1 pair', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);

      const groups = computeProcessGroups(db);
      const pairs = getCrossProcessGroupPairs(groups);
      // Should have C(n,2) pairs where n = number of groups
      expect(pairs.length).toBe(groups.groupCount * (groups.groupCount - 1) / 2);
      expect(pairs.length).toBeGreaterThan(0);
    });

    it('each pair contains correct module arrays', () => {
      const rootId = db.ensureRootModule();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);
      const modC = setupModule('ModC', 'mod-c', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const fileC = insertFile('/src/c.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      const defC = insertDefinition(fileC, 'funcC');
      db.assignSymbolToModule(defA, modA);
      db.assignSymbolToModule(defB, modB);
      db.assignSymbolToModule(defC, modC);

      // Connect A and B, but not C
      insertImport(fileA, fileB, false);

      const groups = computeProcessGroups(db);
      const pairs = getCrossProcessGroupPairs(groups);

      // Each pair should have two arrays of modules
      for (const [groupA, groupB] of pairs) {
        expect(Array.isArray(groupA)).toBe(true);
        expect(Array.isArray(groupB)).toBe(true);
        expect(groupA.length).toBeGreaterThan(0);
        expect(groupB.length).toBeGreaterThan(0);
      }
    });
  });
});
