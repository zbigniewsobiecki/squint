import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkInteractionQuality } from '../../../src/commands/llm/_shared/verify/interaction-checker.js';
import { IndexDatabase } from '../../../src/db/database.js';

describe('checkInteractionQuality', () => {
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
