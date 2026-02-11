import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTestFile } from '../../../src/commands/llm/_shared/module-prompts.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { ModuleRepository } from '../../../src/db/repositories/module-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

/**
 * Tests for the branch pushdown fallback algorithm.
 *
 * The pushdownBranchMembersFallback method is private on the Modules command,
 * so we test the algorithm by replicating its logic against real DB state.
 * This validates the tier 1/2/3 pushdown and test-file guard.
 */

/** Replicate the pushdown algorithm (same logic as modules.ts pushdownBranchMembersFallback) */
function pushdownBranchMembers(repo: ModuleRepository): number {
  let totalPushed = 0;
  let progress = true;

  while (progress) {
    progress = false;
    const branchModules = repo.getBranchModulesWithDirectMembers(0);
    if (branchModules.length === 0) break;

    for (const branch of branchModules) {
      const children = repo.getChildren(branch.id);
      if (children.length === 0) continue;

      const fileVotes = new Map<string, Map<number, number>>();
      const dirVotes = new Map<string, Map<number, number>>();

      for (const child of children) {
        const childMembers = repo.getMemberInfo(child.id);
        for (const member of childMembers) {
          let fv = fileVotes.get(member.filePath);
          if (!fv) {
            fv = new Map();
            fileVotes.set(member.filePath, fv);
          }
          fv.set(child.id, (fv.get(child.id) ?? 0) + 1);

          const dir = path.dirname(member.filePath);
          if (dir) {
            let dv = dirVotes.get(dir);
            if (!dv) {
              dv = new Map();
              dirVotes.set(dir, dv);
            }
            dv.set(child.id, (dv.get(child.id) ?? 0) + 1);
          }
        }
      }

      const fileMajority = new Map<string, number>();
      for (const [filePath, votes] of fileVotes) {
        let bestId = -1;
        let bestCount = 0;
        for (const [childId, count] of votes) {
          if (count > bestCount) {
            bestId = childId;
            bestCount = count;
          }
        }
        if (bestId >= 0) fileMajority.set(filePath, bestId);
      }

      const dirMajority = new Map<string, number>();
      for (const [dir, votes] of dirVotes) {
        let bestId = -1;
        let bestCount = 0;
        for (const [childId, count] of votes) {
          if (count > bestCount) {
            bestId = childId;
            bestCount = count;
          }
        }
        if (bestId >= 0) dirMajority.set(dir, bestId);
      }

      const childById = new Map(children.map((c) => [c.id, c]));

      for (const member of branch.members) {
        const symIsTest = isTestFile(member.filePath);
        let targetChildId: number | undefined;

        const fileTarget = fileMajority.get(member.filePath);
        if (fileTarget !== undefined) {
          const child = childById.get(fileTarget);
          if (child && (!symIsTest || child.isTest)) {
            targetChildId = fileTarget;
          }
        }

        if (targetChildId === undefined) {
          let dir = path.dirname(member.filePath);
          while (dir && dir !== '.' && dir !== '/') {
            const dirTarget = dirMajority.get(dir);
            if (dirTarget !== undefined) {
              const child = childById.get(dirTarget);
              if (child && (!symIsTest || child.isTest)) {
                targetChildId = dirTarget;
                break;
              }
            }
            dir = path.dirname(dir);
          }
        }

        if (targetChildId === undefined && children.length === 1) {
          const child = children[0];
          if (!symIsTest || child.isTest) {
            targetChildId = child.id;
          }
        }

        if (targetChildId !== undefined) {
          repo.assignSymbol(member.definitionId, targetChildId);
          totalPushed++;
          progress = true;
        }
      }
    }
  }

  return totalPushed;
}

