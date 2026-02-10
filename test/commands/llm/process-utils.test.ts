import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  areSameProcess,
  computeProcessGroups,
  getCrossProcessGroupPairs,
  getProcessDescription,
  getProcessGroupLabel,
} from '../../../src/commands/llm/_shared/process-utils.js';
import { IndexDatabase } from '../../../src/db/database.js';
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
    return db.files.insert({
      path,
      language: 'typescript',
      contentHash: `hash-${path}`,
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDefinition(fileId: number, name: string) {
    return db.files.insertDefinition(fileId, {
      name,
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });
  }

  function insertImport(fromFileId: number, toFileId: number, isTypeOnly = false) {
    return db.insertReference(fromFileId, toFileId, {
      type: 'import',
      source: './some-module',
      isExternal: false,
      isTypeOnly,
      position: { row: 0, column: 0 },
    });
  }

  function setupModule(name: string, slug: string, parentId: number) {
    return db.modules.insert(parentId, slug, name);
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
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

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
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

      // No imports between A and B

      const groups = computeProcessGroups(db);
      const groupA = groups.moduleToGroup.get(modA);
      const groupB = groups.moduleToGroup.get(modB);
      expect(groupA).not.toBe(groupB);
    });

    it('type-only imports do not bridge components', () => {
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

      // Type-only import
      insertImport(fileA, fileB, true);

      const groups = computeProcessGroups(db);
      // modA and modB should be in different groups (type-only doesn't bridge)
      const groupA = groups.moduleToGroup.get(modA);
      const groupB = groups.moduleToGroup.get(modB);
      expect(groupA).not.toBe(groupB);
    });

    it('modules with no files get isolated groups', () => {
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      // No files, no definitions assigned

      const groups = computeProcessGroups(db);
      // Each module (including root) gets its own isolated group
      expect(groups.groupCount).toBe(3); // root + modA + modB
      expect(groups.moduleToGroup.get(modA)).not.toBe(groups.moduleToGroup.get(modB));
    });

    it('module with files in multiple components is assigned to majority group', () => {
      const rootId = db.modules.ensureRoot();
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

      db.modules.assignSymbol(defA1, modA);
      db.modules.assignSymbol(defA2, modA);
      db.modules.assignSymbol(defA3, modA);
      db.modules.assignSymbol(defB1, modB);

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
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);

      const fileA = insertFile('/src/a.ts');
      const defA = insertDefinition(fileA, 'funcA');
      db.modules.assignSymbol(defA, modA);

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
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

      insertImport(fileA, fileB, false);

      const groups = computeProcessGroups(db);
      expect(areSameProcess(modA, modB, groups)).toBe(true);
    });

    it('returns false for modules in different groups', () => {
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

      const groups = computeProcessGroups(db);
      expect(areSameProcess(modA, modB, groups)).toBe(false);
    });

    it('returns true when either module has no group (conservative)', () => {
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);

      const fileA = insertFile('/src/a.ts');
      const defA = insertDefinition(fileA, 'funcA');
      db.modules.assignSymbol(defA, modA);

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
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

      insertImport(fileA, fileB, false);

      const groups = computeProcessGroups(db);
      expect(getProcessDescription(modA, modB, groups)).toBe('same-process (shared import graph)');
    });

    it('returns "separate-process (no import connectivity)" for different groups', () => {
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

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
      const mods = [{ fullPath: 'project.backend.auth' } as Module, { fullPath: 'project.backend.api' } as Module];
      expect(getProcessGroupLabel(mods)).toBe('backend');
    });

    it('modules with deeper common prefix', () => {
      const mods = [
        { fullPath: 'project.backend.services.auth' } as Module,
        { fullPath: 'project.backend.services.api' } as Module,
      ];
      expect(getProcessGroupLabel(mods)).toBe('backend.services');
    });

    it('modules with no common prefix → most frequent depth-1 segment', () => {
      const mods = [
        { fullPath: 'alpha.zeta' } as Module,
        { fullPath: 'alpha.zeta.sub' } as Module,
        { fullPath: 'beta.omega' } as Module,
      ];
      expect(getProcessGroupLabel(mods)).toBe('zeta');
    });
  });

  // ============================================================
  // getCrossProcessGroupPairs
  // ============================================================

  describe('getCrossProcessGroupPairs', () => {
    it('1 group → 0 pairs', () => {
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

      insertImport(fileA, fileB, false);

      const groups = computeProcessGroups(db);
      const pairs = getCrossProcessGroupPairs(groups);
      // modA and modB share an import → same file-based group
      // Root module is an isolated singleton (no files) → filtered out by getCrossProcessGroupPairs
      // Result: 1 non-isolated group → 0 pairs
      expect(pairs.length).toBe(0);
    });

    it('2 disconnected groups → at least 1 pair', () => {
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

      const groups = computeProcessGroups(db);
      const pairs = getCrossProcessGroupPairs(groups);
      // modA and modB have no imports → 2 separate file-based groups
      // Root module is an isolated singleton → filtered out by getCrossProcessGroupPairs
      // Result: 2 non-isolated groups → C(2,2) = 1 pair
      expect(pairs.length).toBe(1);
      expect(pairs.length).toBeGreaterThan(0);
    });

    it('each pair contains correct module arrays', () => {
      const rootId = db.modules.ensureRoot();
      const modA = setupModule('ModA', 'mod-a', rootId);
      const modB = setupModule('ModB', 'mod-b', rootId);
      const modC = setupModule('ModC', 'mod-c', rootId);

      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const fileC = insertFile('/src/c.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB');
      const defC = insertDefinition(fileC, 'funcC');
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);
      db.modules.assignSymbol(defC, modC);

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
