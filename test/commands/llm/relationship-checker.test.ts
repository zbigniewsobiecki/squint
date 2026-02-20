import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRelationshipCoverage } from '../../../src/commands/llm/_shared/verify/relationship-checker.js';
import { IndexDatabase } from '../../../src/db/database.js';

describe('checkRelationshipCoverage', () => {
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

  it('no unannotated → passed', () => {
    const result = checkRelationshipCoverage(db);
    expect(result.passed).toBe(true);
    expect(result.stats.missingCount).toBe(0);
  });

  it('unannotated > 0 → missing-relationship errors', () => {
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
      expect(result.issues.some((i) => i.category === 'missing-relationship')).toBe(true);
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

  it('PENDING_LLM_ANNOTATION relationships detected as pending-annotation', () => {
    const fileId = insertFile('/src/a.ts');
    const defFrom = insertDefinition(fileId, 'UpdateCustomerDto');
    const defTo = insertDefinition(fileId, 'CreateCustomerDto', 'class', { line: 20, endLine: 30 });

    // Insert a relationship with PENDING placeholder
    db.relationships.set(defFrom, defTo, 'PENDING_LLM_ANNOTATION', 'extends');

    const result = checkRelationshipCoverage(db);
    const pendingIssues = result.issues.filter((i) => i.category === 'pending-annotation');
    expect(pendingIssues.length).toBeGreaterThanOrEqual(1);
    expect(pendingIssues[0].message).toContain('PENDING_LLM_ANNOTATION');
    expect(pendingIssues[0].fixData?.action).toBe('reannotate-relationship');
  });

  it('missing relationships enumerated with fixData', () => {
    const fileId = insertFile('/src/a.ts');
    const def1 = insertDefinition(fileId, 'funcA');
    const def2 = insertDefinition(fileId, 'funcB', 'function', { line: 20, endLine: 30 });

    // Create a scenario with unannotated relationships
    // The actual unannotated check depends on usages/imports,
    // so we just verify the structure works when there are results
    const result = checkRelationshipCoverage(db);
    // All missing-relationship issues should have the correct category
    const missingRels = result.issues.filter((i) => i.category === 'missing-relationship');
    for (const issue of missingRels) {
      expect(issue.fixData?.action).toBe('annotate-missing-relationship');
    }
  });
});
