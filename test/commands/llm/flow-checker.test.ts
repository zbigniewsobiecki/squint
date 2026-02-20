import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFlowQuality } from '../../../src/commands/llm/_shared/verify/flow-checker.js';
import { IndexDatabase } from '../../../src/db/database.js';

describe('checkFlowQuality', () => {
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
