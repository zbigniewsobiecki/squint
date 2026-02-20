import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAnnotationCoverage } from '../../../src/commands/llm/_shared/verify/annotation-checker.js';
import { IndexDatabase } from '../../../src/db/database.js';

describe('checkAnnotationCoverage', () => {
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

  describe('domain consistency', () => {
    it('same-name definitions with different domains → inconsistent-domain warning', () => {
      const fileId1 = insertFile('/src/a.ts');
      const fileId2 = insertFile('/src/b.ts');
      const def1 = insertDefinition(fileId1, 'testHelper', 'function');
      const def2 = insertDefinition(fileId2, 'testHelper', 'function', { line: 1, endLine: 5 });

      // Set all required aspects so coverage passes
      db.metadata.set(def1, 'purpose', 'A test helper');
      db.metadata.set(def2, 'purpose', 'Another test helper');
      db.metadata.set(def1, 'domain', '["testing"]');
      db.metadata.set(def2, 'domain', '["auth"]');

      const result = checkAnnotationCoverage(db, ['purpose', 'domain']);
      const domainIssues = result.issues.filter((i) => i.category === 'inconsistent-domain');
      expect(domainIssues.length).toBeGreaterThanOrEqual(2); // Both definitions flagged
      expect(domainIssues[0].fixData?.action).toBe('harmonize-domain');
    });

    it('same-name definitions with same domains → no inconsistency', () => {
      const fileId1 = insertFile('/src/a.ts');
      const fileId2 = insertFile('/src/b.ts');
      const def1 = insertDefinition(fileId1, 'testHelper', 'function');
      const def2 = insertDefinition(fileId2, 'testHelper', 'function', { line: 1, endLine: 5 });

      db.metadata.set(def1, 'purpose', 'A test helper');
      db.metadata.set(def2, 'purpose', 'Another test helper');
      db.metadata.set(def1, 'domain', '["testing"]');
      db.metadata.set(def2, 'domain', '["testing"]');

      const result = checkAnnotationCoverage(db, ['purpose', 'domain']);
      const domainIssues = result.issues.filter((i) => i.category === 'inconsistent-domain');
      expect(domainIssues).toHaveLength(0);
    });

    it('definitions with different kinds not grouped together', () => {
      const fileId1 = insertFile('/src/a.ts');
      const fileId2 = insertFile('/src/b.ts');
      const def1 = insertDefinition(fileId1, 'Config', 'class');
      const def2 = insertDefinition(fileId2, 'Config', 'interface', { line: 1, endLine: 5 });

      db.metadata.set(def1, 'purpose', 'A config class');
      db.metadata.set(def2, 'purpose', 'A config interface');
      db.metadata.set(def1, 'domain', '["config"]');
      db.metadata.set(def2, 'domain', '["setup"]');

      const result = checkAnnotationCoverage(db, ['purpose', 'domain']);
      const domainIssues = result.issues.filter((i) => i.category === 'inconsistent-domain');
      expect(domainIssues).toHaveLength(0); // different kinds → not grouped
    });
  });
});
