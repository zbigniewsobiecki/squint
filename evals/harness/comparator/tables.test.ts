import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../../src/db/database-facade.js';
import { buildGroundTruthDb } from '../builder.js';
import { type GroundTruth, defKey } from '../types.js';
import type { ProseJudgeFn } from '../types.js';
import {
  compareContracts,
  compareDefinitionMetadata,
  compareDefinitions,
  compareFiles,
  compareFlows,
  compareImports,
  compareInteractions,
  compareModuleMembers,
  compareModules,
  compareRelationshipAnnotations,
} from './tables/index.js';

/**
 * Per-table comparator strategies. Each comparator takes a "produced" DB
 * (what squint emitted) and a GroundTruth, and returns a TableDiff.
 *
 * Tests use TWO builder-produced DBs that intentionally differ to verify
 * the comparator detects each kind of mismatch (missing, extra, mismatch).
 */
describe('per-table comparators', () => {
  let dir: string;
  let producedDb: IndexDatabase;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-eval-cmp-'));
    producedDb = new IndexDatabase(path.join(dir, 'produced.db'));
    producedDb.initialize();
  });

  afterEach(() => {
    producedDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ============================================================
  // files
  // ============================================================
  describe('compareFiles', () => {
    const gt: GroundTruth = {
      fixtureName: 't',
      files: [
        { path: 'src/a.ts', language: 'typescript' },
        { path: 'src/b.ts', language: 'typescript' },
      ],
      definitions: [],
    };

    it('passes when produced matches ground truth', () => {
      buildGroundTruthDb(producedDb, gt);
      const diff = compareFiles(producedDb, gt);
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      expect(diff.expectedCount).toBe(2);
      expect(diff.producedCount).toBe(2);
    });

    it('reports critical missing when a file is absent in produced', () => {
      buildGroundTruthDb(producedDb, { ...gt, files: [{ path: 'src/a.ts', language: 'typescript' }] });
      const diff = compareFiles(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({ kind: 'missing', severity: 'critical', naturalKey: 'src/b.ts' }),
      ]);
    });

    it('reports major extra when produced has a file not in ground truth', () => {
      buildGroundTruthDb(producedDb, {
        ...gt,
        files: [...gt.files, { path: 'src/c.ts', language: 'typescript' }],
      });
      const diff = compareFiles(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({ kind: 'extra', severity: 'major', naturalKey: 'src/c.ts' }),
      ]);
    });
  });

  // ============================================================
  // definitions
  // ============================================================
  describe('compareDefinitions', () => {
    const gt: GroundTruth = {
      fixtureName: 't',
      files: [{ path: 'src/foo.ts', language: 'typescript' }],
      definitions: [
        { file: 'src/foo.ts', name: 'Foo', kind: 'class', isExported: true, line: 5, extendsName: 'Base' },
        { file: 'src/foo.ts', name: 'helper', kind: 'function', isExported: false, line: 20 },
      ],
    };

    it('passes on exact match', () => {
      buildGroundTruthDb(producedDb, gt);
      const diff = compareDefinitions(producedDb, gt);
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
    });

    it('tolerates ±2 line drift on definition lines', () => {
      buildGroundTruthDb(producedDb, {
        ...gt,
        definitions: [
          { file: 'src/foo.ts', name: 'Foo', kind: 'class', isExported: true, line: 7, extendsName: 'Base' },
          { file: 'src/foo.ts', name: 'helper', kind: 'function', isExported: false, line: 19 },
        ],
      });
      const diff = compareDefinitions(producedDb, gt);
      expect(diff.passed).toBe(true);
    });

    it('reports a minor mismatch when line drifts beyond tolerance (still passes — minor only)', () => {
      buildGroundTruthDb(producedDb, {
        ...gt,
        definitions: [
          { file: 'src/foo.ts', name: 'Foo', kind: 'class', isExported: true, line: 50, extendsName: 'Base' },
          { file: 'src/foo.ts', name: 'helper', kind: 'function', isExported: false, line: 20 },
        ],
      });
      const diff = compareDefinitions(producedDb, gt);
      // Line drift is informational (minor) — should still be reported, but the table passes.
      // Pass criteria across every comparator: zero critical AND zero major. Minor is allowed.
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'mismatch',
            severity: 'minor',
            naturalKey: 'src/foo.ts::Foo',
            details: expect.stringContaining('line'),
          }),
        ])
      );
    });

    it('reports critical missing definition', () => {
      buildGroundTruthDb(producedDb, {
        ...gt,
        definitions: [
          { file: 'src/foo.ts', name: 'Foo', kind: 'class', isExported: true, line: 5, extendsName: 'Base' },
        ],
      });
      const diff = compareDefinitions(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'critical',
          naturalKey: 'src/foo.ts::helper',
        }),
      ]);
    });

    it('reports mismatch when extendsName differs', () => {
      buildGroundTruthDb(producedDb, {
        ...gt,
        definitions: [
          { file: 'src/foo.ts', name: 'Foo', kind: 'class', isExported: true, line: 5, extendsName: 'WrongBase' },
          { file: 'src/foo.ts', name: 'helper', kind: 'function', isExported: false, line: 20 },
        ],
      });
      const diff = compareDefinitions(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'mismatch',
            naturalKey: 'src/foo.ts::Foo',
            details: expect.stringContaining('extendsName'),
          }),
        ])
      );
    });

    it('reports extra definitions in produced not declared in ground truth', () => {
      buildGroundTruthDb(producedDb, {
        ...gt,
        definitions: [
          ...gt.definitions,
          { file: 'src/foo.ts', name: 'rogue', kind: 'function', isExported: true, line: 30 },
        ],
      });
      const diff = compareDefinitions(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'extra',
            severity: 'major',
            naturalKey: 'src/foo.ts::rogue',
          }),
        ])
      );
    });

    it('reports mismatch when implementsNames set differs (order-independent)', () => {
      const gtWithImpl: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [
          {
            file: 'src/foo.ts',
            name: 'Foo',
            kind: 'class',
            isExported: true,
            line: 1,
            implementsNames: ['IA', 'IB'],
          },
        ],
      };
      // Build with ONE interface — produced is missing IB
      buildGroundTruthDb(producedDb, {
        ...gtWithImpl,
        definitions: [
          {
            file: 'src/foo.ts',
            name: 'Foo',
            kind: 'class',
            isExported: true,
            line: 1,
            implementsNames: ['IA'],
          },
        ],
      });
      const diff = compareDefinitions(producedDb, gtWithImpl);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'mismatch',
            naturalKey: 'src/foo.ts::Foo',
            details: expect.stringContaining('implementsNames'),
          }),
        ])
      );
    });

    it('treats implementsNames as equal regardless of declaration order', () => {
      const expected: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [
          {
            file: 'src/foo.ts',
            name: 'Foo',
            kind: 'class',
            isExported: true,
            line: 1,
            implementsNames: ['IA', 'IB'],
          },
        ],
      };
      buildGroundTruthDb(producedDb, {
        ...expected,
        definitions: [
          {
            file: 'src/foo.ts',
            name: 'Foo',
            kind: 'class',
            isExported: true,
            line: 1,
            implementsNames: ['IB', 'IA'], // reversed
          },
        ],
      });
      const diff = compareDefinitions(producedDb, expected);
      expect(diff.passed).toBe(true);
    });

    it('reports mismatch when isDefault differs', () => {
      const gtDefault: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'Foo', kind: 'class', isExported: true, isDefault: true, line: 1 }],
      };
      // Build without isDefault
      buildGroundTruthDb(producedDb, {
        ...gtDefault,
        definitions: [{ file: 'src/foo.ts', name: 'Foo', kind: 'class', isExported: true, isDefault: false, line: 1 }],
      });
      const diff = compareDefinitions(producedDb, gtDefault);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'mismatch',
            details: expect.stringContaining('isDefault'),
          }),
        ])
      );
    });
  });

  // ============================================================
  // imports
  // ============================================================
  describe('compareImports', () => {
    const gt: GroundTruth = {
      fixtureName: 't',
      files: [
        { path: 'src/a.ts', language: 'typescript' },
        { path: 'src/b.ts', language: 'typescript' },
      ],
      definitions: [{ file: 'src/b.ts', name: 'helper', kind: 'function', isExported: true, line: 1 }],
      imports: [
        {
          fromFile: 'src/a.ts',
          source: './b.js',
          type: 'import',
          symbols: [{ name: 'helper', kind: 'named' }],
        },
      ],
    };

    it('passes when imports match', () => {
      buildGroundTruthDb(producedDb, gt);
      const diff = compareImports(producedDb, gt);
      expect(diff.passed).toBe(true);
    });

    it('reports missing when ground-truth import is absent', () => {
      buildGroundTruthDb(producedDb, { ...gt, imports: [] });
      const diff = compareImports(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([expect.objectContaining({ kind: 'missing', severity: 'major' })]);
    });
  });

  // ============================================================
  // modules + module_members
  // ============================================================
  describe('compareModules + compareModuleMembers', () => {
    /** Stub judge keyed on `${reference}|${candidate}`. */
    function stubJudge(scores: Record<string, number>): ProseJudgeFn {
      return async (req) => {
        const score = scores[`${req.reference}|${req.candidate}`] ?? 0;
        return {
          similarity: score,
          passed: score >= req.minSimilarity,
          reasoning: `stub score ${score}`,
        };
      };
    }

    /** Set the description column for a module in the produced DB (post-build). */
    function setProducedDescription(fullPath: string, description: string): void {
      producedDb
        .getConnection()
        .prepare('UPDATE modules SET description = ? WHERE full_path = ?')
        .run(description, fullPath);
    }

    const gt: GroundTruth = {
      fixtureName: 't',
      files: [{ path: 'src/auth.ts', language: 'typescript' }],
      definitions: [{ file: 'src/auth.ts', name: 'AuthService', kind: 'class', isExported: true, line: 1 }],
      modules: [
        {
          fullPath: 'project.services.auth',
          name: 'Auth',
          members: [defKey('src/auth.ts', 'AuthService')],
        },
      ],
    };

    it('compareModules passes on exact tree match (ignoring auto-created ancestors)', async () => {
      buildGroundTruthDb(producedDb, gt);
      const diff = await compareModules(producedDb, gt, stubJudge({}));
      expect(diff.passed).toBe(true);
    });

    it('compareModules reports missing module', async () => {
      buildGroundTruthDb(producedDb, { ...gt, modules: [] });
      const diff = await compareModules(producedDb, gt, stubJudge({}));
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'major',
          naturalKey: 'project.services.auth',
        }),
      ]);
    });

    it('compareModuleMembers passes when each definition lands in its expected module', () => {
      buildGroundTruthDb(producedDb, gt);
      const diff = compareModuleMembers(producedDb, gt);
      expect(diff.passed).toBe(true);
    });

    it('compareModuleMembers reports definitions assigned to the wrong module', () => {
      // Build with member assigned to a DIFFERENT module than expected
      const wrongGt: GroundTruth = {
        ...gt,
        modules: [
          {
            fullPath: 'project.utils', // wrong module
            name: 'Utils',
            members: [defKey('src/auth.ts', 'AuthService')],
          },
        ],
      };
      buildGroundTruthDb(producedDb, wrongGt);
      const diff = compareModuleMembers(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: 'src/auth.ts::AuthService',
          details: expect.stringContaining('project.services.auth'),
        }),
      ]);
    });

    // --- description prose check (new in iteration 4) ---

    it('compareModules passes prose check when judge approves the description', async () => {
      buildGroundTruthDb(producedDb, gt);
      setProducedDescription('project.services.auth', 'Authentication services for users.');

      const expectedGt: GroundTruth = {
        ...gt,
        modules: [
          {
            fullPath: 'project.services.auth',
            name: 'Auth',
            members: [defKey('src/auth.ts', 'AuthService')],
            descriptionReference: 'Authentication services for users.',
          },
        ],
      };
      const judge = stubJudge({
        'Authentication services for users.|Authentication services for users.': 0.95,
      });

      const diff = await compareModules(producedDb, expectedGt, judge);
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      expect(diff.proseChecks).toEqual({ passed: 1, failed: 0 });
    });

    it('compareModules records prose-drift minor when judge score is below threshold', async () => {
      buildGroundTruthDb(producedDb, gt);
      setProducedDescription('project.services.auth', 'Sends email newsletters.');

      const expectedGt: GroundTruth = {
        ...gt,
        modules: [
          {
            fullPath: 'project.services.auth',
            name: 'Auth',
            members: [defKey('src/auth.ts', 'AuthService')],
            descriptionReference: 'Authentication services for users.',
            minSimilarity: 0.6,
          },
        ],
      };
      const judge = stubJudge({
        'Authentication services for users.|Sends email newsletters.': 0.2,
      });

      const diff = await compareModules(producedDb, expectedGt, judge);
      // Minor only — table still passes (no critical/major)
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'prose-drift',
          severity: 'minor',
          naturalKey: 'project.services.auth',
        }),
      ]);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 1 });
    });

    it('compareModules skips judge call when GT entry has no descriptionReference', async () => {
      buildGroundTruthDb(producedDb, gt);
      setProducedDescription('project.services.auth', 'whatever the LLM said');

      // GT module has no descriptionReference → existence-only check
      const judge: ProseJudgeFn = async () => {
        throw new Error('judge should not be called when there is no descriptionReference');
      };

      const diff = await compareModules(producedDb, gt, judge);
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 0 });
    });

    it('compareModules uses default min similarity 0.6 when not specified', async () => {
      buildGroundTruthDb(producedDb, gt);
      setProducedDescription('project.services.auth', 'cand');

      const expectedGt: GroundTruth = {
        ...gt,
        modules: [
          {
            fullPath: 'project.services.auth',
            name: 'Auth',
            members: [defKey('src/auth.ts', 'AuthService')],
            descriptionReference: 'ref',
            // no minSimilarity → default 0.6
          },
        ],
      };
      // 0.59 < 0.6 → fail
      const judge = stubJudge({ 'ref|cand': 0.59 });
      const diff = await compareModules(producedDb, expectedGt, judge);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 1 });

      // 0.6 == 0.6 → pass (boundary)
      const judge2 = stubJudge({ 'ref|cand': 0.6 });
      const diff2 = await compareModules(producedDb, expectedGt, judge2);
      expect(diff2.proseChecks).toEqual({ passed: 1, failed: 0 });
    });

    it('compareModules treats NULL produced description as a failed prose check', async () => {
      // Builder writes description=NULL by default; if GT declares a reference,
      // the LLM is expected to have produced something. NULL = drop = fail.
      buildGroundTruthDb(producedDb, gt);
      // intentionally NOT setting a description — it stays NULL

      const expectedGt: GroundTruth = {
        ...gt,
        modules: [
          {
            fullPath: 'project.services.auth',
            name: 'Auth',
            members: [defKey('src/auth.ts', 'AuthService')],
            descriptionReference: 'Authentication services for users.',
          },
        ],
      };
      // The judge will never be called because the description is null;
      // throw if it is.
      const judge: ProseJudgeFn = async () => {
        throw new Error('judge must not be called when produced description is NULL');
      };

      const diff = await compareModules(producedDb, expectedGt, judge);
      expect(diff.passed).toBe(true); // minor only, gate not flipped
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'prose-drift',
          severity: 'minor',
          naturalKey: 'project.services.auth',
          details: expect.stringContaining('null'),
        }),
      ]);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 1 });
    });
  });

  // ============================================================
  // contracts
  // ============================================================
  describe('compareContracts', () => {
    const gt: GroundTruth = {
      fixtureName: 't',
      files: [{ path: 'src/auth.ts', language: 'typescript' }],
      definitions: [{ file: 'src/auth.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
      contracts: [
        {
          protocol: 'http',
          normalizedKey: 'POST /api/auth/login',
          participants: [{ defKey: defKey('src/auth.ts', 'login'), role: 'server' }],
        },
      ],
    };

    it('passes on exact match', () => {
      buildGroundTruthDb(producedDb, gt);
      const diff = compareContracts(producedDb, gt);
      expect(diff.passed).toBe(true);
    });

    it('reports critical missing contract', () => {
      buildGroundTruthDb(producedDb, { ...gt, contracts: [] });
      const diff = compareContracts(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'critical',
          naturalKey: 'http::POST /api/auth/login',
        }),
      ]);
    });
  });

  // ============================================================
  // interactions
  // ============================================================
  describe('compareInteractions', () => {
    const gt: GroundTruth = {
      fixtureName: 't',
      files: [
        { path: 'src/c.ts', language: 'typescript' },
        { path: 'src/s.ts', language: 'typescript' },
      ],
      definitions: [
        { file: 'src/c.ts', name: 'ctrl', kind: 'function', isExported: true, line: 1 },
        { file: 'src/s.ts', name: 'svc', kind: 'function', isExported: true, line: 1 },
      ],
      modules: [
        { fullPath: 'project.controllers', name: 'C', members: [defKey('src/c.ts', 'ctrl')] },
        { fullPath: 'project.services', name: 'S', members: [defKey('src/s.ts', 'svc')] },
      ],
      interactions: [
        {
          fromModulePath: 'project.controllers',
          toModulePath: 'project.services',
          pattern: 'business',
          source: 'ast',
        },
      ],
    };

    it('passes on exact match', () => {
      buildGroundTruthDb(producedDb, gt);
      const diff = compareInteractions(producedDb, gt);
      expect(diff.passed).toBe(true);
    });

    it('reports missing interaction', () => {
      buildGroundTruthDb(producedDb, { ...gt, interactions: [] });
      const diff = compareInteractions(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'major',
          naturalKey: 'project.controllers->project.services',
        }),
      ]);
    });

    it('reports mismatch on wrong source', () => {
      buildGroundTruthDb(producedDb, {
        ...gt,
        interactions: [
          {
            fromModulePath: 'project.controllers',
            toModulePath: 'project.services',
            pattern: 'business',
            source: 'llm-inferred', // wrong
          },
        ],
      });
      const diff = compareInteractions(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'mismatch',
          details: expect.stringContaining('source'),
        }),
      ]);
    });
  });

  // ============================================================
  // ID-agnosticism: comparators must join on natural keys, not row IDs
  // ============================================================
  describe('id-agnosticism — built in reverse order', () => {
    it('compareDefinitions matches when produced DB has reversed insertion order', () => {
      // Build the EXPECTED ground truth in normal order...
      const gt: GroundTruth = {
        fixtureName: 't',
        files: [
          { path: 'src/a.ts', language: 'typescript' },
          { path: 'src/b.ts', language: 'typescript' },
          { path: 'src/c.ts', language: 'typescript' },
        ],
        definitions: [
          { file: 'src/a.ts', name: 'alpha', kind: 'function', isExported: true, line: 1 },
          { file: 'src/b.ts', name: 'beta', kind: 'function', isExported: true, line: 1 },
          { file: 'src/c.ts', name: 'gamma', kind: 'function', isExported: true, line: 1 },
        ],
      };

      // ...but build the PRODUCED DB with files inserted in REVERSE order. This
      // gives every row a different DB id than a fresh natural-order build would,
      // proving the comparator joins on file_path/name/kind instead of IDs.
      const reversedGt: GroundTruth = {
        ...gt,
        files: [...gt.files].reverse(),
        definitions: [...gt.definitions].reverse(),
      };
      buildGroundTruthDb(producedDb, reversedGt);

      // Sanity check: row IDs really did come out in reverse insertion order
      const conn = producedDb.getConnection();
      const idRows = conn.prepare('SELECT id, path FROM files ORDER BY id').all() as Array<{
        id: number;
        path: string;
      }>;
      expect(idRows.map((r) => r.path)).toEqual(['src/c.ts', 'src/b.ts', 'src/a.ts']);

      // Now compare against the natural-order ground truth — should match exactly.
      const fileDiff = compareFiles(producedDb, gt);
      const defDiff = compareDefinitions(producedDb, gt);
      expect(fileDiff.passed).toBe(true);
      expect(fileDiff.diffs).toHaveLength(0);
      expect(defDiff.passed).toBe(true);
      expect(defDiff.diffs).toHaveLength(0);
    });

    it('compareModuleMembers matches when modules are inserted in different order than ground truth declares', () => {
      const gt: GroundTruth = {
        fixtureName: 't',
        files: [
          { path: 'src/a.ts', language: 'typescript' },
          { path: 'src/b.ts', language: 'typescript' },
        ],
        definitions: [
          { file: 'src/a.ts', name: 'A', kind: 'class', isExported: true, line: 1 },
          { file: 'src/b.ts', name: 'B', kind: 'class', isExported: true, line: 1 },
        ],
        modules: [
          { fullPath: 'project.alpha', name: 'Alpha', members: [defKey('src/a.ts', 'A')] },
          { fullPath: 'project.beta', name: 'Beta', members: [defKey('src/b.ts', 'B')] },
        ],
      };

      // Reverse module insertion order
      buildGroundTruthDb(producedDb, { ...gt, modules: [...gt.modules!].reverse() });

      const diff = compareModuleMembers(producedDb, gt);
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
    });
  });

  // ============================================================
  // flows
  // ============================================================
  describe('compareFlows', () => {
    const gt: GroundTruth = {
      fixtureName: 't',
      files: [{ path: 'src/c.ts', language: 'typescript' }],
      definitions: [{ file: 'src/c.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
      modules: [{ fullPath: 'project.controllers', name: 'C', members: [defKey('src/c.ts', 'login')] }],
      flows: [
        {
          slug: 'user-login',
          name: 'Login',
          stakeholder: 'user',
          entryDef: defKey('src/c.ts', 'login'),
          entryPath: 'POST /api/auth/login',
        },
      ],
    };

    it('passes on exact match', () => {
      buildGroundTruthDb(producedDb, gt);
      const diff = compareFlows(producedDb, gt);
      expect(diff.passed).toBe(true);
    });

    it('reports critical missing flow', () => {
      buildGroundTruthDb(producedDb, { ...gt, flows: [] });
      const diff = compareFlows(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'critical',
          naturalKey: 'user-login',
        }),
      ]);
    });

    it('reports mismatch on wrong stakeholder', () => {
      buildGroundTruthDb(producedDb, {
        ...gt,
        flows: [
          {
            slug: 'user-login',
            name: 'Login',
            stakeholder: 'admin', // wrong
            entryDef: defKey('src/c.ts', 'login'),
            entryPath: 'POST /api/auth/login',
          },
        ],
      });
      const diff = compareFlows(producedDb, gt);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'mismatch',
          details: expect.stringContaining('stakeholder'),
        }),
      ]);
    });
  });

  // ============================================================
  // definition_metadata
  // ============================================================
  describe('compareDefinitionMetadata', () => {
    /** Builds a stub judge that returns canned scores per (reference, candidate) pair. */
    function stubJudge(scores: Record<string, number>): ProseJudgeFn {
      return async (req) => {
        const score = scores[`${req.reference}|${req.candidate}`] ?? 0;
        return {
          similarity: score,
          passed: score >= req.minSimilarity,
          reasoning: `stub score ${score}`,
        };
      };
    }

    /** Build a fixture with one definition and pre-populated metadata in the produced DB. */
    function buildWithMetadata(metadata: Array<{ key: string; value: string }>): void {
      const gt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: metadata.map((m) => ({
          defKey: defKey('src/foo.ts', 'login'),
          key: m.key,
          exactValue: m.value,
        })),
      };
      buildGroundTruthDb(producedDb, gt);
    }

    it('passes when all expected metadata is present and matches exactly', async () => {
      buildWithMetadata([
        { key: 'purpose', value: 'Authenticates a user.' },
        { key: 'pure', value: 'false' },
      ]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'purpose',
            exactValue: 'Authenticates a user.',
          },
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'pure',
            exactValue: 'false',
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      expect(diff.expectedCount).toBe(2);
    });

    it('reports critical when GT references a definition that does not exist in produced', async () => {
      // Build a DB with one def, but GT metadata references a non-existent def
      buildWithMetadata([{ key: 'purpose', value: 'whatever' }]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/missing.ts', 'ghost'),
            key: 'purpose',
            exactValue: 'should not match anything',
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'critical',
          naturalKey: expect.stringContaining('src/missing.ts::ghost'),
        }),
      ]);
    });

    it('reports major when an aspect is not annotated for an existing definition', async () => {
      buildWithMetadata([
        { key: 'purpose', value: 'Authenticates a user.' },
        // pure NOT annotated
      ]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'purpose',
            exactValue: 'Authenticates a user.',
          },
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'pure',
            exactValue: 'false',
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'major',
          naturalKey: expect.stringContaining('src/foo.ts::login'),
          details: expect.stringContaining('pure'),
        }),
      ]);
    });

    it('reports major mismatch when pure value differs (exact match)', async () => {
      buildWithMetadata([{ key: 'pure', value: 'true' }]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'pure',
            exactValue: 'false',
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'mismatch',
          severity: 'major',
          details: expect.stringContaining('pure'),
        }),
      ]);
    });

    it('reports MINOR (not major) when domain set differs (vocabulary drift)', async () => {
      buildWithMetadata([{ key: 'domain', value: '["http"]' }]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'domain',
            acceptableSet: ['authentication', 'security'],
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      // Minor diff present, but table still passes (no critical/major)
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'mismatch',
          severity: 'minor',
          details: expect.stringContaining('domain'),
        }),
      ]);
    });

    it('domain set match is order-independent', async () => {
      buildWithMetadata([{ key: 'domain', value: '["http","authentication"]' }]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'domain',
            acceptableSet: ['authentication', 'http'], // reversed
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
    });

    it('domain subset semantics: produced is a strict subset of acceptableSet → pass', async () => {
      // LLM picked just one tag from a vocabulary of three; that's still acceptable
      buildWithMetadata([{ key: 'domain', value: '["authentication"]' }]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'domain',
            acceptableSet: ['authentication', 'auth', 'http', 'security'],
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
    });

    it('domain subset semantics: outlier tag in produced → minor mismatch', async () => {
      // LLM picked one OK tag and one out-of-vocabulary tag
      buildWithMetadata([{ key: 'domain', value: '["authentication","payments"]' }]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'domain',
            acceptableSet: ['authentication', 'auth', 'http', 'security'],
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(true); // minor only
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'mismatch',
          severity: 'minor',
          details: expect.stringContaining('payments'),
        }),
      ]);
    });

    it('domain subset semantics: empty produced array → minor mismatch', async () => {
      buildWithMetadata([{ key: 'domain', value: '[]' }]);

      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'domain',
            acceptableSet: ['authentication'],
          },
        ],
      };

      const diff = await compareDefinitionMetadata(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(true); // minor only
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'mismatch',
          severity: 'minor',
        }),
      ]);
    });

    it('records prose-drift minor diff when judge score < threshold', async () => {
      buildWithMetadata([{ key: 'purpose', value: 'Sends emails to nobody.' }]);

      const reference = 'Authenticates a user by verifying credentials.';
      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'purpose',
            proseReference: reference,
            minSimilarity: 0.75,
          },
        ],
      };

      const judge = stubJudge({ [`${reference}|Sends emails to nobody.`]: 0.2 });
      const diff = await compareDefinitionMetadata(producedDb, expectedGt, judge);

      // Minor prose drift → does NOT flip passed
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'prose-drift',
          severity: 'minor',
        }),
      ]);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 1 });
    });

    it('bumps proseChecks.passed when judge approves', async () => {
      buildWithMetadata([{ key: 'purpose', value: 'Verifies user identity and signs an auth token.' }]);

      const reference = 'Authenticates a user by verifying credentials and returning a JWT.';
      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'purpose',
            proseReference: reference,
          },
        ],
      };

      const judge = stubJudge({
        [`${reference}|Verifies user identity and signs an auth token.`]: 0.9,
      });
      const diff = await compareDefinitionMetadata(producedDb, expectedGt, judge);

      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      expect(diff.proseChecks).toEqual({ passed: 1, failed: 0 });
    });

    it('uses default min similarity 0.75 when not specified', async () => {
      buildWithMetadata([{ key: 'purpose', value: 'cand' }]);
      const expectedGt: GroundTruth = {
        fixtureName: 't',
        files: [{ path: 'src/foo.ts', language: 'typescript' }],
        definitions: [{ file: 'src/foo.ts', name: 'login', kind: 'function', isExported: true, line: 1 }],
        definitionMetadata: [
          {
            defKey: defKey('src/foo.ts', 'login'),
            key: 'purpose',
            proseReference: 'ref',
            // no minSimilarity → default 0.75
          },
        ],
      };
      // 0.74 < 0.75 → fail
      const judge = stubJudge({ 'ref|cand': 0.74 });
      const diff = await compareDefinitionMetadata(producedDb, expectedGt, judge);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 1 });
    });
  });

  // ============================================================
  // relationship_annotations
  // ============================================================
  describe('compareRelationshipAnnotations', () => {
    /** Stub judge keyed on `${reference}|${candidate}`. */
    function stubJudge(scores: Record<string, number>): ProseJudgeFn {
      return async (req) => {
        const score = scores[`${req.reference}|${req.candidate}`] ?? 0;
        return {
          similarity: score,
          passed: score >= req.minSimilarity,
          reasoning: `stub score ${score}`,
        };
      };
    }

    /**
     * Two-file fixture with one inheritance edge (TasksRepository → BaseRepository)
     * and one "uses" edge (TasksService → tasksRepository). The shape mirrors the
     * real todo-api relationships well enough to validate the comparator end-to-end.
     */
    const baseFixture: GroundTruth = {
      fixtureName: 't',
      files: [
        { path: 'src/repo.ts', language: 'typescript' },
        { path: 'src/svc.ts', language: 'typescript' },
      ],
      definitions: [
        { file: 'src/repo.ts', name: 'BaseRepository', kind: 'class', isExported: true, line: 1 },
        {
          file: 'src/repo.ts',
          name: 'TasksRepository',
          kind: 'class',
          isExported: true,
          line: 5,
          extendsName: 'BaseRepository',
        },
        { file: 'src/repo.ts', name: 'tasksRepository', kind: 'const', isExported: true, line: 10 },
        { file: 'src/svc.ts', name: 'TasksService', kind: 'class', isExported: true, line: 1 },
      ],
    };

    /**
     * Build the produced DB with the given relationship rows. Each row's
     * semanticReference is stored as the produced `semantic` value (the builder
     * does no validation), so this is the easiest way to inject a
     * 'PENDING_LLM_ANNOTATION' placeholder into a fake produced DB.
     */
    function buildWithRelationships(rows: GroundTruth['relationships']): void {
      buildGroundTruthDb(producedDb, { ...baseFixture, relationships: rows });
    }

    it('passes when every GT relationship is present with matching type and approved prose', async () => {
      buildWithRelationships([
        {
          fromDef: defKey('src/repo.ts', 'TasksRepository'),
          toDef: defKey('src/repo.ts', 'BaseRepository'),
          relationshipType: 'extends',
          semanticReference: 'TasksRepository inherits from BaseRepository.',
        },
        {
          fromDef: defKey('src/svc.ts', 'TasksService'),
          toDef: defKey('src/repo.ts', 'tasksRepository'),
          relationshipType: 'uses',
          semanticReference: 'Calls the repository to read and write tasks.',
        },
      ]);

      const judge = stubJudge({
        'TasksRepository inherits from BaseRepository.|TasksRepository inherits from BaseRepository.': 0.95,
        'Calls the repository to read and write tasks.|Calls the repository to read and write tasks.': 0.9,
      });

      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/repo.ts', 'TasksRepository'),
            toDef: defKey('src/repo.ts', 'BaseRepository'),
            relationshipType: 'extends',
            semanticReference: 'TasksRepository inherits from BaseRepository.',
          },
          {
            fromDef: defKey('src/svc.ts', 'TasksService'),
            toDef: defKey('src/repo.ts', 'tasksRepository'),
            relationshipType: 'uses',
            semanticReference: 'Calls the repository to read and write tasks.',
          },
        ],
      };

      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, judge);
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      expect(diff.proseChecks).toEqual({ passed: 2, failed: 0 });
    });

    it('reports critical when a GT relationship is missing in produced', async () => {
      // Build only the inheritance edge — the "uses" edge is missing.
      buildWithRelationships([
        {
          fromDef: defKey('src/repo.ts', 'TasksRepository'),
          toDef: defKey('src/repo.ts', 'BaseRepository'),
          relationshipType: 'extends',
          semanticReference: 'inherits',
        },
      ]);

      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/repo.ts', 'TasksRepository'),
            toDef: defKey('src/repo.ts', 'BaseRepository'),
            relationshipType: 'extends',
            semanticReference: 'inherits',
          },
          {
            fromDef: defKey('src/svc.ts', 'TasksService'),
            toDef: defKey('src/repo.ts', 'tasksRepository'),
            relationshipType: 'uses',
            semanticReference: 'calls',
          },
        ],
      };

      const judge = stubJudge({ 'inherits|inherits': 0.95 });
      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, judge);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'critical',
          naturalKey: 'src/svc.ts::TasksService->src/repo.ts::tasksRepository',
        }),
      ]);
    });

    it('reports critical when GT references a definition that does not exist in produced', async () => {
      buildWithRelationships([]);

      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/missing.ts', 'Ghost'),
            toDef: defKey('src/repo.ts', 'BaseRepository'),
            relationshipType: 'extends',
            semanticReference: 'should not match anything',
          },
        ],
      };

      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, stubJudge({}));
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'missing',
          severity: 'critical',
          naturalKey: expect.stringContaining('src/missing.ts::Ghost'),
        }),
      ]);
    });

    it('reports major when relationship_type differs (extends vs uses)', async () => {
      // Builder uses set() with 'uses', so we need to bypass the inheritance-stickiness
      // by writing the row directly. Easiest path: build via the GT helper but
      // pass relationshipType:'uses' so the produced row stores 'uses' for an
      // edge GT expects to be 'extends'.
      buildWithRelationships([
        {
          fromDef: defKey('src/repo.ts', 'TasksRepository'),
          toDef: defKey('src/repo.ts', 'BaseRepository'),
          relationshipType: 'uses', // ← wrong type
          semanticReference: 'TasksRepository uses BaseRepository.',
        },
      ]);

      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/repo.ts', 'TasksRepository'),
            toDef: defKey('src/repo.ts', 'BaseRepository'),
            relationshipType: 'extends', // ← GT says extends
            semanticReference: 'TasksRepository inherits from BaseRepository.',
          },
        ],
      };

      const judge = stubJudge({
        'TasksRepository inherits from BaseRepository.|TasksRepository uses BaseRepository.': 0.9,
      });
      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, judge);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'mismatch',
            severity: 'major',
            naturalKey: 'src/repo.ts::TasksRepository->src/repo.ts::BaseRepository',
            details: expect.stringContaining('relationship_type'),
          }),
        ])
      );
    });

    it('reports major when produced semantic equals PENDING_LLM_ANNOTATION', async () => {
      // The placeholder semantic is what parse-time inheritance edges start as
      // before the relationships LLM stage replaces them. If the LLM drops the
      // edge, the placeholder leaks through — this is exactly the bug class
      // iteration 3 wants to catch.
      buildWithRelationships([
        {
          fromDef: defKey('src/repo.ts', 'TasksRepository'),
          toDef: defKey('src/repo.ts', 'BaseRepository'),
          relationshipType: 'extends',
          semanticReference: 'PENDING_LLM_ANNOTATION',
        },
      ]);

      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/repo.ts', 'TasksRepository'),
            toDef: defKey('src/repo.ts', 'BaseRepository'),
            relationshipType: 'extends',
            semanticReference: 'TasksRepository inherits from BaseRepository.',
          },
        ],
      };

      // Even if the judge would happily approve the placeholder, the comparator
      // should refuse to forward to the judge and report a major diff first.
      const generousJudge = stubJudge({
        'TasksRepository inherits from BaseRepository.|PENDING_LLM_ANNOTATION': 1.0,
      });
      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, generousJudge);
      expect(diff.passed).toBe(false);
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'mismatch',
          severity: 'major',
          naturalKey: 'src/repo.ts::TasksRepository->src/repo.ts::BaseRepository',
          details: expect.stringContaining('PENDING_LLM_ANNOTATION'),
        }),
      ]);
      // The placeholder must NOT have been counted as a passed prose check.
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 0 });
    });

    it('records prose-drift minor diff when judge score < threshold', async () => {
      buildWithRelationships([
        {
          fromDef: defKey('src/svc.ts', 'TasksService'),
          toDef: defKey('src/repo.ts', 'tasksRepository'),
          relationshipType: 'uses',
          semanticReference: 'Sends marketing emails.',
        },
      ]);

      const reference = 'Reads and writes tasks via the repository.';
      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/svc.ts', 'TasksService'),
            toDef: defKey('src/repo.ts', 'tasksRepository'),
            relationshipType: 'uses',
            semanticReference: reference,
            minSimilarity: 0.75,
          },
        ],
      };

      const judge = stubJudge({ [`${reference}|Sends marketing emails.`]: 0.2 });
      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, judge);

      expect(diff.passed).toBe(true); // minor only
      expect(diff.diffs).toEqual([
        expect.objectContaining({
          kind: 'prose-drift',
          severity: 'minor',
          naturalKey: 'src/svc.ts::TasksService->src/repo.ts::tasksRepository',
        }),
      ]);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 1 });
    });

    it('bumps proseChecks.passed when judge approves and produces no diff', async () => {
      buildWithRelationships([
        {
          fromDef: defKey('src/svc.ts', 'TasksService'),
          toDef: defKey('src/repo.ts', 'tasksRepository'),
          relationshipType: 'uses',
          semanticReference: 'Reads and writes tasks via the repository.',
        },
      ]);

      const reference = 'Reads and writes tasks via the repository.';
      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/svc.ts', 'TasksService'),
            toDef: defKey('src/repo.ts', 'tasksRepository'),
            relationshipType: 'uses',
            semanticReference: reference,
          },
        ],
      };

      const judge = stubJudge({ [`${reference}|Reads and writes tasks via the repository.`]: 0.95 });
      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, judge);

      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      expect(diff.proseChecks).toEqual({ passed: 1, failed: 0 });
    });

    it('ignores extra produced relationships not declared in ground truth', async () => {
      // Produced has an extra "uses" edge the GT does not enumerate. The eval
      // should NOT flag this — the GT is an existence claim ("at least these
      // edges exist"), not a strict-equality claim. Symbols stage routinely
      // produces more edges than we manually catalog.
      buildWithRelationships([
        {
          fromDef: defKey('src/repo.ts', 'TasksRepository'),
          toDef: defKey('src/repo.ts', 'BaseRepository'),
          relationshipType: 'extends',
          semanticReference: 'inherits',
        },
        {
          fromDef: defKey('src/svc.ts', 'TasksService'),
          toDef: defKey('src/repo.ts', 'tasksRepository'),
          relationshipType: 'uses',
          semanticReference: 'extra-not-in-gt',
        },
      ]);

      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/repo.ts', 'TasksRepository'),
            toDef: defKey('src/repo.ts', 'BaseRepository'),
            relationshipType: 'extends',
            semanticReference: 'inherits',
          },
        ],
      };

      const judge = stubJudge({ 'inherits|inherits': 0.95 });
      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, judge);
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      // expectedCount counts the GT, producedCount counts everything in the table.
      expect(diff.expectedCount).toBe(1);
      expect(diff.producedCount).toBe(2);
    });

    it('uses default min similarity 0.75 when not specified', async () => {
      buildWithRelationships([
        {
          fromDef: defKey('src/svc.ts', 'TasksService'),
          toDef: defKey('src/repo.ts', 'tasksRepository'),
          relationshipType: 'uses',
          semanticReference: 'cand',
        },
      ]);
      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/svc.ts', 'TasksService'),
            toDef: defKey('src/repo.ts', 'tasksRepository'),
            relationshipType: 'uses',
            semanticReference: 'ref',
            // no minSimilarity → default 0.75
          },
        ],
      };
      const judge = stubJudge({ 'ref|cand': 0.74 });
      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, judge);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 1 });
    });

    it('skips judge call when GT entry has no semanticReference (existence-only check)', async () => {
      buildWithRelationships([
        {
          fromDef: defKey('src/repo.ts', 'TasksRepository'),
          toDef: defKey('src/repo.ts', 'BaseRepository'),
          relationshipType: 'extends',
          semanticReference: 'whatever the LLM said',
        },
      ]);
      const expectedGt: GroundTruth = {
        ...baseFixture,
        relationships: [
          {
            fromDef: defKey('src/repo.ts', 'TasksRepository'),
            toDef: defKey('src/repo.ts', 'BaseRepository'),
            relationshipType: 'extends',
            // no semanticReference → existence + type only
          },
        ],
      };
      // A judge that throws if called — proves we never invoked it.
      const judge: ProseJudgeFn = async () => {
        throw new Error('judge should not be called when there is no semanticReference');
      };
      const diff = await compareRelationshipAnnotations(producedDb, expectedGt, judge);
      expect(diff.passed).toBe(true);
      expect(diff.diffs).toHaveLength(0);
      expect(diff.proseChecks).toEqual({ passed: 0, failed: 0 });
    });
  });
});
