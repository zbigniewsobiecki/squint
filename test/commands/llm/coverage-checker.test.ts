import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkAnnotationCoverage,
  checkFlowQuality,
  checkInteractionQuality,
  checkModuleAssignments,
  checkReferentialIntegrity,
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

    it('missing implements detected', () => {
      const fileId = insertFile('/src/a.ts');
      insertDefinition(fileId, 'MyClass', 'class', {
        implements: ['CustomInterface'],
      });

      const result = checkRelationshipCoverage(db);
      const missingImpl = result.issues.filter((i) => i.category === 'missing-implements');
      expect(missingImpl.length).toBeGreaterThanOrEqual(1);
      expect(missingImpl[0].message).toContain("implements 'CustomInterface'");
    });

    it('builtin interface skipped for missing-implements', () => {
      const fileId = insertFile('/src/a.ts');
      insertDefinition(fileId, 'MyClass', 'class', {
        implements: ['Iterable', 'Iterator', 'PromiseLike'],
      });

      const result = checkRelationshipCoverage(db);
      const missingImpl = result.issues.filter((i) => i.category === 'missing-implements');
      expect(missingImpl).toHaveLength(0);
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

    it('broken chain: disconnected steps detected', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');
      const modC = db.modules.insert(rootId, 'c', 'C');
      const modD = db.modules.insert(rootId, 'd', 'D');

      // A→B then C→D (no connection between B and C/D)
      const int1 = db.interactions.insert(modA, modB);
      const int2 = db.interactions.insert(modC, modD);

      const flowId = db.flows.insert('Broken Flow', 'broken-flow');
      db.flows.addStep(flowId, int1);
      db.flows.addStep(flowId, int2);

      const result = checkFlowQuality(db);
      const brokenChain = result.issues.filter((i) => i.category === 'broken-chain');
      expect(brokenChain.length).toBeGreaterThanOrEqual(1);
    });

    it('connected chain: no broken-chain issue', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');
      const modC = db.modules.insert(rootId, 'c', 'C');

      // A→B then B→C (connected)
      const int1 = db.interactions.insert(modA, modB);
      const int2 = db.interactions.insert(modB, modC);

      const flowId = db.flows.insert('Connected Flow', 'connected-flow');
      db.flows.addStep(flowId, int1);
      db.flows.addStep(flowId, int2);

      const result = checkFlowQuality(db);
      const brokenChain = result.issues.filter((i) => i.category === 'broken-chain');
      expect(brokenChain).toHaveLength(0);
    });

    it('entry mismatch: entry module != first step from_module', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');
      const modC = db.modules.insert(rootId, 'c', 'C');

      const int1 = db.interactions.insert(modB, modC);

      // Entry point is modA but first step starts from modB
      const flowId = db.flows.insert('Mismatch Flow', 'mismatch-flow', { entryPointModuleId: modA });
      db.flows.addStep(flowId, int1);

      const result = checkFlowQuality(db);
      const mismatch = result.issues.filter((i) => i.category === 'entry-mismatch');
      expect(mismatch.length).toBeGreaterThanOrEqual(1);
    });

    it('entry not in module: entry_point_id not member of entry module', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');
      const fileA = insertFile('/src/a.ts');
      const fileB = insertFile('/src/b.ts');
      const defA = insertDefinition(fileA, 'funcA');
      const defB = insertDefinition(fileB, 'funcB', 'function', { line: 1 });
      db.modules.assignSymbol(defA, modA);
      db.modules.assignSymbol(defB, modB);

      // Flow's entry point is defB but entry module is modA (defB is not in modA)
      db.flows.insert('Wrong Entry', 'wrong-entry', {
        entryPointModuleId: modA,
        entryPointId: defB,
      });

      const result = checkFlowQuality(db);
      const entryNotInModule = result.issues.filter((i) => i.category === 'entry-not-in-module');
      expect(entryNotInModule.length).toBeGreaterThanOrEqual(1);
      expect(entryNotInModule[0].fixData?.action).toBe('null-entry-point');
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

  // ============================================================
  // checkReferentialIntegrity
  // ============================================================

  describe('checkReferentialIntegrity', () => {
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

  // ============================================================
  // checkInteractionQuality
  // ============================================================

  describe('checkInteractionQuality', () => {
    it('no interactions → passes', () => {
      const result = checkInteractionQuality(db);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('self-loop detected and fixable', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      db.interactions.insert(modA, modA);

      const result = checkInteractionQuality(db);
      const selfLoops = result.issues.filter((i) => i.category === 'self-loop-interaction');
      expect(selfLoops.length).toBeGreaterThanOrEqual(1);
      expect(selfLoops[0].fixData?.action).toBe('remove-interaction');
      expect(result.passed).toBe(false);
    });

    it('false bidirectional detected when no reverse call edge', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');

      // Create a bidirectional interaction but no reverse call graph edge exists
      db.interactions.insert(modA, modB, { direction: 'bi' });

      const result = checkInteractionQuality(db);
      const falseBidi = result.issues.filter((i) => i.category === 'false-bidirectional');
      expect(falseBidi.length).toBeGreaterThanOrEqual(1);
      expect(falseBidi[0].fixData?.action).toBe('set-direction-uni');
    });

    it('ungrounded inferred detected when no import and no call edge', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');

      // Create an inferred interaction with no static evidence
      db.interactions.insert(modA, modB, { source: 'llm-inferred' });

      const result = checkInteractionQuality(db);
      const ungrounded = result.issues.filter((i) => i.category === 'ungrounded-inferred');
      expect(ungrounded.length).toBeGreaterThanOrEqual(1);
      expect(ungrounded[0].fixData?.action).toBe('remove-interaction');
    });

    it('symbol mismatch detected when symbols list has wrong names', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');

      // Assign a member to modB
      const fileB = insertFile('/src/b.ts');
      const defB = insertDefinition(fileB, 'realFunc');
      db.modules.assignSymbol(defB, modB);

      // Create interaction with wrong symbol names
      db.interactions.insert(modA, modB, { symbols: ['nonExistentFunc', 'anotherFake'] });

      const result = checkInteractionQuality(db);
      const mismatch = result.issues.filter((i) => i.category === 'interaction-symbol-mismatch');
      expect(mismatch.length).toBeGreaterThanOrEqual(1);
      expect(mismatch[0].fixData?.action).toBe('rebuild-symbols');
    });

    it('clean interactions → passes', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');

      // Create a simple clean interaction
      db.interactions.insert(modA, modB);

      const result = checkInteractionQuality(db);
      expect(result.passed).toBe(true);
      const selfLoops = result.issues.filter((i) => i.category === 'self-loop-interaction');
      expect(selfLoops).toHaveLength(0);
    });

    it('no-import-path detected for AST interaction', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');

      // Create AST interaction between modules with no import path
      db.interactions.insert(modA, modB, { source: 'ast' });

      const result = checkInteractionQuality(db);
      const noImport = result.issues.filter((i) => i.category === 'no-import-path');
      expect(noImport.length).toBeGreaterThanOrEqual(1);
    });

    it('skips ungrounded-inferred check for cross-process interactions', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');

      // Create an inferred interaction with no static evidence
      db.interactions.insert(modA, modB, { source: 'llm-inferred' });

      // Create processGroups where modA and modB are in different groups
      const processGroups = {
        moduleToGroup: new Map([
          [modA, 1],
          [modB, 2],
        ]),
        groupToModules: new Map(),
        groupCount: 2,
      };

      const result = checkInteractionQuality(db, processGroups as any);
      const ungrounded = result.issues.filter((i) => i.category === 'ungrounded-inferred');
      expect(ungrounded).toHaveLength(0);
    });

    it('still flags ungrounded-inferred for same-process interactions', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');

      // Create an inferred interaction with no static evidence
      db.interactions.insert(modA, modB, { source: 'llm-inferred' });

      // Create processGroups where both are in the same group
      const processGroups = {
        moduleToGroup: new Map([
          [modA, 1],
          [modB, 1],
        ]),
        groupToModules: new Map(),
        groupCount: 1,
      };

      const result = checkInteractionQuality(db, processGroups as any);
      const ungrounded = result.issues.filter((i) => i.category === 'ungrounded-inferred');
      expect(ungrounded.length).toBeGreaterThanOrEqual(1);
    });

    it('detects direction-implausible when AST edges only flow in reverse', () => {
      const rootId = db.modules.ensureRoot();
      const modA = db.modules.insert(rootId, 'a', 'A');
      const modB = db.modules.insert(rootId, 'b', 'B');
      const modC = db.modules.insert(rootId, 'c', 'C');

      // AST interaction flows B→A (reverse direction)
      db.interactions.insert(modB, modA, { source: 'ast' });
      // LLM-inferred goes A→B (forward, against AST flow)
      db.interactions.insert(modA, modC, { source: 'llm-inferred' });
      db.interactions.insert(modA, modB, { source: 'llm-inferred' });

      // Process groups: modA in group 1, modB in group 2
      const processGroups = {
        moduleToGroup: new Map([
          [modA, 1],
          [modB, 2],
          [modC, 1],
        ]),
        groupToModules: new Map(),
        groupCount: 2,
      };

      const result = checkInteractionQuality(db, processGroups as any);
      const directionIssues = result.issues.filter((i) => i.category === 'direction-implausible');
      expect(directionIssues.length).toBeGreaterThanOrEqual(1);
      expect(directionIssues[0].fixData?.action).toBe('remove-interaction');
    });

    it('fan-in-anomaly detected for high llm fan-in with zero AST fan-in', () => {
      const rootId = db.modules.ensureRoot();
      const target = db.modules.insert(rootId, 'target', 'Target');

      // Create normal-fan-in targets to establish baseline
      const normalTargets: number[] = [];
      for (let i = 0; i < 30; i++) {
        normalTargets.push(db.modules.insert(rootId, `nt${i}`, `NT${i}`));
      }
      for (let i = 0; i < 30; i++) {
        const src = db.modules.insert(rootId, `ns${i}`, `NS${i}`);
        db.interactions.insert(src, normalTargets[i], { source: 'llm-inferred' });
      }

      // 20 llm-inferred inbound to anomalous target, 0 AST
      for (let i = 0; i < 20; i++) {
        const src = db.modules.insert(rootId, `h${i}`, `H${i}`);
        db.interactions.insert(src, target, { source: 'llm-inferred' });
      }

      const result = checkInteractionQuality(db);
      const fanInIssues = result.issues.filter((i) => i.category === 'fan-in-anomaly');
      expect(fanInIssues.length).toBeGreaterThanOrEqual(1);
      expect(fanInIssues[0].fixData?.action).toBe('remove-inferred-to-module');
      expect(fanInIssues[0].fixData?.targetModuleId).toBe(target);
    });
  });
});