describe('branch pushdown fallback', () => {
  let db: Database.Database;
  let repo: ModuleRepository;
  let fileRepo: FileRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new ModuleRepository(db);
    fileRepo = new FileRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertFile(filePath: string) {
    return fileRepo.insert({
      path: filePath,
      language: 'typescript',
      contentHash: `hash-${filePath}`,
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDef(fileId: number, name: string, kind = 'function') {
    return fileRepo.insertDefinition(fileId, {
      name,
      kind,
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 10, column: 1 },
    });
  }

  // ============================================================
  // Tier 1: Same-file majority
  // ============================================================
  describe('Tier 1: same-file majority', () => {
    it('pushes branch member to child when other symbols from same file are in that child', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'helpers', 'Helpers');
      const childAId = repo.insert(branchId, 'utils', 'Utils');
      const childBId = repo.insert(branchId, 'formatters', 'Formatters');

      const file1 = insertFile('/src/helpers/utils.ts');
      const def1 = insertDef(file1, 'helperA');
      const def2 = insertDef(file1, 'helperB');
      const def3 = insertDef(file1, 'helperC'); // will be on branch, should go to childA

      // Two symbols from file1 already in childA
      repo.assignSymbol(def1, childAId);
      repo.assignSymbol(def2, childAId);
      // One symbol from file1 stuck on branch
      repo.assignSymbol(def3, branchId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(1);

      // def3 should now be in childA (same file majority)
      const childAMembers = repo.getMemberInfo(childAId);
      expect(childAMembers.map((m) => m.definitionId)).toContain(def3);

      // Branch should have no direct members
      const branchMembers = repo.getMemberInfo(branchId);
      expect(branchMembers).toHaveLength(0);
    });

    it('pushes multiple branch members by file cohort to different children', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'backend', 'Backend');
      const childAId = repo.insert(branchId, 'api', 'API');
      const childBId = repo.insert(branchId, 'db', 'Database');

      const fileApi = insertFile('/src/api/routes.ts');
      const fileDb = insertFile('/src/db/queries.ts');

      const apiDef1 = insertDef(fileApi, 'getUsers');
      const apiDef2 = insertDef(fileApi, 'createUser'); // on branch
      const dbDef1 = insertDef(fileDb, 'findUser');
      const dbDef2 = insertDef(fileDb, 'insertUser'); // on branch

      repo.assignSymbol(apiDef1, childAId);
      repo.assignSymbol(dbDef1, childBId);
      repo.assignSymbol(apiDef2, branchId);
      repo.assignSymbol(dbDef2, branchId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(2);

      expect(repo.getMemberInfo(childAId).map((m) => m.definitionId)).toContain(apiDef2);
      expect(repo.getMemberInfo(childBId).map((m) => m.definitionId)).toContain(dbDef2);
      expect(repo.getMemberInfo(branchId)).toHaveLength(0);
    });
  });

  // ============================================================
  // Tier 2: Same-directory majority
  // ============================================================
  describe('Tier 2: same-directory majority', () => {
    it('pushes branch member based on directory cohort when file has no match', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'frontend', 'Frontend');
      const childAId = repo.insert(branchId, 'components', 'Components');
      const childBId = repo.insert(branchId, 'hooks', 'Hooks');

      const file1 = insertFile('/src/components/Button.tsx');
      const file2 = insertFile('/src/components/Input.tsx'); // new file, no symbols in children yet
      const file3 = insertFile('/src/hooks/useAuth.ts');

      const def1 = insertDef(file1, 'Button');
      const def2 = insertDef(file2, 'Input'); // on branch — directory matches childA
      const def3 = insertDef(file3, 'useAuth');

      repo.assignSymbol(def1, childAId);
      repo.assignSymbol(def3, childBId);
      repo.assignSymbol(def2, branchId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(1);

      // Input should go to components child (same /src/components directory)
      expect(repo.getMemberInfo(childAId).map((m) => m.definitionId)).toContain(def2);
      expect(repo.getMemberInfo(branchId)).toHaveLength(0);
    });

    it('walks up parent directories to find a match', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'lib', 'Library');
      const childId = repo.insert(branchId, 'core', 'Core');

      const file1 = insertFile('/src/lib/core/parser.ts');
      const file2 = insertFile('/src/lib/core/deep/nested/helper.ts'); // deeper subdir

      const def1 = insertDef(file1, 'Parser');
      const def2 = insertDef(file2, 'Helper'); // on branch, should walk up dirs

      repo.assignSymbol(def1, childId);
      repo.assignSymbol(def2, branchId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(1);

      expect(repo.getMemberInfo(childId).map((m) => m.definitionId)).toContain(def2);
    });
  });

  // ============================================================
  // Tier 3: Single child unconditional
  // ============================================================
  describe('Tier 3: single child', () => {
    it('moves all branch members to the only child when there is exactly one child', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'auth', 'Auth');
      const childId = repo.insert(branchId, 'login', 'Login');

      const file1 = insertFile('/src/auth/session.ts');
      const file2 = insertFile('/src/unrelated/other.ts');

      const def1 = insertDef(file1, 'SessionManager');
      const def2 = insertDef(file2, 'OtherThing');

      repo.assignSymbol(def1, branchId);
      repo.assignSymbol(def2, branchId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(2);

      const childMembers = repo.getMemberInfo(childId);
      expect(childMembers).toHaveLength(2);
      expect(repo.getMemberInfo(branchId)).toHaveLength(0);
    });
  });

  // ============================================================
  // Test-file guard
  // ============================================================
  describe('test-file guard', () => {
    it('does not push test-file symbols to non-test children', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'helpers', 'Helpers');
      const childId = repo.insert(branchId, 'utils', 'Utils', undefined, false);

      const testFile = insertFile('/src/helpers/utils.test.ts');
      const normalFile = insertFile('/src/helpers/utils.ts');

      const testDef = insertDef(testFile, 'testHelper');
      const normalDef = insertDef(normalFile, 'normalHelper');

      repo.assignSymbol(normalDef, childId); // establishes file cohort
      repo.assignSymbol(testDef, branchId);

      const pushed = pushdownBranchMembers(repo);
      // Test symbol should NOT be pushed to a non-test child
      expect(pushed).toBe(0);
      expect(repo.getMemberInfo(branchId).map((m) => m.definitionId)).toContain(testDef);
    });

    it('allows test-file symbols to move to test children', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'testing', 'Testing', undefined, true);
      const childId = repo.insert(branchId, 'unit', 'Unit Tests', undefined, true);

      const testFile = insertFile('/test/helpers.test.ts');
      const testFile2 = insertFile('/test/utils.test.ts');

      const def1 = insertDef(testFile, 'testHelper');
      const def2 = insertDef(testFile2, 'testUtil');

      repo.assignSymbol(def1, childId);
      repo.assignSymbol(def2, branchId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(1);
      expect(repo.getMemberInfo(childId).map((m) => m.definitionId)).toContain(def2);
    });
  });

  // ============================================================
  // No-op cases
  // ============================================================
  describe('no-op cases', () => {
    it('returns 0 when there are no branch modules', () => {
      const rootId = repo.ensureRoot();
      const leafId = repo.insert(rootId, 'leaf', 'Leaf');
      const file = insertFile('/src/leaf.ts');
      const def = insertDef(file, 'leafFn');
      repo.assignSymbol(def, leafId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(0);
    });

    it('returns 0 when branch has no direct members', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'branch', 'Branch');
      const childId = repo.insert(branchId, 'child', 'Child');

      const file = insertFile('/src/child.ts');
      const def = insertDef(file, 'childFn');
      repo.assignSymbol(def, childId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(0);
    });

    it('does not push when no file/dir cohort matches and multiple children exist', () => {
      const rootId = repo.ensureRoot();
      const branchId = repo.insert(rootId, 'branch', 'Branch');
      repo.insert(branchId, 'childA', 'Child A');
      repo.insert(branchId, 'childB', 'Child B');
      // No symbols in children → no cohort to match

      const file = insertFile('/src/orphan.ts');
      const def = insertDef(file, 'orphanFn');
      repo.assignSymbol(def, branchId);

      const pushed = pushdownBranchMembers(repo);
      expect(pushed).toBe(0);
      expect(repo.getMemberInfo(branchId)).toHaveLength(1);
    });
  });

  // ============================================================
  // Multi-level cascading
  // ============================================================
  describe('cascading', () => {
    it('handles nested branch modules across multiple iterations', () => {
      const rootId = repo.ensureRoot();
      const level1Id = repo.insert(rootId, 'a', 'A');
      const level2Id = repo.insert(level1Id, 'b', 'B');
      const leafId = repo.insert(level2Id, 'c', 'C');

      const file = insertFile('/src/a/b/c/thing.ts');
      const def1 = insertDef(file, 'thing1');
      const def2 = insertDef(file, 'thing2');

      // def1 in leaf establishes cohort, def2 stuck on level1
      repo.assignSymbol(def1, leafId);
      repo.assignSymbol(def2, level1Id);

      const pushed = pushdownBranchMembers(repo);
      // Should cascade: level1 → level2 → leaf (via directory cohort + single child)
      expect(pushed).toBeGreaterThanOrEqual(1);

      // Eventually def2 should end up in the leaf
      const leafMembers = repo.getMemberInfo(leafId);
      expect(leafMembers.map((m) => m.definitionId)).toContain(def2);
      expect(repo.getMemberInfo(level1Id)).toHaveLength(0);
    });
  });
});
