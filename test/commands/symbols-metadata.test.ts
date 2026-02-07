import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexDatabase, computeHash } from '../../src/db/database.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('symbols metadata commands', () => {
  let testDir: string;
  let dbPath: string;
  let db: IndexDatabase;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-test-'));
    dbPath = path.join(testDir, 'test.db');

    // Create and populate test database
    db = new IndexDatabase(dbPath);
    db.initialize();

    // Insert test file
    const fileId = db.insertFile({
      path: path.join(testDir, 'utils.ts'),
      language: 'typescript',
      contentHash: computeHash('content'),
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    // Insert test definitions
    db.insertDefinition(fileId, {
      name: 'add',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 2, column: 1 },
    });

    db.insertDefinition(fileId, {
      name: 'subtract',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 3, column: 0 },
      endPosition: { row: 5, column: 1 },
    });

    db.insertDefinition(fileId, {
      name: 'MyClass',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 6, column: 0 },
      endPosition: { row: 10, column: 1 },
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
      // Return stdout even on error (for error message checks)
      return err.stdout || err.stderr || err.message;
    }
  }

  describe('symbols set', () => {
    it('sets metadata on a symbol by name', () => {
      const output = runCommand(`symbols set purpose "Adds two numbers" --name add -d ${dbPath}`);
      expect(output).toContain('Set purpose="Adds two numbers" on add');

      // Verify it was saved
      const verifyDb = new IndexDatabase(dbPath);
      const metadata = verifyDb.getDefinitionMetadata(1);
      expect(metadata.purpose).toBe('Adds two numbers');
      verifyDb.close();
    });

    it('sets metadata on a symbol by ID', () => {
      const output = runCommand(`symbols set status "stable" --id 2 -d ${dbPath}`);
      expect(output).toContain('Set status="stable" on subtract');

      // Verify it was saved
      const verifyDb = new IndexDatabase(dbPath);
      const metadata = verifyDb.getDefinitionMetadata(2);
      expect(metadata.status).toBe('stable');
      verifyDb.close();
    });

    it('overwrites existing metadata', () => {
      runCommand(`symbols set status "draft" --name add -d ${dbPath}`);
      runCommand(`symbols set status "stable" --name add -d ${dbPath}`);

      const verifyDb = new IndexDatabase(dbPath);
      const metadata = verifyDb.getDefinitionMetadata(1);
      expect(metadata.status).toBe('stable');
      verifyDb.close();
    });

    it('requires --name or --id', () => {
      const output = runCommand(`symbols set purpose "test" -d ${dbPath}`);
      expect(output).toContain('Either provide --name or --id');
    });

    it('reports error for non-existent symbol name', () => {
      const output = runCommand(`symbols set purpose "test" --name nonexistent -d ${dbPath}`);
      expect(output).toContain('No symbol found with name "nonexistent"');
    });

    it('reports error for non-existent ID', () => {
      const output = runCommand(`symbols set purpose "test" --id 999 -d ${dbPath}`);
      expect(output).toContain('No definition found with ID 999');
    });
  });

  describe('symbols unset', () => {
    beforeEach(() => {
      // Set some metadata to remove
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setDefinitionMetadata(1, 'purpose', 'Adds numbers');
      setupDb.setDefinitionMetadata(1, 'status', 'stable');
      setupDb.close();
    });

    it('removes metadata by name', () => {
      const output = runCommand(`symbols unset purpose --name add -d ${dbPath}`);
      expect(output).toContain('Removed purpose from add');

      const verifyDb = new IndexDatabase(dbPath);
      const metadata = verifyDb.getDefinitionMetadata(1);
      expect(metadata.purpose).toBeUndefined();
      expect(metadata.status).toBe('stable');
      verifyDb.close();
    });

    it('removes metadata by ID', () => {
      const output = runCommand(`symbols unset status --id 1 -d ${dbPath}`);
      expect(output).toContain('Removed status from add');

      const verifyDb = new IndexDatabase(dbPath);
      const metadata = verifyDb.getDefinitionMetadata(1);
      expect(metadata.status).toBeUndefined();
      expect(metadata.purpose).toBe('Adds numbers');
      verifyDb.close();
    });

    it('reports when key does not exist', () => {
      const output = runCommand(`symbols unset nonexistent --name add -d ${dbPath}`);
      expect(output).toContain('No metadata key "nonexistent" found on add');
    });

    it('requires --name or --id', () => {
      const output = runCommand(`symbols unset purpose -d ${dbPath}`);
      expect(output).toContain('Either provide --name or --id');
    });
  });

  describe('symbols --has filter', () => {
    beforeEach(() => {
      // Set metadata on some definitions
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setDefinitionMetadata(1, 'documented', 'yes');
      setupDb.setDefinitionMetadata(3, 'documented', 'yes');
      setupDb.close();
    });

    it('filters to symbols with metadata key', () => {
      const output = runCommand(`symbols --has documented -d ${dbPath}`);
      expect(output).toContain('add');
      expect(output).toContain('MyClass');
      expect(output).not.toContain('subtract');
      expect(output).toContain('Found 2 symbol(s)');
    });

    it('combines with --kind filter', () => {
      const output = runCommand(`symbols --has documented --kind function -d ${dbPath}`);
      expect(output).toContain('add');
      expect(output).not.toContain('MyClass');
      expect(output).toContain('Found 1 symbol(s)');
    });

    it('returns no results when no symbols have the key', () => {
      const output = runCommand(`symbols --has nonexistent -d ${dbPath}`);
      expect(output).toContain('No symbols found');
    });
  });

  describe('symbols --missing filter', () => {
    beforeEach(() => {
      // Set metadata on one definition
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setDefinitionMetadata(1, 'documented', 'yes');
      setupDb.close();
    });

    it('filters to symbols missing metadata key', () => {
      const output = runCommand(`symbols --missing documented -d ${dbPath}`);
      expect(output).not.toContain('\tadd\t');
      expect(output).toContain('subtract');
      expect(output).toContain('MyClass');
      expect(output).toContain('Found 2 symbol(s)');
    });

    it('combines with --kind filter', () => {
      const output = runCommand(`symbols --missing documented --kind class -d ${dbPath}`);
      expect(output).toContain('MyClass');
      expect(output).not.toContain('subtract');
      expect(output).toContain('Found 1 symbol(s)');
    });

    it('returns all symbols when none have the key', () => {
      const output = runCommand(`symbols --missing nonexistent -d ${dbPath}`);
      expect(output).toContain('add');
      expect(output).toContain('subtract');
      expect(output).toContain('MyClass');
      expect(output).toContain('Found 3 symbol(s)');
    });
  });

  describe('symbols show metadata display', () => {
    it('displays metadata section when metadata exists', () => {
      // Set metadata first
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setDefinitionMetadata(1, 'purpose', 'Adds two numbers');
      setupDb.setDefinitionMetadata(1, 'status', 'stable');
      setupDb.close();

      const output = runCommand(`symbols show --id 1 -d ${dbPath}`);
      expect(output).toContain('=== Metadata ===');
      expect(output).toContain('purpose:');
      expect(output).toContain('Adds two numbers');
      expect(output).toContain('status:');
      expect(output).toContain('stable');
    });

    it('omits metadata section when no metadata exists', () => {
      const output = runCommand(`symbols show --id 1 -d ${dbPath}`);
      expect(output).not.toContain('=== Metadata ===');
    });

    it('includes metadata in JSON output', () => {
      // Set metadata first
      const setupDb = new IndexDatabase(dbPath);
      setupDb.setDefinitionMetadata(1, 'purpose', 'Adds numbers');
      setupDb.close();

      const output = runCommand(`symbols show --id 1 --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.metadata).toBeDefined();
      expect(json.metadata.purpose).toBe('Adds numbers');
    });

    it('includes empty metadata object in JSON when no metadata', () => {
      const output = runCommand(`symbols show --id 1 --json -d ${dbPath}`);
      const json = JSON.parse(output);
      expect(json.metadata).toEqual({});
    });
  });
});
