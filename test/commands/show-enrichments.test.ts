import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('show command enrichments', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;

  // Definition IDs
  let controllerDefId: number;
  let serviceDefId: number;
  let repoDefId: number;
  let helperDefId: number;
  let loginDefId: number;

  // File IDs
  let controllerFileId: number;
  let serviceFileId: number;
  let repoFileId: number;

  // Module IDs
  let rootModuleId: number;
  let controllerModuleId: number;
  let serviceModuleId: number;
  let repoModuleId: number;

  // Interaction IDs
  let interaction1Id: number;
  let interaction2Id: number;

  // Flow IDs
  let registerFlowId: number;
  let loginFlowId: number;

  // Feature ID
  let authFeatureId: number;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-enrichment-test-'));
    dbPath = path.join(testDir, 'test.db');

    // Write source files to disk (needed for symbols show source code + files show)
    const controllerPath = path.join(testDir, 'controller.ts');
    const servicePath = path.join(testDir, 'service.ts');
    const repoPath = path.join(testDir, 'repository.ts');

    fs.writeFileSync(
      controllerPath,
      [
        'import { UserService } from "./service";',
        '',
        'export async function handleRegister(req: Request) {',
        '  const svc = new UserService();',
        '  return svc.createUser(req.body);',
        '}',
        '',
        'export async function handleLogin(req: Request) {',
        '  const svc = new UserService();',
        '  return svc.authenticate(req.body);',
        '}',
        '',
        'function helperFn() { return true; }',
      ].join('\n')
    );

    fs.writeFileSync(
      servicePath,
      [
        'import { UserRepo } from "./repository";',
        '',
        'export class UserService {',
        '  createUser(data: any) { return new UserRepo().insert(data); }',
        '  authenticate(creds: any) { return true; }',
        '}',
      ].join('\n')
    );

    fs.writeFileSync(
      repoPath,
      ['export class UserRepo {', '  insert(data: any) { return { id: 1 }; }', '}'].join('\n')
    );

    db = new IndexDatabase(dbPath);
    db.initialize();

    // --- Files ---
    controllerFileId = db.files.insert({
      path: controllerPath,
      language: 'typescript',
      contentHash: computeHash('controller'),
      sizeBytes: 300,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    serviceFileId = db.files.insert({
      path: servicePath,
      language: 'typescript',
      contentHash: computeHash('service'),
      sizeBytes: 200,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    repoFileId = db.files.insert({
      path: repoPath,
      language: 'typescript',
      contentHash: computeHash('repo'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    // --- Definitions ---
    controllerDefId = db.files.insertDefinition(controllerFileId, {
      name: 'handleRegister',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 2, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    loginDefId = db.files.insertDefinition(controllerFileId, {
      name: 'handleLogin',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 7, column: 0 },
      endPosition: { row: 10, column: 1 },
    });

    helperDefId = db.files.insertDefinition(controllerFileId, {
      name: 'helperFn',
      kind: 'function',
      isExported: false,
      isDefault: false,
      position: { row: 12, column: 0 },
      endPosition: { row: 12, column: 36 },
    });

    serviceDefId = db.files.insertDefinition(serviceFileId, {
      name: 'UserService',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 2, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    repoDefId = db.files.insertDefinition(repoFileId, {
      name: 'UserRepo',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 2, column: 1 },
    });

    // --- Import references (controller -> service) ---
    const ref1 = db.insertReference(controllerFileId, serviceFileId, {
      type: 'import',
      source: './service',
      isExternal: false,
      isTypeOnly: false,
      imports: [],
      position: { row: 0, column: 0 },
    });

    const sym1 = db.insertSymbol(ref1, serviceDefId, {
      name: 'UserService',
      localName: 'UserService',
      kind: 'named',
      usages: [],
    });

    // Usage of UserService within handleRegister
    db.insertUsage(sym1, {
      position: { row: 3, column: 14 },
      context: 'call_expression',
    });

    // --- Metadata ---
    db.metadata.set(controllerDefId, 'purpose', 'Handles user registration requests');
    db.metadata.set(controllerDefId, 'domain', '["auth", "user"]');
    db.metadata.set(controllerDefId, 'role', 'controller');
    db.metadata.set(serviceDefId, 'purpose', 'Core user business logic');
    db.metadata.set(serviceDefId, 'domain', '["auth"]');
    db.metadata.set(repoDefId, 'purpose', 'User data persistence');
    db.metadata.set(repoDefId, 'domain', '["auth"]');

    // --- Modules ---
    rootModuleId = db.modules.ensureRoot();

    const apiModuleId = db.modules.insert(rootModuleId, 'api', 'API', 'API layer');
    controllerModuleId = db.modules.insert(apiModuleId, 'controllers', 'Controllers', 'Request handlers');
    serviceModuleId = db.modules.insert(rootModuleId, 'services', 'Services', 'Business logic layer');
    repoModuleId = db.modules.insert(rootModuleId, 'repositories', 'Repositories', 'Data access layer');

    // Assign symbols to modules
    db.modules.assignSymbol(controllerDefId, controllerModuleId);
    db.modules.assignSymbol(loginDefId, controllerModuleId);
    db.modules.assignSymbol(helperDefId, controllerModuleId);
    db.modules.assignSymbol(serviceDefId, serviceModuleId);
    db.modules.assignSymbol(repoDefId, repoModuleId);

    // --- Relationship annotations ---
    db.relationships.set(controllerDefId, serviceDefId, 'delegates user creation to service');
    db.relationships.set(serviceDefId, repoDefId, 'persists user data');

    // --- Interactions ---
    interaction1Id = db.interactions.insert(controllerModuleId, serviceModuleId, {
      direction: 'uni',
      pattern: 'business',
      symbols: ['UserService'],
      semantic: 'Controller delegates to service',
    });

    interaction2Id = db.interactions.insert(serviceModuleId, repoModuleId, {
      direction: 'uni',
      pattern: 'business',
      symbols: ['UserRepo'],
      semantic: 'Service persists via repository',
    });

    // --- Flows ---
    registerFlowId = db.flows.insert('UserRegistrationFlow', 'user-registration', {
      entryPointId: controllerDefId,
      entryPath: 'POST /api/register',
      stakeholder: 'user',
      description: 'User registration journey',
    });
    db.flows.addSteps(registerFlowId, [interaction1Id, interaction2Id]);

    // Add definition steps to the register flow
    db.flows.addDefinitionSteps(registerFlowId, [
      {
        fromDefinitionId: controllerDefId,
        toDefinitionId: serviceDefId,
      },
      {
        fromDefinitionId: serviceDefId,
        toDefinitionId: repoDefId,
      },
    ]);

    loginFlowId = db.flows.insert('UserLoginFlow', 'user-login', {
      entryPointId: loginDefId,
      entryPath: 'POST /api/login',
      stakeholder: 'user',
      description: 'User authentication journey',
    });
    db.flows.addSteps(loginFlowId, [interaction1Id]);

    // --- Features ---
    authFeatureId = db.features.insert('Authentication', 'authentication', {
      description: 'User auth feature',
    });
    db.features.addFlows(authFeatureId, [registerFlowId, loginFlowId]);

    // --- Domains (registered) ---
    db.domains.add('auth', 'Authentication and authorization');
    db.domains.add('user', 'User management');

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

  describe('symbols show enrichments', () => {
    it('shows module membership', () => {
      const output = runCommand(`symbols show --id ${controllerDefId} -d ${dbPath}`);
      expect(output).toContain('Module');
      expect(output).toContain('Controllers');
    });

    it('shows outgoing relationships', () => {
      const output = runCommand(`symbols show --id ${controllerDefId} -d ${dbPath}`);
      expect(output).toContain('Relationships Outgoing');
      expect(output).toContain('UserService');
      expect(output).toContain('delegates user creation to service');
    });

    it('shows incoming relationships', () => {
      const output = runCommand(`symbols show --id ${serviceDefId} -d ${dbPath}`);
      expect(output).toContain('Relationships Incoming');
      expect(output).toContain('handleRegister');
    });

    it('shows dependencies', () => {
      const output = runCommand(`symbols show --id ${controllerDefId} -d ${dbPath}`);
      expect(output).toContain('Dependencies');
      expect(output).toContain('UserService');
    });

    it('shows dependents', () => {
      const output = runCommand(`symbols show --id ${serviceDefId} -d ${dbPath}`);
      expect(output).toContain('Dependents');
      expect(output).toContain('handleRegister');
    });

    it('shows flows involving the symbol', () => {
      const output = runCommand(`symbols show --id ${controllerDefId} -d ${dbPath}`);
      expect(output).toContain('Flows');
      expect(output).toContain('UserRegistrationFlow');
    });

    it('includes new fields in JSON output', () => {
      const output = runCommand(`symbols show --id ${controllerDefId} --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.module).toBeDefined();
      expect(json.module.name).toBe('Controllers');
      expect(json.relationships).toBeDefined();
      expect(json.incomingRelationships).toBeDefined();
      expect(json.dependencies).toBeDefined();
      expect(json.dependents).toBeDefined();
      expect(json.dependents.count).toBeGreaterThanOrEqual(0);
      expect(json.flows).toBeDefined();
    });
  });

  describe('relationships show enrichments', () => {
    it('shows metadata for both symbols', () => {
      const output = runCommand(`relationships show --from ${controllerDefId} --to ${serviceDefId} -d ${dbPath}`);
      expect(output).toContain('Handles user registration requests');
      expect(output).toContain('Core user business logic');
    });

    it('shows module context for both symbols', () => {
      const output = runCommand(`relationships show --from ${controllerDefId} --to ${serviceDefId} -d ${dbPath}`);
      expect(output).toContain('Module:');
      expect(output).toContain('Controllers');
      expect(output).toContain('Services');
    });

    it('shows module interaction', () => {
      const output = runCommand(`relationships show --from ${controllerDefId} --to ${serviceDefId} -d ${dbPath}`);
      expect(output).toContain('Module Interaction');
      expect(output).toContain('business');
    });

    it('shows flows using the interaction', () => {
      const output = runCommand(`relationships show --from ${controllerDefId} --to ${serviceDefId} -d ${dbPath}`);
      expect(output).toContain('Flows');
      expect(output).toContain('UserRegistrationFlow');
    });

    it('includes new fields in JSON output', () => {
      const output = runCommand(
        `relationships show --from ${controllerDefId} --to ${serviceDefId} --json -d ${dbPath}`
      );
      const json = JSON.parse(output);
      expect(json.fromMetadata).toBeDefined();
      expect(json.fromMetadata.purpose).toBe('Handles user registration requests');
      expect(json.toMetadata).toBeDefined();
      expect(json.fromModule).toBeDefined();
      expect(json.fromModule.name).toBe('Controllers');
      expect(json.toModule).toBeDefined();
      expect(json.toModule.name).toBe('Services');
      expect(json.interaction).toBeDefined();
      expect(json.flows).toBeDefined();
      expect(json.flows.length).toBeGreaterThan(0);
    });
  });

  describe('modules show enrichments', () => {
    it('shows parent module', () => {
      const output = runCommand(`modules show project.api.controllers -d ${dbPath}`);
      expect(output).toContain('Parent:');
      expect(output).toContain('API');
    });

    it('shows children modules', () => {
      const output = runCommand(`modules show project.api -d ${dbPath}`);
      expect(output).toContain('Children');
      expect(output).toContain('Controllers');
    });

    it('shows outgoing interactions', () => {
      const output = runCommand(`modules show project.api.controllers -d ${dbPath}`);
      expect(output).toContain('Outgoing Interactions');
      expect(output).toContain('services');
    });

    it('shows incoming interactions', () => {
      const output = runCommand(`modules show project.services -d ${dbPath}`);
      expect(output).toContain('Incoming Interactions');
      expect(output).toContain('controllers');
    });

    it('shows flows through module', () => {
      const output = runCommand(`modules show project.api.controllers -d ${dbPath}`);
      expect(output).toContain('Flows');
      expect(output).toContain('UserRegistrationFlow');
    });

    it('shows features through module', () => {
      const output = runCommand(`modules show project.api.controllers -d ${dbPath}`);
      expect(output).toContain('Features');
      expect(output).toContain('Authentication');
    });

    it('includes new fields in JSON output', () => {
      const output = runCommand(`modules show project.api.controllers --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.parent).toBeDefined();
      expect(json.parent.name).toBe('API');
      expect(json.outgoingInteractions).toBeDefined();
      expect(json.outgoingInteractions.length).toBeGreaterThan(0);
      expect(json.flows).toBeDefined();
      expect(json.features).toBeDefined();
    });
  });

  describe('interactions show enrichments', () => {
    it('shows module descriptions', () => {
      const output = runCommand(`interactions show ${interaction1Id} -d ${dbPath}`);
      expect(output).toContain('Request handlers');
      expect(output).toContain('Business logic layer');
    });

    it('shows resolved symbols', () => {
      const output = runCommand(`interactions show ${interaction1Id} -d ${dbPath}`);
      expect(output).toContain('Symbols');
      expect(output).toContain('UserService');
    });

    it('shows interaction details heading', () => {
      const output = runCommand(`interactions show ${interaction1Id} -d ${dbPath}`);
      expect(output).toContain('Interaction Details');
    });

    it('shows features', () => {
      const output = runCommand(`interactions show ${interaction1Id} -d ${dbPath}`);
      expect(output).toContain('Features');
      expect(output).toContain('Authentication');
    });

    it('includes new fields in JSON output', () => {
      const output = runCommand(`interactions show ${interaction1Id} --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.fromModuleDescription).toBe('Request handlers');
      expect(json.toModuleDescription).toBe('Business logic layer');
      expect(json.resolvedSymbols).toBeDefined();
      expect(json.relatedInteractions).toBeDefined();
      expect(json.features).toBeDefined();
      expect(json.features.length).toBeGreaterThan(0);
    });
  });

  describe('flows show enrichments', () => {
    it('shows features', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('Feature:');
      expect(output).toContain('Authentication');
    });

    it('shows entry point details', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('Entry Point');
      expect(output).toContain('handleRegister');
    });

    it('shows modules involved', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('Modules Involved');
      expect(output).toContain('Controllers');
      expect(output).toContain('Services');
    });

    it('shows definition trace', () => {
      const output = runCommand(`flows show user-registration -d ${dbPath}`);
      expect(output).toContain('Definition Trace');
      expect(output).toContain('handleRegister');
      expect(output).toContain('UserService');
    });

    it('includes new fields in JSON output', () => {
      const output = runCommand(`flows show user-registration --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.features).toBeDefined();
      expect(json.features.length).toBeGreaterThan(0);
      expect(json.entryPoint).toBeDefined();
      expect(json.entryPoint.name).toBe('handleRegister');
      expect(json.modulesInvolved).toBeDefined();
      expect(json.modulesInvolved.length).toBeGreaterThan(0);
      expect(json.definitionSteps).toBeDefined();
      expect(json.definitionSteps.length).toBe(2);
    });
  });

  describe('features show enrichments', () => {
    it('shows enriched flows with stakeholder and step count', () => {
      const output = runCommand(`features show authentication -d ${dbPath}`);
      expect(output).toContain('UserRegistrationFlow');
      expect(output).toContain('user');
      expect(output).toContain('steps');
    });

    it('shows modules involved', () => {
      const output = runCommand(`features show authentication -d ${dbPath}`);
      expect(output).toContain('Modules Involved');
    });

    it('shows interactions', () => {
      const output = runCommand(`features show authentication -d ${dbPath}`);
      expect(output).toContain('Interactions');
    });

    it('shows stats with stakeholder breakdown', () => {
      const output = runCommand(`features show authentication -d ${dbPath}`);
      expect(output).toContain('Flows:');
      expect(output).toContain('By Stakeholder');
      expect(output).toContain('user: 2');
    });

    it('includes new fields in JSON output', () => {
      const output = runCommand(`features show authentication --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.flows).toBeDefined();
      expect(json.flows[0].stakeholder).toBeDefined();
      expect(json.flows[0].stepCount).toBeDefined();
      expect(json.modulesInvolved).toBeDefined();
      expect(json.interactions).toBeDefined();
      expect(json.stats).toBeDefined();
      expect(json.stats.flowCount).toBe(2);
      expect(json.stats.byStakeholder).toBeDefined();
    });
  });

  describe('files show enrichments', () => {
    it('shows module per definition', () => {
      const output = runCommand(`files show ${path.join(testDir, 'controller.ts')} -d ${dbPath}`);
      expect(output).toContain('handleRegister');
      expect(output).toContain('Controllers');
    });

    it('shows metadata per definition', () => {
      const output = runCommand(`files show ${path.join(testDir, 'controller.ts')} -d ${dbPath}`);
      expect(output).toContain('Handles user registration requests');
    });

    it('shows relationships from file', () => {
      const output = runCommand(`files show ${path.join(testDir, 'controller.ts')} -d ${dbPath}`);
      expect(output).toContain('Relationships');
      expect(output).toContain('handleRegister');
      expect(output).toContain('UserService');
    });

    it('includes new fields in JSON output', () => {
      const output = runCommand(`files show ${path.join(testDir, 'controller.ts')} --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.definitions).toBeDefined();
      // Check enriched definition
      const handleRegister = json.definitions.find((d: { name: string }) => d.name === 'handleRegister');
      expect(handleRegister).toBeDefined();
      expect(handleRegister.module).toBeDefined();
      expect(handleRegister.module.name).toBe('Controllers');
      expect(handleRegister.metadata).toBeDefined();
      expect(handleRegister.metadata.purpose).toBe('Handles user registration requests');
      expect(json.relationships).toBeDefined();
      expect(json.relationships.length).toBeGreaterThan(0);
    });
  });

  describe('domains show enrichments', () => {
    it('shows module distribution', () => {
      const output = runCommand(`domains show auth -d ${dbPath}`);
      expect(output).toContain('Module Distribution');
    });

    it('shows intra-domain relationships', () => {
      const output = runCommand(`domains show auth -d ${dbPath}`);
      // handleRegister -> UserService, both have domain "auth"
      expect(output).toContain('Intra-Domain Relationships');
      expect(output).toContain('handleRegister');
      expect(output).toContain('UserService');
    });

    it('includes new fields in JSON output', () => {
      const output = runCommand(`domains show auth --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.moduleDistribution).toBeDefined();
      expect(json.moduleDistribution.length).toBeGreaterThan(0);
      expect(json.intraDomainRelationships).toBeDefined();
    });
  });
});
