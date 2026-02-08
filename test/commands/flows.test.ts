import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('flows and interactions commands', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;
  let controllerModuleId: number;
  let serviceModuleId: number;
  let repoModuleId: number;
  let interaction1Id: number;
  let interaction2Id: number;
  let interaction3Id: number;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-flows-test-'));
    dbPath = path.join(testDir, 'test.db');

    // Create and populate test database
    db = new IndexDatabase(dbPath);
    db.initialize();

    // Insert test files
    const controllerFileId = db.insertFile({
      path: path.join(testDir, 'controller.ts'),
      language: 'typescript',
      contentHash: computeHash('controller content'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const serviceFileId = db.insertFile({
      path: path.join(testDir, 'service.ts'),
      language: 'typescript',
      contentHash: computeHash('service content'),
      sizeBytes: 150,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const repoFileId = db.insertFile({
      path: path.join(testDir, 'repository.ts'),
      language: 'typescript',
      contentHash: computeHash('repo content'),
      sizeBytes: 120,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    // Create definitions for a typical flow
    const controllerDefId = db.insertDefinition(controllerFileId, {
      name: 'handleRegister',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 10, column: 1 },
    });

    const serviceDefId = db.insertDefinition(serviceFileId, {
      name: 'createUser',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 15, column: 1 },
    });

    const repoDefId = db.insertDefinition(repoFileId, {
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

    // Create module tree
    const rootId = db.ensureRootModule();

    controllerModuleId = db.insertModule(rootId, 'user-controller', 'User Controller', 'User API endpoints');
    serviceModuleId = db.insertModule(rootId, 'user-service', 'User Service', 'User business logic');
    repoModuleId = db.insertModule(rootId, 'user-repo', 'User Repository', 'User data access');

    // Assign symbols to modules
    db.assignSymbolToModule(controllerDefId, controllerModuleId);
    db.assignSymbolToModule(loginHandlerId, controllerModuleId);
    db.assignSymbolToModule(serviceDefId, serviceModuleId);
    db.assignSymbolToModule(repoDefId, repoModuleId);

    // Create interactions (module-to-module edges)
    interaction1Id = db.insertInteraction(controllerModuleId, serviceModuleId, {
      direction: 'uni',
      pattern: 'business',
      symbols: ['createUser', 'updateUser'],
      semantic: 'Controller delegates to service',
    });

    interaction2Id = db.insertInteraction(serviceModuleId, repoModuleId, {
      direction: 'uni',
      pattern: 'business',
      symbols: ['insertUser', 'findUser'],
      semantic: 'Service persists data',
    });

    interaction3Id = db.insertInteraction(controllerModuleId, repoModuleId, {
      direction: 'uni',
      pattern: 'utility',
      symbols: ['logAccess'],
      semantic: 'Direct logging access',
    });

    // Create flows (user journeys)
    const registerFlowId = db.insertFlow('UserRegistrationFlow', 'user-registration', {
      entryPointId: controllerDefId,
      entryPath: 'POST /api/users/register',
      stakeholder: 'user',
      description: 'User registration flow from signup to data persistence',
    });
    db.addFlowSteps(registerFlowId, [interaction1Id, interaction2Id]);

    const loginFlowId = db.insertFlow('UserLoginFlow', 'user-login', {
      entryPointId: loginHandlerId,
      entryPath: 'POST /api/users/login',
      stakeholder: 'user',
      description: 'User login authentication flow',
    });
    db.addFlowSteps(loginFlowId, [interaction1Id]);

    const adminFlowId = db.insertFlow('AdminAuditFlow', 'admin-audit', {
      stakeholder: 'admin',
      description: 'Administrative audit logging flow',
    });
    db.addFlowSteps(adminFlowId, [interaction3Id]);

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

  describe('interactions list', () => {
    it('lists all interactions', () => {
      const output = runCommand(`interactions -d ${dbPath}`);
      expect(output).toContain('Interactions');
      expect(output).toContain('user-controller');
      expect(output).toContain('user-service');
    });

    it('shows interaction patterns', () => {
      const output = runCommand(`interactions -d ${dbPath}`);
      expect(output).toContain('business');
      expect(output).toContain('utility');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`interactions --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.interactions).toBeDefined();
      expect(json.interactions.length).toBe(3);
      expect(json.stats).toBeDefined();
    });

    it('shows no interactions message when empty', () => {
      const emptyDbPath = path.join(testDir, 'empty.db');
      const emptyDb = new IndexDatabase(emptyDbPath);
      emptyDb.initialize();
      emptyDb.close();

      const output = runCommand(`interactions -d ${emptyDbPath}`);
      expect(output).toContain('No interactions');
    });
  });

  describe('interactions show', () => {
    it('shows interaction details by ID', () => {
      const output = runCommand(`interactions show ${interaction1Id} -d ${dbPath}`);
      expect(output).toContain('user-controller');
      expect(output).toContain('user-service');
      expect(output).toContain('Controller delegates to service');
    });

    it('shows symbols called', () => {
      const output = runCommand(`interactions show ${interaction1Id} -d ${dbPath}`);
      expect(output).toContain('createUser');
      expect(output).toContain('updateUser');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`interactions show ${interaction1Id} --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.interaction).toBeDefined();
      expect(json.interaction.fromModulePath).toContain('user-controller');
      expect(json.interaction.toModulePath).toContain('user-service');
    });

    it('reports error for non-existent interaction', () => {
      const output = runCommand(`interactions show 999 -d ${dbPath}`);
      expect(output).toContain('not found');
    });
  });

  describe('flows list', () => {
    it('lists all flows', () => {
      const output = runCommand(`flows -d ${dbPath}`);
      expect(output).toContain('Flows');
      expect(output).toContain('UserRegistrationFlow');
      expect(output).toContain('UserLoginFlow');
      expect(output).toContain('AdminAuditFlow');
    });

    it('groups flows by stakeholder', () => {
      const output = runCommand(`flows -d ${dbPath}`);
      expect(output).toContain('user');
      expect(output).toContain('admin');
    });

    it('shows no flows message when empty', () => {
      const emptyDbPath = path.join(testDir, 'empty.db');
      const emptyDb = new IndexDatabase(emptyDbPath);
      emptyDb.initialize();
      emptyDb.close();

      const output = runCommand(`flows -d ${emptyDbPath}`);
      expect(output).toContain('No flows');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`flows --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.flows).toBeDefined();
      expect(json.flows.length).toBe(3);
      expect(json.stats).toBeDefined();
      expect(json.coverage).toBeDefined();
    });

    it('shows coverage statistics', () => {
      const output = runCommand(`flows -d ${dbPath}`);
      expect(output).toContain('coverage');
    });
  });

  describe('flows show', () => {
    it('shows flow details by slug', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('UserRegistrationFlow');
      expect(output).toContain('user-registration');
    });

    it('shows flow description', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('User registration flow');
    });

    it('shows entry point', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('POST /api/users/register');
    });

    it('shows interaction steps', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('user-controller');
      expect(output).toContain('user-service');
      expect(output).toContain('user-repo');
    });

    it('handles partial name match', () => {
      const output = runCommand(`flows show registration -d ${dbPath}`);
      expect(output).toContain('UserRegistrationFlow');
    });

    it('shows disambiguation for multiple matches', () => {
      // Both flows contain 'user'
      const output = runCommand(`flows show user -d ${dbPath}`);
      expect(output).toContain('Multiple flows match');
    });

    it('reports error for non-existent flow', () => {
      const output = runCommand(`flows show nonexistent -d ${dbPath}`);
      expect(output).toContain('not found');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`flows show user-registration --json -d ${dbPath}`);
      const json = JSON.parse(output);
      // flowWithSteps structure - flow properties at root level, steps as array
      expect(json.name).toBe('UserRegistrationFlow');
      expect(json.slug).toBe('user-registration');
      expect(json.steps).toBeDefined();
      expect(json.steps.length).toBe(2);
    });
  });
});
