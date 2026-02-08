import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('flows commands', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;
  let controllerFileId: number;
  let serviceFileId: number;
  let repoFileId: number;
  let controllerDefId: number;
  let serviceDefId: number;
  let repoDefId: number;
  let controllerModuleId: number;
  let serviceModuleId: number;
  let repoModuleId: number;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-flows-test-'));
    dbPath = path.join(testDir, 'test.db');

    // Create and populate test database
    db = new IndexDatabase(dbPath);
    db.initialize();

    // Insert test files
    controllerFileId = db.insertFile({
      path: path.join(testDir, 'controller.ts'),
      language: 'typescript',
      contentHash: computeHash('controller content'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    serviceFileId = db.insertFile({
      path: path.join(testDir, 'service.ts'),
      language: 'typescript',
      contentHash: computeHash('service content'),
      sizeBytes: 150,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    repoFileId = db.insertFile({
      path: path.join(testDir, 'repository.ts'),
      language: 'typescript',
      contentHash: computeHash('repo content'),
      sizeBytes: 120,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    // Create definitions for a typical flow
    controllerDefId = db.insertDefinition(controllerFileId, {
      name: 'handleRegister',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 10, column: 1 },
    });

    serviceDefId = db.insertDefinition(serviceFileId, {
      name: 'createUser',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 15, column: 1 },
    });

    repoDefId = db.insertDefinition(repoFileId, {
      name: 'insertUser',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 8, column: 1 },
    });

    // Create a second set of definitions for login flow
    const loginHandlerId = db.insertDefinition(controllerFileId, {
      name: 'handleLogin',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 20, column: 0 },
      endPosition: { row: 35, column: 1 },
    });

    const authServiceId = db.insertDefinition(serviceFileId, {
      name: 'authenticateUser',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 20, column: 0 },
      endPosition: { row: 30, column: 1 },
    });

    // Create module tree
    const rootId = db.ensureRootModule();

    controllerModuleId = db.insertModule(rootId, 'user-controller', 'User Controller', 'User API endpoints');
    serviceModuleId = db.insertModule(rootId, 'user-service', 'User Service', 'User business logic');
    repoModuleId = db.insertModule(rootId, 'user-repo', 'User Repository', 'User data access');

    // Assign symbols to modules
    db.assignSymbolToModule(controllerDefId, controllerModuleId);
    db.assignSymbolToModule(loginHandlerId, controllerModuleId);
    db.assignSymbolToModule(serviceDefId, serviceModuleId);
    db.assignSymbolToModule(authServiceId, serviceModuleId);
    db.assignSymbolToModule(repoDefId, repoModuleId);

    // Create hierarchical flows
    // Registration flow: controller -> service -> repo
    const registerFlow = db.ensureRootFlow('user-registration');
    db.updateFlow(registerFlow.id, {
      description: 'User registration flow',
      domain: 'user',
    });
    db.insertFlow(registerFlow.id, 'controller-to-service', 'Controller to Service', {
      fromModuleId: controllerModuleId,
      toModuleId: serviceModuleId,
      semantic: 'Controller validates and passes to service',
    });
    db.insertFlow(registerFlow.id, 'service-to-repo', 'Service to Repository', {
      fromModuleId: serviceModuleId,
      toModuleId: repoModuleId,
      semantic: 'Service persists user data',
    });

    // Login flow: controller -> service
    const loginFlow = db.ensureRootFlow('user-login');
    db.updateFlow(loginFlow.id, {
      description: 'User login flow',
      domain: 'auth',
    });
    db.insertFlow(loginFlow.id, 'controller-to-auth', 'Controller to Auth Service', {
      fromModuleId: controllerModuleId,
      toModuleId: serviceModuleId,
      semantic: 'Controller authenticates via service',
    });

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

  describe('flows list', () => {
    it('lists all flows', () => {
      const output = runCommand(`flows -d ${dbPath}`);
      expect(output).toContain('Flows');
      expect(output).toContain('user-registration');
      expect(output).toContain('user-login');
    });

    it('shows flow tree structure with --tree flag', () => {
      const output = runCommand(`flows --tree -d ${dbPath}`);
      expect(output).toContain('User Registration');
      expect(output).toContain('User Login');
    });

    it('shows leaf flows with --leaf flag', () => {
      const output = runCommand(`flows --leaf -d ${dbPath}`);
      expect(output).toContain('Leaf Flows');
      expect(output).toContain('Controller to Service');
      expect(output).toContain('Service to Repository');
    });

    it('filters by domain', () => {
      const output = runCommand(`flows --domain user -d ${dbPath}`);
      expect(output).toContain('user-registration');
      expect(output).not.toContain('user-login');
    });

    it('shows no flows message when empty', () => {
      const emptyDbPath = path.join(testDir, 'empty.db');
      const emptyDb = new IndexDatabase(emptyDbPath);
      emptyDb.initialize();
      emptyDb.close();

      const output = runCommand(`flows -d ${emptyDbPath}`);
      expect(output).toContain('No flows detected yet');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`flows --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.flows).toBeDefined();
      expect(json.flows.length).toBeGreaterThanOrEqual(2);
      expect(json.stats).toBeDefined();
      expect(json.stats.flowCount).toBeGreaterThanOrEqual(2);
    });

    it('shows leaf flow indicators in output', () => {
      const output = runCommand(`flows -d ${dbPath}`);
      // Leaf flows are marked with [leaf] indicator
      expect(output).toContain('[leaf]');
      expect(output).toContain('Controller to Service');
      expect(output).toContain('Service to Repository');
    });
  });

  describe('flows show', () => {
    it('shows flow details', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('Flow: User Registration');
      expect(output).toContain('user-registration');
    });

    it('shows flow description', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('User registration flow');
    });

    it('shows child flows (module transitions)', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('Controller to Service');
      expect(output).toContain('Service to Repository');
    });

    it('shows module transition details for leaf flows', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      // Modules are shown by their full path
      expect(output).toContain('user-controller');
      expect(output).toContain('user-service');
      expect(output).toContain('user-repo');
    });

    it('handles partial name match', () => {
      const output = runCommand(`flows show registration -d ${dbPath}`);
      expect(output).toContain('User Registration');
    });

    it('shows disambiguation for multiple matches', () => {
      // Both flows contain 'user-'
      const output = runCommand(`flows show user -d ${dbPath}`);
      expect(output).toContain('Multiple flows match');
      expect(output).toContain('user-registration');
      expect(output).toContain('user-login');
    });

    it('reports error for non-existent flow', () => {
      const output = runCommand(`flows show nonexistent -d ${dbPath}`);
      expect(output).toContain('not found');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`flows show user-registration --json -d ${dbPath}`);
      const json = JSON.parse(output);
      // Flow details are wrapped in a "flow" property
      expect(json.flow).toBeDefined();
      expect(json.flow.name).toBe('User Registration');
      expect(json.flow.slug).toBe('user-registration');
      expect(json.children).toBeDefined();
      expect(json.children.length).toBeGreaterThanOrEqual(2);
    });

    it('expands to leaf flows with --expand flag', () => {
      const output = runCommand(`flows show user-registration --expand -d ${dbPath}`);
      expect(output).toContain('Expanded');
      expect(output).toContain('leaf');
    });
  });

  describe('flows trace', () => {
    beforeEach(() => {
      // Set up call graph edges for tracing
      const setupDb = new IndexDatabase(dbPath);

      // Create symbols and usages to establish call graph
      // handleRegister calls createUser
      const refId1 = setupDb.insertReference(controllerFileId, serviceFileId, {
        type: 'import',
        source: './service',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const createUserSymbol = setupDb.insertSymbol(refId1, serviceDefId, {
        name: 'createUser',
        localName: 'createUser',
        kind: 'named',
        usages: [],
      });

      // Usage within handleRegister's line range (row 0-10)
      setupDb.insertUsage(createUserSymbol, {
        position: { row: 5, column: 10 },
        context: 'call_expression',
      });

      // createUser calls insertUser
      const refId2 = setupDb.insertReference(serviceFileId, repoFileId, {
        type: 'import',
        source: './repository',
        isExternal: false,
        isTypeOnly: false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      const insertUserSymbol = setupDb.insertSymbol(refId2, repoDefId, {
        name: 'insertUser',
        localName: 'insertUser',
        kind: 'named',
        usages: [],
      });

      // Usage within createUser's line range (row 0-15)
      setupDb.insertUsage(insertUserSymbol, {
        position: { row: 10, column: 10 },
        context: 'call_expression',
      });

      setupDb.close();
    });

    it('traces from a symbol by name', () => {
      const output = runCommand(`flows trace --name handleRegister -d ${dbPath}`);
      expect(output).toContain('Trace from: handleRegister');
    });

    it('traces from a symbol by ID', () => {
      const output = runCommand(`flows trace --id ${controllerDefId} -d ${dbPath}`);
      expect(output).toContain('Trace from: handleRegister');
    });

    it('shows trace depth', () => {
      const output = runCommand(`flows trace --name handleRegister -d ${dbPath}`);
      expect(output).toContain('nodes traced');
    });

    it('limits trace depth with --depth flag', () => {
      const output = runCommand(`flows trace --name handleRegister --depth 1 -d ${dbPath}`);
      expect(output).toContain('max depth: 1');
    });

    it('reports error when name not provided', () => {
      const output = runCommand(`flows trace -d ${dbPath}`);
      expect(output).toContain('Either provide --name or --id');
    });

    it('reports error for non-existent symbol', () => {
      const output = runCommand(`flows trace --name nonexistent -d ${dbPath}`);
      expect(output).toContain('No symbol found');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`flows trace --name handleRegister --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.entryPoint).toBeDefined();
      expect(json.entryPoint.name).toBe('handleRegister');
      expect(json.maxDepth).toBe(10);
      expect(json.trace).toBeDefined();
    });

    it('shows no calls message for leaf nodes', () => {
      const output = runCommand(`flows trace --name insertUser -d ${dbPath}`);
      expect(output).toContain('No outgoing calls found');
    });
  });
});
