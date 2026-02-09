import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';

describe('domains commands', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-domains-test-'));
    dbPath = path.join(testDir, 'test.db');

    // Create and populate test database
    db = new IndexDatabase(dbPath);
    db.initialize();

    // Insert test files and definitions
    const fileId = db.insertFile({
      path: path.join(testDir, 'auth.ts'),
      language: 'typescript',
      contentHash: computeHash('content'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const loginId = db.insertDefinition(fileId, {
      name: 'login',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    const logoutId = db.insertDefinition(fileId, {
      name: 'logout',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 6, column: 0 },
      endPosition: { row: 10, column: 1 },
    });

    const processPaymentId = db.insertDefinition(fileId, {
      name: 'processPayment',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 11, column: 0 },
      endPosition: { row: 15, column: 1 },
    });

    // Set domain metadata on some symbols
    db.setDefinitionMetadata(loginId, 'domain', '["auth", "user"]');
    db.setDefinitionMetadata(logoutId, 'domain', '["auth"]');
    db.setDefinitionMetadata(processPaymentId, 'domain', '["payment"]');

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

  describe('domains list (index)', () => {
    it('lists registered domains with counts', () => {
      // First register some domains
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('auth', 'User authentication');
      setupDb.addDomain('payment', 'Payment processing');
      setupDb.close();

      const output = runCommand(`domains -d ${dbPath}`);
      expect(output).toContain('auth');
      expect(output).toContain('payment');
      expect(output).toContain('User authentication');
      expect(output).toContain('2 domain(s) registered');
    });

    it('shows symbol counts for each domain', () => {
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('auth', 'Auth');
      setupDb.close();

      const output = runCommand(`domains -d ${dbPath}`);
      expect(output).toContain('auth');
      expect(output).toContain('2 symbols'); // login and logout have auth domain
    });

    it('shows message when no domains registered', () => {
      const output = runCommand(`domains -d ${dbPath}`);
      expect(output).toContain('No domains registered');
    });

    it('outputs JSON with --json flag', () => {
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('auth', 'Authentication');
      setupDb.close();

      const output = runCommand(`domains --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.domains).toBeDefined();
      expect(json.domains.length).toBe(1);
      expect(json.domains[0].name).toBe('auth');
    });

    it('shows unregistered domains with --unregistered', () => {
      const output = runCommand(`domains --unregistered -d ${dbPath}`);
      expect(output).toContain('Unregistered domains');
      expect(output).toContain('auth');
      expect(output).toContain('payment');
      expect(output).toContain('user');
    });
  });

  describe('domains add', () => {
    it('adds a new domain', () => {
      const output = runCommand(`domains add customer -d ${dbPath} --description "Customer management"`);
      expect(output).toContain('Registered domain customer');

      const verifyDb = new IndexDatabase(dbPath);
      const domain = verifyDb.getDomain('customer');
      expect(domain).toBeDefined();
      expect(domain!.description).toBe('Customer management');
      verifyDb.close();
    });

    it('supports --description flag', () => {
      const output = runCommand(`domains add billing -d ${dbPath} --description "Billing system"`);
      expect(output).toContain('Registered domain billing');

      const verifyDb = new IndexDatabase(dbPath);
      const domain = verifyDb.getDomain('billing');
      expect(domain!.description).toBe('Billing system');
      verifyDb.close();
    });

    it('reports error for duplicate domain', () => {
      runCommand(`domains add auth -d ${dbPath} --description First`);
      const output = runCommand(`domains add auth -d ${dbPath} --description Second`);
      expect(output).toContain('already exists');
    });
  });

  describe('domains rename', () => {
    beforeEach(() => {
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('auth', 'Authentication');
      setupDb.close();
    });

    it('renames a domain in registry', () => {
      const output = runCommand(`domains rename -d ${dbPath} auth authentication`);
      expect(output).toContain('Renamed domain auth -> authentication');

      const verifyDb = new IndexDatabase(dbPath);
      expect(verifyDb.getDomain('auth')).toBeNull();
      expect(verifyDb.getDomain('authentication')).toBeDefined();
      verifyDb.close();
    });

    it('updates symbol metadata', () => {
      const output = runCommand(`domains rename -d ${dbPath} auth authentication`);
      expect(output).toContain('Updated 2 symbol'); // login and logout

      const verifyDb = new IndexDatabase(dbPath);
      const loginMeta = verifyDb.getDefinitionMetadata(1);
      expect(loginMeta.domain).toContain('authentication');
      expect(loginMeta.domain).not.toContain('"auth"');
      verifyDb.close();
    });

    it('reports error if new name exists', () => {
      runCommand(`domains add payment -d ${dbPath} --description Payment`);
      const output = runCommand(`domains rename -d ${dbPath} auth payment`);
      expect(output).toContain('already exists');
    });
  });

  describe('domains merge', () => {
    beforeEach(() => {
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('user', 'User management');
      setupDb.addDomain('auth', 'Authentication');
      setupDb.close();
    });

    it('merges source domain into target', () => {
      const output = runCommand(`domains merge -d ${dbPath} user auth`);
      expect(output).toContain('Merged domain user -> auth');
      expect(output).toContain('Updated 1 symbol'); // login had ["auth", "user"]

      const verifyDb = new IndexDatabase(dbPath);
      expect(verifyDb.getDomain('user')).toBeNull();
      const loginMeta = verifyDb.getDefinitionMetadata(1);
      expect(loginMeta.domain).toBe('["auth"]'); // user removed, auth kept
      verifyDb.close();
    });

    it('reports error if source domain not found', () => {
      const output = runCommand(`domains merge -d ${dbPath} nonexistent auth`);
      expect(output).toContain('not found');
    });
  });

  describe('domains remove', () => {
    beforeEach(() => {
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('deprecated', 'Old domain');
      setupDb.addDomain('auth', 'Authentication');
      setupDb.close();
    });

    it('removes an unused domain', () => {
      const output = runCommand(`domains remove -d ${dbPath} deprecated`);
      expect(output).toContain('Removed domain deprecated');

      const verifyDb = new IndexDatabase(dbPath);
      expect(verifyDb.getDomain('deprecated')).toBeNull();
      verifyDb.close();
    });

    it('refuses to remove domain in use without --force', () => {
      const output = runCommand(`domains remove -d ${dbPath} auth`);
      expect(output).toContain('Cannot remove domain');
      expect(output).toContain('still use it');
    });

    it('removes domain in use with --force', () => {
      const output = runCommand(`domains remove -d ${dbPath} auth --force`);
      expect(output).toContain('Removed domain auth');
      expect(output).toContain('Warning');
      expect(output).toContain('symbol');
    });
  });

  describe('domains sync', () => {
    it('registers all domains from metadata', () => {
      const output = runCommand(`domains sync -d ${dbPath}`);
      expect(output).toContain('Registered 3 new domain');
      expect(output).toContain('auth');
      expect(output).toContain('payment');
      expect(output).toContain('user');

      const verifyDb = new IndexDatabase(dbPath);
      expect(verifyDb.getDomainsFromRegistry()).toHaveLength(3);
      verifyDb.close();
    });

    it('does not duplicate existing domains', () => {
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('auth', 'Already registered');
      setupDb.close();

      const output = runCommand(`domains sync -d ${dbPath}`);
      expect(output).toContain('Registered 2 new domain'); // payment and user

      const verifyDb = new IndexDatabase(dbPath);
      expect(verifyDb.getDomainsFromRegistry()).toHaveLength(3);
      verifyDb.close();
    });

    it('reports when all domains already registered', () => {
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('auth', 'Auth');
      setupDb.addDomain('payment', 'Payment');
      setupDb.addDomain('user', 'User');
      setupDb.close();

      const output = runCommand(`domains sync -d ${dbPath}`);
      expect(output).toContain('already registered');
    });

    it('outputs JSON with --json flag', () => {
      const output = runCommand(`domains sync --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.registered).toBeDefined();
      expect(json.registered.sort()).toEqual(['auth', 'payment', 'user']);
    });
  });

  describe('symbols set domain warning', () => {
    it('warns about unregistered domains', () => {
      const output = runCommand(`symbols set domain '["newdomain"]' --name login -d ${dbPath}`);
      expect(output).toContain('Set domain');
      expect(output).toContain('Warning');
      expect(output).toContain('unregistered domain');
      expect(output).toContain('newdomain');
    });

    it('does not warn for registered domains', () => {
      const setupDb = new IndexDatabase(dbPath);
      setupDb.addDomain('registered', 'Registered domain');
      setupDb.close();

      const output = runCommand(`symbols set domain '["registered"]' --name login -d ${dbPath}`);
      expect(output).toContain('Set domain');
      expect(output).not.toContain('Warning');
      expect(output).not.toContain('unregistered');
    });
  });
});
