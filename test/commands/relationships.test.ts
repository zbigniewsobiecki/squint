import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('relationships commands', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;
  let controllerDefId: number;
  let authServiceDefId: number;
  let userServiceDefId: number;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-rel-test-'));
    dbPath = path.join(testDir, 'test.db');

    // Create and populate test database
    db = new IndexDatabase(dbPath);
    db.initialize();

    // Create source files on disk for code display
    const controllerPath = path.join(testDir, 'controller.ts');
    const servicePath = path.join(testDir, 'service.ts');

    fs.writeFileSync(
      controllerPath,
      `
import { authService, userService } from './service';

export async function loginController(req: Request) {
  const { email, password } = req.body;
  const user = await authService.authenticate(email, password);
  const profile = await userService.getProfile(user.id);
  return { user, profile };
}
`.trim()
    );

    fs.writeFileSync(
      servicePath,
      `
export const authService = {
  async authenticate(email: string, password: string) {
    // validate credentials
    return { id: 1, email };
  }
};

export const userService = {
  async getProfile(userId: number) {
    // fetch user profile
    return { name: 'Test User' };
  }
};
`.trim()
    );

    // Insert test files
    const controllerFileId = db.insertFile({
      path: controllerPath,
      language: 'typescript',
      contentHash: computeHash('controller'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const serviceFileId = db.insertFile({
      path: servicePath,
      language: 'typescript',
      contentHash: computeHash('service'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    // Insert definitions
    controllerDefId = db.insertDefinition(controllerFileId, {
      name: 'loginController',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 2, column: 0 },
      endPosition: { row: 7, column: 1 },
    });

    authServiceDefId = db.insertDefinition(serviceFileId, {
      name: 'authService',
      kind: 'variable',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    userServiceDefId = db.insertDefinition(serviceFileId, {
      name: 'userService',
      kind: 'variable',
      isExported: true,
      isDefault: false,
      position: { row: 7, column: 0 },
      endPosition: { row: 11, column: 1 },
    });

    // Create import reference from controller.ts to service.ts
    const importId = db.insertReference(controllerFileId, serviceFileId, {
      type: 'import',
      source: './service',
      isExternal: false,
      isTypeOnly: false,
      imports: [],
      position: { row: 0, column: 0 },
    });

    // Create symbols for imports
    const authSymId = db.insertSymbol(importId, authServiceDefId, {
      name: 'authService',
      localName: 'authService',
      kind: 'named',
      usages: [],
    });

    const userSymId = db.insertSymbol(importId, userServiceDefId, {
      name: 'userService',
      localName: 'userService',
      kind: 'named',
      usages: [],
    });

    // Create usages within controller's line range
    db.insertUsage(authSymId, {
      position: { row: 4, column: 20 },
      context: 'call_expression',
    });

    db.insertUsage(userSymId, {
      position: { row: 5, column: 22 },
      context: 'call_expression',
    });

    // Set some metadata
    db.setDefinitionMetadata(controllerDefId, 'purpose', 'Handles login requests');
    db.setDefinitionMetadata(controllerDefId, 'domain', '["auth", "user"]');
    db.setDefinitionMetadata(controllerDefId, 'role', 'controller');
    db.setDefinitionMetadata(authServiceDefId, 'purpose', 'Validates credentials');
    db.setDefinitionMetadata(authServiceDefId, 'domain', '["auth"]');
    db.setDefinitionMetadata(authServiceDefId, 'pure', 'false');
    db.setDefinitionMetadata(userServiceDefId, 'domain', '["user"]');

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
      // Return stdout even on error (for error message checks)
      return err.stdout || err.stderr || err.message;
    }
  }

  describe('relationships next', () => {
    it('shows next unannotated relationship with context', () => {
      const output = runCommand(`relationships next -d ${dbPath}`);
      expect(output).toContain('Relationship needing annotation');
      expect(output).toContain('FROM');
      expect(output).toContain('loginController');
      expect(output).toContain('TO');
      expect(output).toContain('remaining');
    });

    it('shows symbol metadata in output', () => {
      const output = runCommand(`relationships next -d ${dbPath}`);
      expect(output).toContain('Purpose:');
      expect(output).toContain('Handles login requests');
      expect(output).toContain('Domains:');
      expect(output).toContain('auth');
      expect(output).toContain('Role:');
      expect(output).toContain('controller');
    });

    it('shows shared domains', () => {
      const output = runCommand(`relationships next -d ${dbPath}`);
      // loginController has [auth, user], authService has [auth]
      // So shared domains should be [auth]
      expect(output).toContain('Domain overlap');
      expect(output).toContain('auth');
    });

    it('shows source code', () => {
      const output = runCommand(`relationships next -d ${dbPath}`);
      expect(output).toContain('authService.authenticate');
    });

    it('shows multiple relationships with --count', () => {
      const output = runCommand(`relationships next --count 2 -d ${dbPath}`);
      expect(output).toContain('(1 of 2)');
      expect(output).toContain('(2 of 2)');
    });

    it('filters by --from symbol name', () => {
      const output = runCommand(`relationships next --from loginController -d ${dbPath}`);
      expect(output).toContain('loginController');
    });

    it('filters by --from-id', () => {
      const output = runCommand(`relationships next --from-id ${controllerDefId} -d ${dbPath}`);
      expect(output).toContain('loginController');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`relationships next --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.relationships).toBeDefined();
      expect(json.relationships.length).toBeGreaterThan(0);
      expect(json.remaining).toBeDefined();
      expect(json.relationships[0].fromName).toBe('loginController');
      expect(json.relationships[0].fromPurpose).toBe('Handles login requests');
      expect(json.relationships[0].fromDomains).toContain('auth');
    });

    it('shows all relationships annotated message when done', () => {
      // Annotate all relationships
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setRelationshipAnnotation(controllerDefId, authServiceDefId, 'delegates auth');
      setupDb.setRelationshipAnnotation(controllerDefId, userServiceDefId, 'fetches profile');
      setupDb.close();

      const output = runCommand(`relationships next -d ${dbPath}`);
      expect(output).toContain('All relationships are annotated');
    });
  });

  describe('relationships set', () => {
    it('sets annotation with --from-id and --to-id', () => {
      const output = runCommand(
        `relationships set "delegates authentication" --from-id ${controllerDefId} --to-id ${authServiceDefId} -d ${dbPath}`
      );
      expect(output).toContain('Set relationship');
      expect(output).toContain('loginController');
      expect(output).toContain('authService');
      expect(output).toContain('delegates authentication');

      // Verify it was saved
      const verifyDb = new IndexDatabase(dbPath);
      const annotation = verifyDb.getRelationshipAnnotation(controllerDefId, authServiceDefId);
      expect(annotation).toBeDefined();
      expect(annotation!.semantic).toBe('delegates authentication');
      verifyDb.close();
    });

    it('sets annotation by symbol names', () => {
      const output = runCommand(
        `relationships set "fetches user profile" --from loginController --to userService -d ${dbPath}`
      );
      expect(output).toContain('Set relationship');
      expect(output).toContain('loginController');
      expect(output).toContain('userService');
    });

    it('updates existing annotation', () => {
      runCommand(`relationships set "old" --from-id ${controllerDefId} --to-id ${authServiceDefId} -d ${dbPath}`);
      runCommand(`relationships set "new" --from-id ${controllerDefId} --to-id ${authServiceDefId} -d ${dbPath}`);

      const verifyDb = new IndexDatabase(dbPath);
      const annotation = verifyDb.getRelationshipAnnotation(controllerDefId, authServiceDefId);
      expect(annotation!.semantic).toBe('new');
      verifyDb.close();
    });

    it('requires semantic description argument', () => {
      const output = runCommand(`relationships set --from-id 1 --to-id 2 -d ${dbPath}`);
      expect(output).toContain('semantic');
    });
  });

  describe('relationships unset', () => {
    beforeEach(() => {
      // Add an annotation to remove
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setRelationshipAnnotation(controllerDefId, authServiceDefId, 'test annotation');
      setupDb.close();
    });

    it('removes annotation with IDs', () => {
      const output = runCommand(
        `relationships unset --from-id ${controllerDefId} --to-id ${authServiceDefId} -d ${dbPath}`
      );
      expect(output).toContain('Removed');

      const verifyDb = new IndexDatabase(dbPath);
      const annotation = verifyDb.getRelationshipAnnotation(controllerDefId, authServiceDefId);
      expect(annotation).toBeNull();
      verifyDb.close();
    });

    it('removes annotation by symbol names', () => {
      const output = runCommand(`relationships unset --from loginController --to authService -d ${dbPath}`);
      expect(output).toContain('Removed');
    });

    it('reports when no annotation exists', () => {
      // First remove it
      runCommand(`relationships unset --from-id ${controllerDefId} --to-id ${authServiceDefId} -d ${dbPath}`);
      // Try to remove again
      const output = runCommand(
        `relationships unset --from-id ${controllerDefId} --to-id ${authServiceDefId} -d ${dbPath}`
      );
      expect(output).toContain('No relationship annotation found');
    });
  });

  describe('relationships list (index)', () => {
    beforeEach(() => {
      // Add some annotations
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setRelationshipAnnotation(controllerDefId, authServiceDefId, 'validates credentials');
      setupDb.setRelationshipAnnotation(controllerDefId, userServiceDefId, 'fetches user profile');
      setupDb.close();
    });

    it('lists all annotated relationships', () => {
      const output = runCommand(`relationships -d ${dbPath}`);
      expect(output).toContain('loginController');
      expect(output).toContain('authService');
      expect(output).toContain('userService');
      expect(output).toContain('validates credentials');
      expect(output).toContain('fetches user profile');
    });

    it('filters by --from symbol', () => {
      const output = runCommand(`relationships --from loginController -d ${dbPath}`);
      expect(output).toContain('loginController');
      expect(output).toContain('authService');
      expect(output).toContain('userService');
    });

    it('filters by --to symbol', () => {
      const output = runCommand(`relationships --to authService -d ${dbPath}`);
      expect(output).toContain('loginController');
      expect(output).toContain('authService');
      expect(output).not.toContain('userService');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`relationships --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.relationships).toBeDefined();
      expect(json.relationships.length).toBe(2);
    });

    it('shows message when no annotated relationships', () => {
      // Remove annotations
      const setupDb = new IndexDatabase(dbPath);
      setupDb.removeRelationshipAnnotation(controllerDefId, authServiceDefId);
      setupDb.removeRelationshipAnnotation(controllerDefId, userServiceDefId);
      setupDb.close();

      const output = runCommand(`relationships -d ${dbPath}`);
      expect(output).toContain('No annotated relationships');
    });
  });
});
