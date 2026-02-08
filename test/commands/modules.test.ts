import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('modules commands', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-modules-test-'));
    dbPath = path.join(testDir, 'test.db');

    // Create and populate test database
    db = new IndexDatabase(dbPath);
    db.initialize();

    // Insert test files and definitions
    const authFileId = db.insertFile({
      path: path.join(testDir, 'auth.ts'),
      language: 'typescript',
      contentHash: computeHash('auth content'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const userFileId = db.insertFile({
      path: path.join(testDir, 'user.ts'),
      language: 'typescript',
      contentHash: computeHash('user content'),
      sizeBytes: 150,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    // Auth module definitions
    const validateTokenId = db.insertDefinition(authFileId, {
      name: 'validateToken',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    const hashPasswordId = db.insertDefinition(authFileId, {
      name: 'hashPassword',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 6, column: 0 },
      endPosition: { row: 10, column: 1 },
    });

    const authServiceId = db.insertDefinition(authFileId, {
      name: 'AuthService',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 11, column: 0 },
      endPosition: { row: 25, column: 1 },
    });

    // User module definitions
    const getUserId = db.insertDefinition(userFileId, {
      name: 'getUser',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    const createUserId = db.insertDefinition(userFileId, {
      name: 'createUser',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 6, column: 0 },
      endPosition: { row: 15, column: 1 },
    });

    // Create modules
    const authModuleId = db.insertModule('auth', {
      description: 'Authentication and authorization logic',
      layer: 'service',
      subsystem: 'security',
    });

    const userModuleId = db.insertModule('user-api', {
      description: 'User management endpoints',
      layer: 'controller',
      subsystem: 'user-management',
    });

    // Add members to modules
    db.addModuleMember(authModuleId, validateTokenId, 0.95);
    db.addModuleMember(authModuleId, hashPasswordId, 0.90);
    db.addModuleMember(authModuleId, authServiceId, 0.85);
    db.addModuleMember(userModuleId, getUserId, 0.88);
    db.addModuleMember(userModuleId, createUserId, 0.92);

    db.close();
  });

  afterEach(() => {
    // Clean up test directory
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

  describe('modules list', () => {
    it('lists all modules with member counts', () => {
      const output = runCommand(`modules -d ${dbPath}`);
      expect(output).toContain('Modules');
      expect(output).toContain('auth');
      expect(output).toContain('user-api');
      expect(output).toContain('service');
      expect(output).toContain('controller');
    });

    it('shows total member count', () => {
      const output = runCommand(`modules -d ${dbPath}`);
      expect(output).toContain('5 members');
    });

    it('filters by layer', () => {
      const output = runCommand(`modules --layer service -d ${dbPath}`);
      expect(output).toContain('auth');
      expect(output).not.toContain('user-api');
    });

    it('shows no modules message when empty', () => {
      // Create empty database
      const emptyDbPath = path.join(testDir, 'empty.db');
      const emptyDb = new IndexDatabase(emptyDbPath);
      emptyDb.initialize();
      emptyDb.close();

      const output = runCommand(`modules -d ${emptyDbPath}`);
      expect(output).toContain('No modules found');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`modules --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.modules).toBeDefined();
      expect(json.modules).toHaveLength(2);
      expect(json.stats).toBeDefined();
      expect(json.stats.moduleCount).toBe(2);
      expect(json.stats.memberCount).toBe(5);
    });

    it('includes module descriptions in JSON output', () => {
      const output = runCommand(`modules --json -d ${dbPath}`);
      const json = JSON.parse(output);
      const authModule = json.modules.find((m: { name: string }) => m.name === 'auth');
      expect(authModule.description).toBe('Authentication and authorization logic');
      expect(authModule.layer).toBe('service');
    });
  });

  describe('modules show', () => {
    it('shows module details', () => {
      const output = runCommand(`modules show auth -d ${dbPath}`);
      expect(output).toContain('Module: auth');
      expect(output).toContain('Layer: service');
      expect(output).toContain('Authentication and authorization logic');
    });

    it('lists all members', () => {
      const output = runCommand(`modules show auth -d ${dbPath}`);
      expect(output).toContain('Members (3)');
      expect(output).toContain('validateToken');
      expect(output).toContain('hashPassword');
      expect(output).toContain('AuthService');
    });

    it('shows member kinds', () => {
      const output = runCommand(`modules show auth -d ${dbPath}`);
      expect(output).toContain('function');
      expect(output).toContain('class');
    });

    it('shows file paths for members', () => {
      const output = runCommand(`modules show auth -d ${dbPath}`);
      expect(output).toContain('auth.ts');
    });

    it('handles partial name match', () => {
      const output = runCommand(`modules show user -d ${dbPath}`);
      expect(output).toContain('Module: user-api');
      expect(output).toContain('getUser');
      expect(output).toContain('createUser');
    });

    it('shows disambiguation for multiple matches', () => {
      // Add another module with 'user' in the name
      const setupDb = new IndexDatabase(dbPath);
      setupDb.insertModule('user-service', { layer: 'service' });
      setupDb.close();

      const output = runCommand(`modules show user -d ${dbPath}`);
      expect(output).toContain('Multiple modules match');
      expect(output).toContain('user-api');
      expect(output).toContain('user-service');
    });

    it('reports error for non-existent module', () => {
      const output = runCommand(`modules show nonexistent -d ${dbPath}`);
      expect(output).toContain('not found');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`modules show auth --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.name).toBe('auth');
      expect(json.layer).toBe('service');
      expect(json.description).toBe('Authentication and authorization logic');
      expect(json.members).toHaveLength(3);
      expect(json.members[0].name).toBeDefined();
      expect(json.members[0].kind).toBeDefined();
    });
  });
});
