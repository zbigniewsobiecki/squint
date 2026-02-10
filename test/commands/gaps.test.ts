import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('gaps command', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;

  // Definition IDs
  let validateTokenId: number;
  let hashPasswordId: number;
  let getUserId: number;
  let createUserId: number;
  let helperFnId: number;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-gaps-test-'));
    dbPath = path.join(testDir, 'test.db');

    db = new IndexDatabase(dbPath);
    db.initialize();

    const authFileId = db.files.insert({
      path: 'src/auth.ts',
      language: 'typescript',
      contentHash: computeHash('auth content'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const userFileId = db.files.insert({
      path: 'src/user.ts',
      language: 'typescript',
      contentHash: computeHash('user content'),
      sizeBytes: 150,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const helperFileId = db.files.insert({
      path: 'src/helpers.ts',
      language: 'typescript',
      contentHash: computeHash('helper content'),
      sizeBytes: 80,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    validateTokenId = db.files.insertDefinition(authFileId, {
      name: 'validateToken',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    hashPasswordId = db.files.insertDefinition(authFileId, {
      name: 'hashPassword',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 6, column: 0 },
      endPosition: { row: 10, column: 1 },
    });

    getUserId = db.files.insertDefinition(userFileId, {
      name: 'getUser',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    createUserId = db.files.insertDefinition(userFileId, {
      name: 'UserService',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 6, column: 0 },
      endPosition: { row: 15, column: 1 },
    });

    helperFnId = db.files.insertDefinition(helperFileId, {
      name: 'helperFn',
      kind: 'function',
      isExported: false,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 3, column: 1 },
    });

    // Annotate some symbols (leave some unannotated)
    db.metadata.set(validateTokenId, 'purpose', 'Validates JWT tokens');
    db.metadata.set(validateTokenId, 'domain', '["auth"]');
    db.metadata.set(hashPasswordId, 'purpose', 'Hashes passwords');

    // Create modules — assign only some symbols
    const rootId = db.modules.ensureRoot();
    const authModuleId = db.modules.insert(rootId, 'auth', 'Auth', 'Authentication logic');
    const emptyModuleId = db.modules.insert(rootId, 'empty', 'Empty Module', 'No members');

    db.modules.assignSymbol(validateTokenId, authModuleId);
    db.modules.assignSymbol(hashPasswordId, authModuleId);

    db.close();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function runCommand(args: string): string {
    const binPath = path.join(process.cwd(), 'bin', 'dev.js');
    try {
      return execSync(`node ${binPath} ${args}`, {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      return err.stdout || err.stderr || err.message;
    }
  }

  describe('default (all sections)', () => {
    it('shows all four sections', () => {
      const output = runCommand(`gaps -d ${dbPath}`);
      expect(output).toContain('Unannotated Symbols');
      expect(output).toContain('Unannotated Relationships');
      expect(output).toContain('Empty Modules');
      expect(output).toContain('Unassigned Symbols');
    });

    it('shows unannotated symbol count', () => {
      const output = runCommand(`gaps -d ${dbPath}`);
      // 3 out of 5 symbols have no metadata at all (getUser, UserService, helperFn)
      expect(output).toContain('Unannotated Symbols (3 / 5)');
    });

    it('lists unannotated symbols by name', () => {
      const output = runCommand(`gaps -d ${dbPath}`);
      expect(output).toContain('getUser');
      expect(output).toContain('UserService');
      expect(output).toContain('helperFn');
      // Annotated symbols should NOT appear
      expect(output).not.toMatch(/^\s+validateToken/m);
    });

    it('shows unassigned symbols', () => {
      const output = runCommand(`gaps -d ${dbPath}`);
      // getUser, UserService, helperFn are not assigned to any module
      expect(output).toContain('Unassigned Symbols (3 / 5)');
      expect(output).toContain('getUser');
      expect(output).toContain('helperFn');
    });

    it('shows empty modules', () => {
      const output = runCommand(`gaps -d ${dbPath}`);
      // project root and "empty" module have no direct members
      expect(output).toContain('Empty Modules');
      expect(output).toContain('project.empty');
    });
  });

  describe('--type filter', () => {
    it('shows only symbols section with --type symbols', () => {
      const output = runCommand(`gaps -d ${dbPath} --type symbols`);
      expect(output).toContain('Unannotated Symbols');
      expect(output).not.toContain('Unannotated Relationships');
      expect(output).not.toContain('Empty Modules');
      expect(output).not.toContain('Unassigned Symbols');
    });

    it('shows only modules section with --type modules', () => {
      const output = runCommand(`gaps -d ${dbPath} --type modules`);
      expect(output).toContain('Empty Modules');
      expect(output).not.toContain('Unannotated Symbols');
      expect(output).not.toContain('Unassigned Symbols');
    });

    it('shows only unassigned section with --type unassigned', () => {
      const output = runCommand(`gaps -d ${dbPath} --type unassigned`);
      expect(output).toContain('Unassigned Symbols');
      expect(output).not.toContain('Unannotated Symbols (');
      expect(output).not.toContain('Empty Modules');
    });

    it('shows only relationships section with --type relationships', () => {
      const output = runCommand(`gaps -d ${dbPath} --type relationships`);
      expect(output).toContain('Unannotated Relationships');
      expect(output).not.toContain('Unannotated Symbols');
      expect(output).not.toContain('Empty Modules');
    });
  });

  describe('--limit', () => {
    it('respects limit on unannotated symbols', () => {
      const output = runCommand(`gaps -d ${dbPath} --type symbols --limit 1`);
      expect(output).toContain('Unannotated Symbols (3 / 5)');
      expect(output).toContain('2 more');
    });

    it('respects limit on unassigned symbols', () => {
      const output = runCommand(`gaps -d ${dbPath} --type unassigned --limit 2`);
      expect(output).toContain('1 more');
    });

    it('respects limit on empty modules', () => {
      const output = runCommand(`gaps -d ${dbPath} --type modules --limit 1`);
      expect(output).toContain('more');
    });
  });

  describe('--kind filter', () => {
    it('filters unannotated symbols by kind', () => {
      const output = runCommand(`gaps -d ${dbPath} --type symbols --kind class`);
      // Only UserService is an unannotated class
      expect(output).toContain('Unannotated Symbols (1 / 5)');
      expect(output).toContain('UserService');
      expect(output).not.toContain('getUser');
      expect(output).not.toContain('helperFn');
    });

    it('filters unassigned symbols by kind', () => {
      const output = runCommand(`gaps -d ${dbPath} --type unassigned --kind class`);
      expect(output).toContain('Unassigned Symbols (1 / 5)');
      expect(output).toContain('UserService');
      expect(output).not.toContain('getUser');
    });
  });

  describe('--json', () => {
    it('outputs valid JSON with all sections', () => {
      const output = runCommand(`gaps -d ${dbPath} --json`);
      const json = JSON.parse(output);
      expect(json.unannotatedSymbols).toBeDefined();
      expect(json.unannotatedRelationships).toBeDefined();
      expect(json.emptyModules).toBeDefined();
      expect(json.unassignedSymbols).toBeDefined();
    });

    it('includes correct totals in JSON', () => {
      const output = runCommand(`gaps -d ${dbPath} --json`);
      const json = JSON.parse(output);
      expect(json.unannotatedSymbols.total).toBe(3);
      expect(json.unannotatedSymbols.shown).toBe(3);
      expect(json.unannotatedSymbols.items).toHaveLength(3);
    });

    it('includes item details in JSON', () => {
      const output = runCommand(`gaps -d ${dbPath} --json`);
      const json = JSON.parse(output);
      const names = json.unannotatedSymbols.items.map((i: { name: string }) => i.name);
      expect(names).toContain('getUser');
      expect(names).toContain('UserService');
      expect(names).toContain('helperFn');
    });

    it('outputs only requested type in JSON', () => {
      const output = runCommand(`gaps -d ${dbPath} --json --type symbols`);
      const json = JSON.parse(output);
      expect(json.unannotatedSymbols).toBeDefined();
      expect(json.unannotatedRelationships).toBeUndefined();
      expect(json.emptyModules).toBeUndefined();
      expect(json.unassignedSymbols).toBeUndefined();
    });

    it('respects limit in JSON output', () => {
      const output = runCommand(`gaps -d ${dbPath} --json --type symbols --limit 1`);
      const json = JSON.parse(output);
      expect(json.unannotatedSymbols.total).toBe(3);
      expect(json.unannotatedSymbols.shown).toBe(1);
      expect(json.unannotatedSymbols.items).toHaveLength(1);
    });
  });

  describe('fully annotated database', () => {
    it('shows green messages when everything is annotated', () => {
      // Annotate all remaining symbols
      const setupDb = new IndexDatabase(dbPath);
      setupDb.metadata.set(getUserId, 'purpose', 'Gets a user');
      setupDb.metadata.set(createUserId, 'purpose', 'User service class');
      setupDb.metadata.set(helperFnId, 'purpose', 'Helper function');
      setupDb.close();

      const output = runCommand(`gaps -d ${dbPath} --type symbols`);
      expect(output).toContain('All symbols annotated');
    });
  });
});
