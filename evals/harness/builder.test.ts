import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database-facade.js';
import { buildGroundTruthDb } from './builder.js';
import { type GroundTruth, defKey } from './types.js';

/**
 * The builder takes a GroundTruth and populates a fresh IndexDatabase.
 * Tests verify it correctly maps natural-key inputs to the live schema
 * (so the comparator has two databases — produced and ground-truth — to diff).
 */
describe('builder', () => {
  let dbPath: string;
  let db: IndexDatabase;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-eval-build-'));
    dbPath = path.join(dir, 'gt.db');
    db = new IndexDatabase(dbPath);
    db.initialize();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('inserts files', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [
        { path: 'src/index.ts', language: 'typescript' },
        { path: 'src/util.ts', language: 'typescript' },
      ],
      definitions: [],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const rows = conn.prepare('SELECT path, language FROM files ORDER BY path').all() as Array<{
      path: string;
      language: string;
    }>;
    expect(rows).toEqual([
      { path: 'src/index.ts', language: 'typescript' },
      { path: 'src/util.ts', language: 'typescript' },
    ]);
  });

  it('inserts definitions linked to their files', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [{ path: 'src/auth.ts', language: 'typescript' }],
      definitions: [
        {
          file: 'src/auth.ts',
          name: 'AuthService',
          kind: 'class',
          isExported: true,
          line: 5,
          extendsName: null,
        },
        {
          file: 'src/auth.ts',
          name: 'login',
          kind: 'function',
          isExported: true,
          line: 12,
        },
      ],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const rows = conn
      .prepare(
        `SELECT d.name AS name, d.kind AS kind, d.line AS line, f.path AS path
         FROM definitions d JOIN files f ON d.file_id = f.id
         ORDER BY d.line`
      )
      .all() as Array<{ name: string; kind: string; line: number; path: string }>;
    expect(rows).toEqual([
      { name: 'AuthService', kind: 'class', line: 5, path: 'src/auth.ts' },
      { name: 'login', kind: 'function', line: 12, path: 'src/auth.ts' },
    ]);
  });

  it('preserves extendsName on classes', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [
        { path: 'src/base.ts', language: 'typescript' },
        { path: 'src/child.ts', language: 'typescript' },
      ],
      definitions: [
        { file: 'src/base.ts', name: 'Base', kind: 'class', isExported: true, line: 1 },
        {
          file: 'src/child.ts',
          name: 'Child',
          kind: 'class',
          isExported: true,
          line: 1,
          extendsName: 'Base',
        },
      ],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const row = conn.prepare('SELECT extends_name FROM definitions WHERE name = ?').get('Child') as {
      extends_name: string;
    };
    expect(row.extends_name).toBe('Base');
  });

  it('throws if a definition references a missing file', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [{ path: 'src/a.ts', language: 'typescript' }],
      definitions: [{ file: 'src/missing.ts', name: 'Foo', kind: 'function', isExported: true, line: 1 }],
    };
    expect(() => buildGroundTruthDb(db, gt)).toThrow(/missing\.ts/);
  });

  it('inserts imports with their type and source', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
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
          isExternal: false,
          symbols: [{ name: 'helper', kind: 'named' }],
        },
      ],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const importRow = conn
      .prepare(
        `SELECT i.source AS source, i.type AS type, f.path AS fromPath, i.is_external AS isExternal,
                t.path AS toPath
         FROM imports i
         JOIN files f ON i.from_file_id = f.id
         LEFT JOIN files t ON i.to_file_id = t.id`
      )
      .get() as { source: string; type: string; fromPath: string; isExternal: number; toPath: string | null };
    expect(importRow).toEqual({
      source: './b.js',
      type: 'import',
      fromPath: 'src/a.ts',
      isExternal: 0,
      // CRITICAL: relative imports must resolve to_file_id correctly. './b.js' from
      // 'src/a.ts' should resolve to 'src/b.ts' (extension swap, same directory).
      toPath: 'src/b.ts',
    });

    const symRow = conn
      .prepare(
        `SELECT s.name, s.local_name as localName, s.kind, d.name AS defName
         FROM symbols s LEFT JOIN definitions d ON s.definition_id = d.id`
      )
      .get() as { name: string; localName: string; kind: string; defName: string | null };
    expect(symRow).toEqual({
      name: 'helper',
      localName: 'helper',
      kind: 'named',
      // CRITICAL: imported symbol must link to the actual exported definition in the target file.
      defName: 'helper',
    });
  });

  it('resolves parent-directory relative imports (../foo.js)', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [
        { path: 'src/types.ts', language: 'typescript' },
        { path: 'src/services/auth.ts', language: 'typescript' },
      ],
      definitions: [{ file: 'src/types.ts', name: 'User', kind: 'interface', isExported: true, line: 1 }],
      imports: [
        {
          fromFile: 'src/services/auth.ts',
          source: '../types.js',
          type: 'import',
          isTypeOnly: true,
          symbols: [{ name: 'User', kind: 'named' }],
        },
      ],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const row = conn.prepare('SELECT t.path AS toPath FROM imports i JOIN files t ON i.to_file_id = t.id').get() as {
      toPath: string;
    };
    expect(row.toPath).toBe('src/types.ts');
  });

  it('resolves index file imports (./folder.js → ./folder/index.ts)', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [
        { path: 'src/index.ts', language: 'typescript' },
        { path: 'lib/index.ts', language: 'typescript' },
      ],
      definitions: [{ file: 'lib/index.ts', name: 'thing', kind: 'function', isExported: true, line: 1 }],
      imports: [
        {
          fromFile: 'src/index.ts',
          source: '../lib/index.js',
          type: 'import',
          symbols: [{ name: 'thing', kind: 'named' }],
        },
      ],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const row = conn.prepare('SELECT t.path AS toPath FROM imports i JOIN files t ON i.to_file_id = t.id').get() as {
      toPath: string;
    };
    expect(row.toPath).toBe('lib/index.ts');
  });

  it('leaves to_file_id NULL for external (package) imports', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [{ path: 'src/a.ts', language: 'typescript' }],
      definitions: [],
      imports: [
        {
          fromFile: 'src/a.ts',
          source: 'express',
          type: 'import',
          isExternal: true,
          symbols: [{ name: 'Router', kind: 'named' }],
        },
      ],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const row = conn.prepare('SELECT to_file_id FROM imports').get() as { to_file_id: number | null };
    expect(row.to_file_id).toBeNull();
  });

  it('inserts modules under a project root and assigns members', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
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
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const moduleRow = conn
      .prepare('SELECT full_path AS fullPath, name FROM modules WHERE full_path = ?')
      .get('project.services.auth') as { fullPath: string; name: string };
    expect(moduleRow).toEqual({ fullPath: 'project.services.auth', name: 'Auth' });

    // Intermediate ancestors get auto-created
    const ancestorPaths = conn.prepare('SELECT full_path FROM modules ORDER BY depth').all() as Array<{
      full_path: string;
    }>;
    expect(ancestorPaths.map((r) => r.full_path)).toEqual(['project', 'project.services', 'project.services.auth']);

    const memberRow = conn
      .prepare(
        `SELECT m.full_path AS modulePath, d.name AS defName
         FROM module_members mm
         JOIN modules m ON mm.module_id = m.id
         JOIN definitions d ON mm.definition_id = d.id`
      )
      .get() as { modulePath: string; defName: string };
    expect(memberRow).toEqual({ modulePath: 'project.services.auth', defName: 'AuthService' });
  });

  it('inserts contracts and participants', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [
        { path: 'src/auth.controller.ts', language: 'typescript' },
        { path: 'client/auth.client.ts', language: 'typescript' },
      ],
      definitions: [
        { file: 'src/auth.controller.ts', name: 'login', kind: 'function', isExported: true, line: 1 },
        { file: 'client/auth.client.ts', name: 'login', kind: 'function', isExported: true, line: 1 },
      ],
      contracts: [
        {
          protocol: 'http',
          normalizedKey: 'POST /api/auth/login',
          participants: [
            { defKey: defKey('src/auth.controller.ts', 'login'), role: 'server' },
            { defKey: defKey('client/auth.client.ts', 'login'), role: 'client' },
          ],
        },
      ],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const contract = conn.prepare('SELECT protocol, normalized_key as normalizedKey FROM contracts').get() as {
      protocol: string;
      normalizedKey: string;
    };
    expect(contract).toEqual({ protocol: 'http', normalizedKey: 'POST /api/auth/login' });

    const participants = conn
      .prepare(
        `SELECT cp.role, f.path || '::' || d.name AS defKey
         FROM contract_participants cp
         JOIN definitions d ON cp.definition_id = d.id
         JOIN files f ON d.file_id = f.id
         ORDER BY cp.role`
      )
      .all() as Array<{ role: string; defKey: string }>;
    expect(participants).toEqual([
      { role: 'client', defKey: 'client/auth.client.ts::login' },
      { role: 'server', defKey: 'src/auth.controller.ts::login' },
    ]);
  });

  it('inserts interactions between modules', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [
        { path: 'src/c.ts', language: 'typescript' },
        { path: 'src/s.ts', language: 'typescript' },
      ],
      definitions: [
        { file: 'src/c.ts', name: 'ctrl', kind: 'function', isExported: true, line: 1 },
        { file: 'src/s.ts', name: 'svc', kind: 'function', isExported: true, line: 1 },
      ],
      modules: [
        { fullPath: 'project.controllers', name: 'Controllers', members: [defKey('src/c.ts', 'ctrl')] },
        { fullPath: 'project.services', name: 'Services', members: [defKey('src/s.ts', 'svc')] },
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
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const row = conn
      .prepare(
        `SELECT from_m.full_path AS fromPath, to_m.full_path AS toPath, i.pattern, i.source
         FROM interactions i
         JOIN modules from_m ON i.from_module_id = from_m.id
         JOIN modules to_m ON i.to_module_id = to_m.id`
      )
      .get() as { fromPath: string; toPath: string; pattern: string; source: string };
    expect(row).toEqual({
      fromPath: 'project.controllers',
      toPath: 'project.services',
      pattern: 'business',
      source: 'ast',
    });
  });

  it('inserts flows with ordered steps', () => {
    const gt: GroundTruth = {
      fixtureName: 'tiny',
      files: [
        { path: 'src/c.ts', language: 'typescript' },
        { path: 'src/s.ts', language: 'typescript' },
      ],
      definitions: [
        { file: 'src/c.ts', name: 'login', kind: 'function', isExported: true, line: 1 },
        { file: 'src/s.ts', name: 'auth', kind: 'function', isExported: true, line: 1 },
      ],
      modules: [
        { fullPath: 'project.controllers', name: 'Controllers', members: [defKey('src/c.ts', 'login')] },
        { fullPath: 'project.services', name: 'Services', members: [defKey('src/s.ts', 'auth')] },
      ],
      interactions: [
        {
          fromModulePath: 'project.controllers',
          toModulePath: 'project.services',
          pattern: 'business',
          source: 'ast',
        },
      ],
      flows: [
        {
          slug: 'user-login',
          name: 'User Login',
          stakeholder: 'user',
          entryDef: defKey('src/c.ts', 'login'),
          entryPath: 'POST /api/auth/login',
          steps: [{ from: 'project.controllers', to: 'project.services' }],
        },
      ],
    };
    buildGroundTruthDb(db, gt);

    const conn = db.getConnection();
    const flow = conn.prepare('SELECT slug, name, stakeholder, entry_path AS entryPath FROM flows').get() as {
      slug: string;
      name: string;
      stakeholder: string;
      entryPath: string;
    };
    expect(flow).toEqual({
      slug: 'user-login',
      name: 'User Login',
      stakeholder: 'user',
      entryPath: 'POST /api/auth/login',
    });

    const steps = conn
      .prepare(
        `SELECT fs.step_order AS stepOrder, from_m.full_path AS fromPath, to_m.full_path AS toPath
         FROM flow_steps fs
         JOIN interactions i ON fs.interaction_id = i.id
         JOIN modules from_m ON i.from_module_id = from_m.id
         JOIN modules to_m ON i.to_module_id = to_m.id
         ORDER BY fs.step_order`
      )
      .all() as Array<{ stepOrder: number; fromPath: string; toPath: string }>;
    expect(steps).toEqual([{ stepOrder: 1, fromPath: 'project.controllers', toPath: 'project.services' }]);
  });
});
