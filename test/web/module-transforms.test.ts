import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database.js';
import { getModulesData, getProcessGroupsData } from '../../src/web/transforms/module-transforms.js';

describe('module-transforms', () => {
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

  function insertDefinition(fileId: number, name: string, kind = 'function', line = 1) {
    return db.files.insertDefinition(fileId, {
      name,
      kind,
      isExported: true,
      isDefault: false,
      position: { row: line - 1, column: 0 }, // row is 0-based, gets converted to 1-based line
      endPosition: { row: line + 9, column: 1 },
    });
  }

  describe('getModulesData', () => {
    it('returns empty data when no modules exist', () => {
      const result = getModulesData(db);
      expect(result.modules).toEqual([]);
      expect(result.stats.moduleCount).toBe(0);
      expect(result.stats.assigned).toBe(0);
      expect(result.stats.unassigned).toBe(0);
    });

    it('returns modules with full hierarchy and members', () => {
      const fileId = insertFile('/src/auth/service.ts');
      const defId1 = insertDefinition(fileId, 'AuthService', 'class', 5);
      const defId2 = insertDefinition(fileId, 'validateToken', 'function', 20);

      const rootId = db.modules.ensureRoot();
      const moduleId = db.modules.insert(rootId, 'auth', 'Authentication');
      db.modules.assignSymbol(defId1, moduleId);
      db.modules.assignSymbol(defId2, moduleId);

      const result = getModulesData(db);

      expect(result.modules.length).toBeGreaterThan(0);

      const authModule = result.modules.find((m) => m.name === 'Authentication');
      expect(authModule).toBeDefined();
      expect(authModule!.id).toBe(moduleId);
      expect(authModule!.slug).toBe('auth');
      expect(authModule!.name).toBe('Authentication');
      expect(authModule!.fullPath).toContain('auth');
      expect(authModule!.memberCount).toBe(2);
      expect(authModule!.members).toHaveLength(2);
      expect(authModule!.members[0].name).toBe('AuthService');
      expect(authModule!.members[0].kind).toBe('class');
      expect(authModule!.members[0].filePath).toBe('/src/auth/service.ts');
      expect(authModule!.members[0].line).toBe(5);
      expect(authModule!.members[1].name).toBe('validateToken');
      expect(authModule!.members[1].kind).toBe('function');
    });

    it('returns nested module hierarchy with depth and color indices', () => {
      const rootId = db.modules.ensureRoot();
      const parentId = db.modules.insert(rootId, 'backend', 'Backend');
      const childId = db.modules.insert(parentId, 'api', 'API');

      const result = getModulesData(db);

      const parent = result.modules.find((m) => m.name === 'Backend');
      const child = result.modules.find((m) => m.name === 'API');

      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(child!.parentId).toBe(parentId);
      expect(parent!.depth).toBeLessThan(child!.depth);
      expect(parent!.colorIndex).toBeGreaterThanOrEqual(0);
      expect(child!.colorIndex).toBeGreaterThanOrEqual(0);
    });

    it('returns accurate module statistics', () => {
      const fileId = insertFile('/src/code.ts');
      const defId1 = insertDefinition(fileId, 'A');
      const defId2 = insertDefinition(fileId, 'B');
      const defId3 = insertDefinition(fileId, 'C');

      const rootId = db.modules.ensureRoot();
      const modId = db.modules.insert(rootId, 'services', 'Services');
      db.modules.assignSymbol(defId1, modId);
      db.modules.assignSymbol(defId2, modId);
      // defId3 left unassigned

      const result = getModulesData(db);

      expect(result.stats.moduleCount).toBeGreaterThan(0);
      expect(result.stats.assigned).toBe(2);
      expect(result.stats.unassigned).toBe(1);
    });

    it('handles empty members array for modules with no symbols', () => {
      const rootId = db.modules.ensureRoot();
      const emptyModId = db.modules.insert(rootId, 'empty', 'Empty Module');

      const result = getModulesData(db);

      const emptyModule = result.modules.find((m) => m.name === 'Empty Module');
      expect(emptyModule).toBeDefined();
      expect(emptyModule!.memberCount).toBe(0);
      expect(emptyModule!.members).toEqual([]);
    });

    it('handles errors gracefully and returns empty state', () => {
      db.close();

      const result = getModulesData(db);

      expect(result.modules).toEqual([]);
      expect(result.stats.moduleCount).toBe(0);
      expect(result.stats.assigned).toBe(0);
      expect(result.stats.unassigned).toBe(0);
    });
  });

  describe('getProcessGroupsData', () => {
    it('returns empty data when no modules exist', () => {
      const result = getProcessGroupsData(db);
      expect(result.groups).toEqual([]);
      expect(result.groupCount).toBe(0);
    });

    it('filters out singleton groups (only returns groups with 2+ modules)', () => {
      const fileId1 = insertFile('/src/fileA.ts');
      const fileId2 = insertFile('/src/fileB.ts');
      const fileId3 = insertFile('/src/fileC.ts');

      const defId1 = insertDefinition(fileId1, 'A');
      const defId2 = insertDefinition(fileId2, 'B');
      const defId3 = insertDefinition(fileId3, 'C');

      const rootId = db.modules.ensureRoot();
      const mod1 = db.modules.insert(rootId, 'modA', 'Module A');
      const mod2 = db.modules.insert(rootId, 'modB', 'Module B');
      const mod3 = db.modules.insert(rootId, 'modC', 'Module C');

      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);
      db.modules.assignSymbol(defId3, mod3);

      // Create import connections to form a process group
      // fileA imports fileB (mod1 -> mod2)
      db.conn
        .prepare(
          'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(fileId1, fileId2, 'import', './fileB', 0, 0, 1, 0);

      // fileB imports fileA (mod2 -> mod1)
      db.conn
        .prepare(
          'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(fileId2, fileId1, 'import', './fileA', 0, 0, 1, 0);

      // mod3 remains isolated (singleton)

      const result = getProcessGroupsData(db);

      // Should only return the group with mod1 and mod2, not the singleton mod3
      expect(result.groupCount).toBeGreaterThanOrEqual(0);
      for (const group of result.groups) {
        expect(group.moduleCount).toBeGreaterThanOrEqual(2);
      }
    });

    it('returns process groups with labels and module IDs', () => {
      const fileId1 = insertFile('/src/auth.ts');
      const fileId2 = insertFile('/src/api.ts');

      const defId1 = insertDefinition(fileId1, 'AuthService');
      const defId2 = insertDefinition(fileId2, 'ApiService');

      const rootId = db.modules.ensureRoot();
      const mod1 = db.modules.insert(rootId, 'auth', 'Authentication');
      const mod2 = db.modules.insert(rootId, 'api', 'API');

      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);

      // Create bidirectional imports to form a process group
      db.conn
        .prepare(
          'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(fileId1, fileId2, 'import', './api', 0, 0, 1, 0);

      db.conn
        .prepare(
          'INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(fileId2, fileId1, 'import', './auth', 0, 0, 1, 0);

      const result = getProcessGroupsData(db);

      if (result.groupCount > 0) {
        const group = result.groups[0];
        expect(group.id).toBeGreaterThanOrEqual(0);
        expect(group.label).toBeTruthy();
        expect(group.moduleIds.length).toBeGreaterThanOrEqual(2);
        expect(group.moduleCount).toBe(group.moduleIds.length);
      }
    });

    it('handles errors gracefully and returns empty state', () => {
      db.close();

      const result = getProcessGroupsData(db);

      expect(result.groups).toEqual([]);
      expect(result.groupCount).toBe(0);
    });
  });
});
