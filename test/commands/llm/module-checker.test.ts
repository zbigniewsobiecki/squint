import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkModuleAssignments } from '../../../src/commands/llm/_shared/verify/module-checker.js';
import { IndexDatabase } from '../../../src/db/database.js';

describe('checkModuleAssignments', () => {
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

  it('no modules → passed with early return', () => {
    const result = checkModuleAssignments(db);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('test file symbol in production module → warning', () => {
    const rootId = db.modules.ensureRoot();
    const prodModule = db.modules.insert(rootId, 'prod', 'Production');
    const fileId = insertFile('/src/utils.test.ts');
    const defId = insertDefinition(fileId, 'testHelper');
    db.modules.assignSymbol(defId, prodModule);

    const result = checkModuleAssignments(db);
    const testInProd = result.issues.filter((i) => i.category === 'test-in-production');
    expect(testInProd.length).toBeGreaterThanOrEqual(1);
    expect(testInProd[0].message).toContain('test file assigned to production module');
  });

  it('non-exported test symbol in shared multi-file module → info', () => {
    const rootId = db.modules.ensureRoot();
    const sharedModule = db.modules.insert(rootId, 'shared', 'Shared');

    const fileA = insertFile('/src/a.ts');
    const fileB = insertFile('/src/b.test.ts');
    const defA = insertDefinition(fileA, 'prodFunc');
    const defB = insertDefinition(fileB, 'testHelper', 'function', { isExported: false });
    db.modules.assignSymbol(defA, sharedModule);
    db.modules.assignSymbol(defB, sharedModule);

    const result = checkModuleAssignments(db);
    const nonExported = result.issues.filter((i) => i.category === 'non-exported-in-shared');
    expect(nonExported.length).toBeGreaterThanOrEqual(1);
  });

  it('clean state → passed', () => {
    const rootId = db.modules.ensureRoot();
    const modId = db.modules.insert(rootId, 'clean', 'Clean Module');
    const fileId = insertFile('/src/clean.ts');
    const defId = insertDefinition(fileId, 'cleanFunc');
    db.modules.assignSymbol(defId, modId);

    const result = checkModuleAssignments(db);
    expect(result.passed).toBe(true);
  });

  it('single-file module skips shared-module check', () => {
    const rootId = db.modules.ensureRoot();
    const modId = db.modules.insert(rootId, 'single', 'Single');
    const fileId = insertFile('/src/a.test.ts');
    const defId = insertDefinition(fileId, 'testOnly', 'function', { isExported: false });
    db.modules.assignSymbol(defId, modId);

    const result = checkModuleAssignments(db);
    const nonExported = result.issues.filter((i) => i.category === 'non-exported-in-shared');
    expect(nonExported).toHaveLength(0);
  });

  it('unassigned definitions reported as info', () => {
    const rootId = db.modules.ensureRoot();
    db.modules.insert(rootId, 'mod', 'Mod');
    const fileId = insertFile('/src/a.ts');
    insertDefinition(fileId, 'unassignedFunc');

    const result = checkModuleAssignments(db);
    const unassigned = result.issues.filter((i) => i.category === 'unassigned-definition');
    expect(unassigned.length).toBeGreaterThanOrEqual(1);
    expect(unassigned[0].severity).toBe('info');
  });

  it('all assigned → no unassigned issues', () => {
    const rootId = db.modules.ensureRoot();
    const modId = db.modules.insert(rootId, 'mod', 'Mod');
    const fileId = insertFile('/src/a.ts');
    const defId = insertDefinition(fileId, 'assignedFunc');
    db.modules.assignSymbol(defId, modId);

    const result = checkModuleAssignments(db);
    const unassigned = result.issues.filter((i) => i.category === 'unassigned-definition');
    expect(unassigned).toHaveLength(0);
  });
});
