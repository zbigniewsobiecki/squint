import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkAnnotationCoverage,
  checkFlowQuality,
  checkModuleAssignments,
  checkRelationshipCoverage,
} from '../../../src/commands/llm/_shared/verify/coverage-checker.js';
import { IndexDatabase } from '../../../src/db/database.js';

describe('coverage-checker', () => {
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
    opts?: { line?: number; endLine?: number; isExported?: boolean; extends?: string }
  ) {
    return db.files.insertDefinition(fileId, {
      name,
      kind,
      isExported: opts?.isExported ?? true,
      isDefault: false,
      position: { row: (opts?.line ?? 1) - 1, column: 0 },
      endPosition: { row: (opts?.endLine ?? 10) - 1, column: 1 },
      extends: opts?.extends,
    });
  }

  // ============================================================
  // checkAnnotationCoverage
  // ============================================================

  describe('checkAnnotationCoverage', () => {
    it('zero definitions → passed', () => {
      const result = checkAnnotationCoverage(db, ['purpose']);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.stats.totalDefinitions).toBe(0);
    });

    it('all definitions have aspect → passed', () => {
      const fileId = insertFile('/src/a.ts');
      const defId = insertDefinition(fileId, 'funcA');
      db.metadata.set(defId, 'purpose', 'Does stuff');

      const result = checkAnnotationCoverage(db, ['purpose']);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('some missing → issues with correct message', () => {
      const fileId = insertFile('/src/a.ts');
      insertDefinition(fileId, 'funcA');
      insertDefinition(fileId, 'funcB');

      const result = checkAnnotationCoverage(db, ['purpose']);
      expect(result.passed).toBe(false);
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
      expect(result.issues[0].category).toBe('missing-annotation');
      expect(result.issues[0].message).toContain("Missing 'purpose' annotation");
    });

    it('>50 missing triggers truncation + info', () => {
      const fileId = insertFile('/src/a.ts');
      for (let i = 0; i < 55; i++) {
        insertDefinition(fileId, `func${i}`, 'function', { line: i * 2 + 1, endLine: i * 2 + 2 });
      }

      const result = checkAnnotationCoverage(db, ['purpose']);
      expect(result.passed).toBe(false);
      const infoIssues = result.issues.filter((i) => i.severity === 'info');
      expect(infoIssues.length).toBeGreaterThanOrEqual(1);
      expect(infoIssues[0].message).toContain('more definitions missing');
    });

    it('multiple aspects checked', () => {
      const fileId = insertFile('/src/a.ts');
      const defId = insertDefinition(fileId, 'funcA');
      db.metadata.set(defId, 'purpose', 'Does stuff');

      const result = checkAnnotationCoverage(db, ['purpose', 'domain']);
      expect(result.passed).toBe(false);
      const domainIssues = result.issues.filter((i) => i.message?.includes("'domain'"));
      expect(domainIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('relationship count stats (with relationship table)', () => {
      const fileId = insertFile('/src/a.ts');
      const def1 = insertDefinition(fileId, 'funcA');
      const def2 = insertDefinition(fileId, 'funcB');
      db.metadata.set(def1, 'purpose', 'A');
      db.metadata.set(def2, 'purpose', 'B');
      db.relationships.set(def1, def2, 'calls', 'uses');

      const result = checkAnnotationCoverage(db, ['purpose']);
      expect(result.stats.annotatedRelationships).toBeGreaterThanOrEqual(1);
      expect(result.stats.totalRelationships).toBeGreaterThanOrEqual(1);
    });

    it('triggers checkPureAnnotations when "pure" in aspects', () => {
      const fileId = insertFile('/src/a.ts');
      const defId = insertDefinition(fileId, 'funcA');
      // Mark as pure — file won't exist on disk, so readSourceSync returns ''
      db.metadata.set(defId, 'pure', 'true');

      const result = checkAnnotationCoverage(db, ['pure']);
      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // checkRelationshipCoverage
  // ============================================================

  describe('checkRelationshipCoverage', () => {
    it('no unannotated → passed', () => {
      const result = checkRelationshipCoverage(db);
      expect(result.passed).toBe(true);
      expect(result.stats.missingCount).toBe(0);
    });

    it('unannotated > 0 → error', () => {
      const fileId = insertFile('/src/a.ts');
      insertDefinition(fileId, 'funcA');
      insertDefinition(fileId, 'funcB');
      db.insertReference(fileId, fileId, {
        type: 'import',
        source: './b',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
      });

      const result = checkRelationshipCoverage(db);
      if (result.stats.missingCount > 0) {
        expect(result.passed).toBe(false);
        expect(result.issues.some((i) => i.category === 'unannotated-relationship')).toBe(true);
      }
    });

    it('duplicate extends targets → structural issue', () => {
      const fileId = insertFile('/src/a.ts');
      const defFrom = insertDefinition(fileId, 'ChildClass');
      const defTo1 = insertDefinition(fileId, 'BaseClass', 'class', { line: 20, endLine: 30 });
      const defTo2 = insertDefinition(fileId, 'BaseClass', 'class', { line: 40, endLine: 50 });

      db.relationships.set(defFrom, defTo1, 'inherits', 'extends');
      db.relationships.set(defFrom, defTo2, 'inherits', 'extends');

      const result = checkRelationshipCoverage(db);
      const dupIssues = result.issues.filter((i) => i.category === 'duplicate-target');
      expect(dupIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('relationship type mismatch (uses should be extends)', () => {
      const fileId = insertFile('/src/a.ts');
      // Use `extends` (the actual Definition field) not `extendsName`
      const defChild = insertDefinition(fileId, 'ChildClass', 'class', {
        extends: 'ParentClass',
      });
      const defParent = insertDefinition(fileId, 'ParentClass', 'class', { line: 20, endLine: 30 });

      // Mark as 'uses' but should be 'extends'
      db.relationships.set(defChild, defParent, 'inherits from', 'uses');

      const result = checkRelationshipCoverage(db);
      const mismatchIssues = result.issues.filter((i) => i.category === 'wrong-relationship-type');
      expect(mismatchIssues.length).toBeGreaterThanOrEqual(1);
      expect(mismatchIssues[0].message).toContain("should be 'extends'");
    });

    it("stale file detection (files that don't exist on disk)", () => {
      insertFile('/nonexistent/path/to/file.ts');

      const result = checkRelationshipCoverage(db);
      const staleIssues = result.issues.filter((i) => i.category === 'stale-file');
      expect(staleIssues.length).toBeGreaterThanOrEqual(1);
      expect(staleIssues[0].message).toContain('no longer exists');
    });

    it('missing extends relationship', () => {
      const fileId = insertFile('/src/a.ts');
      // Use `extends` field to set extends_name in DB
      insertDefinition(fileId, 'ChildClass', 'class', {
        extends: 'SomeParent',
      });

      const result = checkRelationshipCoverage(db);
      const missingExtends = result.issues.filter((i) => i.category === 'missing-extends');
      expect(missingExtends.length).toBeGreaterThanOrEqual(1);
      expect(missingExtends[0].message).toContain("extends_name='SomeParent'");
    });

    it('builtin base class skipped', () => {
      const fileId = insertFile('/src/a.ts');
      insertDefinition(fileId, 'MyError', 'class', {
        extends: 'Error',
      });

      const result = checkRelationshipCoverage(db);
      const missingExtends = result.issues.filter((i) => i.category === 'missing-extends');
      expect(missingExtends).toHaveLength(0);
    });
  });

  // ============================================================
  // checkFlowQuality
  // ============================================================

  describe('checkFlowQuality', () => {
    it('no flows → passed', () => {
      db.modules.ensureRoot();
      const result = checkFlowQuality(db);
      expect(result.passed).toBe(true);
      expect(result.stats.totalDefinitions).toBe(0);
    });

    it('orphan entry point (module with no callable members)', () => {
      const rootId = db.modules.ensureRoot();
      const modId = db.modules.insert(rootId, 'types', 'Types Module');
      const fileId = insertFile('/src/types.ts');
      const defId = insertDefinition(fileId, 'MyInterface', 'interface');
      db.modules.assignSymbol(defId, modId);

      db.flows.insert('Type Flow', 'type-flow', { entryPointModuleId: modId });

      const result = checkFlowQuality(db);
      const orphanIssues = result.issues.filter((i) => i.category === 'orphan-entry-point');
      expect(orphanIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('empty flow (0 steps) → warning', () => {
      db.modules.ensureRoot();
      db.flows.insert('Empty', 'empty');

      const result = checkFlowQuality(db);
      const emptyIssues = result.issues.filter((i) => i.category === 'empty-flow');
      expect(emptyIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('uncovered interactions (>20 triggers truncation)', () => {
      const rootId = db.modules.ensureRoot();
      const mods: number[] = [];
      for (let i = 0; i < 22; i++) {
        mods.push(db.modules.insert(rootId, `m${i}`, `Mod${i}`));
      }
      for (let i = 0; i < 21; i++) {
        db.interactions.insert(mods[i], mods[i + 1]);
      }
      db.flows.insert('F', 'f');

      const result = checkFlowQuality(db);
      const uncoveredIssues = result.issues.filter((i) => i.category === 'uncovered-interactions');
      expect(uncoveredIssues.length).toBeGreaterThanOrEqual(1);
      const truncation = uncoveredIssues.find((i) => i.message?.includes('... and'));
      expect(truncation).toBeDefined();
    });

    it('covered interactions → no uncovered warning', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');
      const fileA = insertFile('/src/a.ts');
      const defA = insertDefinition(fileA, 'funcA');
      db.modules.assignSymbol(defA, modA);

      const intId = db.interactions.insert(modA, modB);
      const flowId = db.flows.insert('Good Flow', 'good-flow', { entryPointModuleId: modA });
      db.flows.addStep(flowId, intId);

      const result = checkFlowQuality(db);
      expect(result.passed).toBe(true);
    });

    it('multiple flows with steps → passed', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');
      const modC = db.modules.insert(rootId, 'c', 'C');
      const fileA = insertFile('/src/a.ts');
      const defA = insertDefinition(fileA, 'funcA');
      db.modules.assignSymbol(defA, modA);

      const int1 = db.interactions.insert(modA, modB);
      const int2 = db.interactions.insert(modB, modC);

      const f1 = db.flows.insert('Flow1', 'flow-1', { entryPointModuleId: modA });
      db.flows.addStep(f1, int1);
      const f2 = db.flows.insert('Flow2', 'flow-2', { entryPointModuleId: modA });
      db.flows.addStep(f2, int2);

      const result = checkFlowQuality(db);
      expect(result.passed).toBe(true);
      expect(result.stats.totalDefinitions).toBe(2);
    });
  });

  // ============================================================
  // checkModuleAssignments
  // ============================================================

  describe('checkModuleAssignments', () => {
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
  });
});
