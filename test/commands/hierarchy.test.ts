import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('hierarchy command', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;
  let mainFileId: number;
  let baseControllerId: number;
  let userControllerId: number;
  let adminControllerId: number;
  let authControllerId: number;
  let serializableId: number;
  let userServiceId: number;
  let mainFunctionId: number;
  let helperFunctionId: number;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-hierarchy-test-'));
    dbPath = path.join(testDir, 'test.db');

    // Create and populate test database
    db = new IndexDatabase(dbPath);
    db.initialize();

    // Insert test files
    const controllersFileId = db.insertFile({
      path: path.join(testDir, 'controllers.ts'),
      language: 'typescript',
      contentHash: computeHash('controllers content'),
      sizeBytes: 500,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const servicesFileId = db.insertFile({
      path: path.join(testDir, 'services.ts'),
      language: 'typescript',
      contentHash: computeHash('services content'),
      sizeBytes: 400,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    mainFileId = db.insertFile({
      path: path.join(testDir, 'main.ts'),
      language: 'typescript',
      contentHash: computeHash('main content'),
      sizeBytes: 200,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    // Create class hierarchy for extends
    // BaseController <- UserController <- AdminController
    // BaseController <- AuthController
    baseControllerId = db.insertDefinition(controllersFileId, {
      name: 'BaseController',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    userControllerId = db.insertDefinition(controllersFileId, {
      name: 'UserController',
      kind: 'class',
      isExported: true,
      isDefault: false,
      extends: 'BaseController',
      position: { row: 25, column: 0 },
      endPosition: { row: 45, column: 1 },
    });

    adminControllerId = db.insertDefinition(controllersFileId, {
      name: 'AdminController',
      kind: 'class',
      isExported: true,
      isDefault: false,
      extends: 'UserController',
      position: { row: 50, column: 0 },
      endPosition: { row: 70, column: 1 },
    });

    authControllerId = db.insertDefinition(controllersFileId, {
      name: 'AuthController',
      kind: 'class',
      isExported: true,
      isDefault: false,
      extends: 'BaseController',
      position: { row: 75, column: 0 },
      endPosition: { row: 95, column: 1 },
    });

    // Create interface for implements
    serializableId = db.insertDefinition(servicesFileId, {
      name: 'Serializable',
      kind: 'interface',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    userServiceId = db.insertDefinition(servicesFileId, {
      name: 'UserService',
      kind: 'class',
      isExported: true,
      isDefault: false,
      implements: ['Serializable'],
      position: { row: 10, column: 0 },
      endPosition: { row: 40, column: 1 },
    });

    // Create functions for call hierarchy
    mainFunctionId = db.insertDefinition(mainFileId, {
      name: 'main',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    helperFunctionId = db.insertDefinition(mainFileId, {
      name: 'helper',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 25, column: 0 },
      endPosition: { row: 35, column: 1 },
    });

    // Create inheritance relationships in relationship_annotations
    db.createInheritanceRelationships();

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

  describe('hierarchy --type extends', () => {
    it('shows class inheritance tree', () => {
      const output = runCommand(`hierarchy -d ${dbPath}`);
      expect(output).toContain('Class Hierarchy (extends)');
      expect(output).toContain('BaseController');
    });

    it('shows parent-child relationships', () => {
      const output = runCommand(`hierarchy --type extends -d ${dbPath}`);
      expect(output).toContain('BaseController');
      expect(output).toContain('UserController');
      expect(output).toContain('AdminController');
      expect(output).toContain('AuthController');
    });

    it('shows tree structure with connectors', () => {
      const output = runCommand(`hierarchy -d ${dbPath}`);
      // Should have tree connectors
      expect(output).toMatch(/[├└]/);
    });

    it('shows no relationships message when empty', () => {
      const emptyDbPath = path.join(testDir, 'empty.db');
      const emptyDb = new IndexDatabase(emptyDbPath);
      emptyDb.initialize();
      emptyDb.close();

      const output = runCommand(`hierarchy -d ${emptyDbPath}`);
      expect(output).toContain('No extends relationships found');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`hierarchy --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.type).toBe('extends');
      expect(json.trees).toBeDefined();
      expect(json.totalNodes).toBeGreaterThan(0);
    });
  });

  describe('hierarchy --type implements', () => {
    it('shows interface implementations', () => {
      const output = runCommand(`hierarchy --type implements -d ${dbPath}`);
      expect(output).toContain('Interface Implementations');
    });

    it('shows implementing classes', () => {
      const output = runCommand(`hierarchy --type implements -d ${dbPath}`);
      expect(output).toContain('Serializable');
      expect(output).toContain('UserService');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`hierarchy --type implements --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.type).toBe('implements');
    });
  });

  describe('hierarchy --type calls', () => {
    beforeEach(() => {
      // Set up call graph edges
      const setupDb = new IndexDatabase(dbPath);

      // main calls helper - need to set up proper call relationship
      const refId = setupDb.insertReference(mainFileId, mainFileId, {
        type: 'import',
        source: './helper',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const helperSymbol = setupDb.insertSymbol(refId, helperFunctionId, {
        name: 'helper',
        localName: 'helper',
        kind: 'named',
        usages: [],
      });

      // Usage within main function's line range (row 0-20)
      setupDb.insertUsage(helperSymbol, {
        position: { row: 10, column: 10 },
        context: 'call_expression',
      });

      setupDb.close();
    });

    it('requires --root flag', () => {
      const output = runCommand(`hierarchy --type calls -d ${dbPath}`);
      expect(output).toContain('--root is required');
    });

    it('shows call hierarchy from root', () => {
      const output = runCommand(`hierarchy --type calls --root main -d ${dbPath}`);
      expect(output).toContain('Call Hierarchy from: main');
    });

    it('shows called functions', () => {
      const output = runCommand(`hierarchy --type calls --root main -d ${dbPath}`);
      expect(output).toContain('main');
      expect(output).toContain('helper');
    });

    it('respects --depth flag', () => {
      const output = runCommand(`hierarchy --type calls --root main --depth 1 -d ${dbPath}`);
      expect(output).toContain('max depth: 1');
    });

    it('reports error for non-existent root', () => {
      const output = runCommand(`hierarchy --type calls --root nonexistent -d ${dbPath}`);
      expect(output).toContain('No symbol found');
    });

    it('shows no calls message for leaf nodes', () => {
      const output = runCommand(`hierarchy --type calls --root helper -d ${dbPath}`);
      expect(output).toContain('No outgoing calls found');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`hierarchy --type calls --root main --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.type).toBe('calls');
      expect(json.root).toBeDefined();
      expect(json.root.name).toBe('main');
      expect(json.tree).toBeDefined();
    });
  });

  describe('hierarchy --type uses', () => {
    beforeEach(() => {
      // Add some relationship annotations
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setRelationshipAnnotation(userControllerId, userServiceId, 'uses for user operations', 'uses');
      setupDb.close();
    });

    it('shows uses relationships', () => {
      const output = runCommand(`hierarchy --type uses -d ${dbPath}`);
      expect(output).toContain('Uses Relationships');
    });

    it('shows relationship details', () => {
      const output = runCommand(`hierarchy --type uses -d ${dbPath}`);
      expect(output).toContain('UserController');
      expect(output).toContain('UserService');
    });

    it('shows no relationships message when empty', () => {
      const emptyDbPath = path.join(testDir, 'empty.db');
      const emptyDb = new IndexDatabase(emptyDbPath);
      emptyDb.initialize();
      emptyDb.close();

      const output = runCommand(`hierarchy --type uses -d ${emptyDbPath}`);
      expect(output).toContain('No uses relationships annotated');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`hierarchy --type uses --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.type).toBe('uses');
      expect(json.annotations).toBeDefined();
    });
  });

  describe('invalid type', () => {
    it('reports error for invalid type', () => {
      const output = runCommand(`hierarchy --type invalid -d ${dbPath}`);
      expect(output).toContain('Invalid type');
      expect(output).toContain('extends');
      expect(output).toContain('implements');
      expect(output).toContain('calls');
    });
  });
});
