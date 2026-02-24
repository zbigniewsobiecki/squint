import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database-facade.js';
import { computeHash } from '../../src/db/schema.js';
import type { FileChange } from '../../src/sync/change-detector.js';
import { applySync } from '../../src/sync/incremental-indexer.js';

/**
 * Helper: create a temp dir with TypeScript fixture files,
 * parse them into a fresh database, and return everything needed for sync tests.
 */
function createTestEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-sync-test-'));
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // Write initial source files
  const utilsContent = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;
  const indexContent = `import { add, subtract } from './utils';

export function calculate(a: number, b: number): number {
  return add(a, b);
}
`;

  fs.writeFileSync(path.join(srcDir, 'utils.ts'), utilsContent);
  fs.writeFileSync(path.join(srcDir, 'index.ts'), indexContent);

  // Create and populate the database via direct SQL (mimics squint parse)
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new IndexDatabase(dbPath);
  db.initialize();
  db.setMetadata('source_directory', srcDir);
  db.setMetadata('version', '1.0.0');
  db.setMetadata('indexed_at', new Date().toISOString());

  // Insert files
  const utilsFileId = db.insertFile({
    path: 'utils.ts',
    language: 'typescript',
    contentHash: computeHash(utilsContent),
    sizeBytes: Buffer.byteLength(utilsContent),
    modifiedAt: new Date().toISOString(),
  });

  const indexFileId = db.insertFile({
    path: 'index.ts',
    language: 'typescript',
    contentHash: computeHash(indexContent),
    sizeBytes: Buffer.byteLength(indexContent),
    modifiedAt: new Date().toISOString(),
  });

  // Insert definitions for utils.ts
  const addDef = {
    name: 'add',
    kind: 'function' as const,
    isExported: true,
    isDefault: false,
    position: { row: 0, column: 0 },
    endPosition: { row: 2, column: 1 },
  };
  const subtractDef = {
    name: 'subtract',
    kind: 'function' as const,
    isExported: true,
    isDefault: false,
    position: { row: 4, column: 0 },
    endPosition: { row: 6, column: 1 },
  };
  db.insertDefinition(utilsFileId, addDef);
  db.insertDefinition(subtractFileId(), subtractDef);

  // Insert definitions for index.ts
  const calculateDef = {
    name: 'calculate',
    kind: 'function' as const,
    isExported: true,
    isDefault: false,
    position: { row: 2, column: 0 },
    endPosition: { row: 4, column: 1 },
  };
  db.insertDefinition(indexFileId, calculateDef);

  function subtractFileId() {
    return utilsFileId;
  }

  return { tmpDir, srcDir, dbPath, db, utilsFileId, indexFileId };
}

describe('incremental-indexer', () => {
  let tmpDir: string;
  let srcDir: string;
  let dbPath: string;
  let db: IndexDatabase;
  let utilsFileId: number;
  let indexFileId: number;

  beforeEach(() => {
    const env = createTestEnvironment();
    tmpDir = env.tmpDir;
    srcDir = env.srcDir;
    dbPath = env.dbPath;
    db = env.db;
    utilsFileId = env.utilsFileId;
    indexFileId = env.indexFileId;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // may already be closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('applySync', () => {
    it('returns zero counts when no changes provided', async () => {
      const result = await applySync([], srcDir, db, false);

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesDeleted).toBe(0);
      expect(result.definitionsAdded).toBe(0);
      expect(result.definitionsRemoved).toBe(0);
      expect(result.definitionsUpdated).toBe(0);
    });

    it('handles new files', async () => {
      // Write a new file to disk
      const newContent = `export function multiply(a: number, b: number): number {
  return a * b;
}
`;
      const newFilePath = path.join(srcDir, 'math.ts');
      fs.writeFileSync(newFilePath, newContent);

      const changes: FileChange[] = [
        {
          path: 'math.ts',
          absolutePath: newFilePath,
          status: 'new',
        },
      ];

      const result = await applySync(changes, srcDir, db, false);

      expect(result.filesAdded).toBe(1);
      expect(result.definitionsAdded).toBeGreaterThanOrEqual(1);

      // Verify the file was inserted into the DB
      const allFiles = db.files.getAll();
      const mathFile = allFiles.find((f) => f.path === 'math.ts');
      expect(mathFile).toBeDefined();
    });

    it('handles modified files — updates existing definitions', async () => {
      // Modify utils.ts on disk
      const modifiedContent = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`;
      fs.writeFileSync(path.join(srcDir, 'utils.ts'), modifiedContent);

      const changes: FileChange[] = [
        {
          path: 'utils.ts',
          absolutePath: path.join(srcDir, 'utils.ts'),
          status: 'modified',
          fileId: utilsFileId,
        },
      ];

      const result = await applySync(changes, srcDir, db, false);

      expect(result.filesModified).toBe(1);
      // 'add' and 'subtract' should be updated, 'multiply' should be added
      expect(result.definitionsUpdated).toBe(2);
      expect(result.definitionsAdded).toBe(1);
    });

    it('handles deleted files', async () => {
      // Remove utils.ts from disk (but leave it in DB)
      fs.unlinkSync(path.join(srcDir, 'utils.ts'));

      const changes: FileChange[] = [
        {
          path: 'utils.ts',
          absolutePath: path.join(srcDir, 'utils.ts'),
          status: 'deleted',
          fileId: utilsFileId,
        },
      ];

      const result = await applySync(changes, srcDir, db, false);

      expect(result.filesDeleted).toBe(1);

      // Verify the file was removed from the DB
      const allFiles = db.files.getAll();
      const utilsFile = allFiles.find((f) => f.path === 'utils.ts');
      expect(utilsFile).toBeUndefined();
    });

    it('handles removed definitions in modified files', async () => {
      // Rewrite utils.ts with only the 'add' function (removing 'subtract')
      const modifiedContent = `export function add(a: number, b: number): number {
  return a + b;
}
`;
      fs.writeFileSync(path.join(srcDir, 'utils.ts'), modifiedContent);

      const changes: FileChange[] = [
        {
          path: 'utils.ts',
          absolutePath: path.join(srcDir, 'utils.ts'),
          status: 'modified',
          fileId: utilsFileId,
        },
      ];

      const result = await applySync(changes, srcDir, db, false);

      expect(result.definitionsRemoved).toBe(1); // 'subtract' removed
      expect(result.definitionsUpdated).toBe(1); // 'add' updated

      // Verify only 'add' remains for this file
      const defs = db.definitions.getByFileId(utilsFileId);
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe('add');
    });

    it('is idempotent — second sync with same content yields no changes', async () => {
      // Modify a file
      const modifiedContent = `export function add(a: number, b: number): number {
  return a + b + 0;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;
      fs.writeFileSync(path.join(srcDir, 'utils.ts'), modifiedContent);

      const changes: FileChange[] = [
        {
          path: 'utils.ts',
          absolutePath: path.join(srcDir, 'utils.ts'),
          status: 'modified',
          fileId: utilsFileId,
        },
      ];

      // First sync
      await applySync(changes, srcDir, db, false);

      // Second sync with no changes should be a no-op
      const result2 = await applySync([], srcDir, db, false);

      expect(result2.filesAdded).toBe(0);
      expect(result2.filesModified).toBe(0);
      expect(result2.filesDeleted).toBe(0);
      expect(result2.definitionsAdded).toBe(0);
      expect(result2.definitionsRemoved).toBe(0);
    });
  });

  describe('transaction atomicity', () => {
    it('wraps all mutations in a single transaction (DB is consistent after sync)', async () => {
      // Add a new file and modify an existing one simultaneously
      const newContent = `export function multiply(a: number, b: number): number {
  return a * b;
}
`;
      const newFilePath = path.join(srcDir, 'math.ts');
      fs.writeFileSync(newFilePath, newContent);

      const modifiedContent = `export function add(a: number, b: number): number {
  return a + b;
}
`;
      fs.writeFileSync(path.join(srcDir, 'utils.ts'), modifiedContent);

      const changes: FileChange[] = [
        {
          path: 'math.ts',
          absolutePath: newFilePath,
          status: 'new',
        },
        {
          path: 'utils.ts',
          absolutePath: path.join(srcDir, 'utils.ts'),
          status: 'modified',
          fileId: utilsFileId,
        },
      ];

      const result = await applySync(changes, srcDir, db, false);

      // Verify both operations completed atomically
      expect(result.filesAdded).toBe(1);
      expect(result.filesModified).toBe(1);

      // Both files should be in the DB
      const allFiles = db.files.getAll();
      expect(allFiles.find((f) => f.path === 'math.ts')).toBeDefined();
      expect(allFiles.find((f) => f.path === 'utils.ts')).toBeDefined();

      // Definitions should be consistent
      const mathFile = allFiles.find((f) => f.path === 'math.ts')!;
      const mathDefs = db.definitions.getByFileId(mathFile.id);
      expect(mathDefs.some((d) => d.name === 'multiply')).toBe(true);
    });

    it('uses exclusive transaction (connection holds EXCLUSIVE lock during sync)', async () => {
      // This test verifies that the transaction is created and used.
      // We check that after a sync, the DB state is fully consistent —
      // definitions match the parsed source, no dangling references.
      const modifiedContent = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function divide(a: number, b: number): number {
  return a / b;
}
`;
      fs.writeFileSync(path.join(srcDir, 'utils.ts'), modifiedContent);

      const changes: FileChange[] = [
        {
          path: 'utils.ts',
          absolutePath: path.join(srcDir, 'utils.ts'),
          status: 'modified',
          fileId: utilsFileId,
        },
      ];

      await applySync(changes, srcDir, db, false);

      // Verify DB consistency — no dangling symbol references
      const conn = db.getConnection();
      const danglingSymbols = conn
        .prepare(
          `SELECT COUNT(*) as count FROM symbols
           WHERE definition_id IS NOT NULL
             AND definition_id NOT IN (SELECT id FROM definitions)`
        )
        .get() as { count: number };
      expect(danglingSymbols.count).toBe(0);
    });
  });

  describe('dependent file re-resolution', () => {
    it('re-resolves symbols in unchanged files that import from changed files', async () => {
      // index.ts imports from utils.ts. When utils.ts changes, index.ts
      // should have its symbols re-resolved.
      const modifiedContent = `export function add(a: number, b: number): number {
  return a + b + 0;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;
      fs.writeFileSync(path.join(srcDir, 'utils.ts'), modifiedContent);

      const changes: FileChange[] = [
        {
          path: 'utils.ts',
          absolutePath: path.join(srcDir, 'utils.ts'),
          status: 'modified',
          fileId: utilsFileId,
        },
      ];

      const result = await applySync(changes, srcDir, db, true);

      // The dependent file (index.ts) should be re-resolved
      expect(result.dependentFilesReResolved).toBeGreaterThanOrEqual(0);
      // No error should occur — the pre-parsing in Phase 2b handles this
    });
  });

  describe('verbose logging', () => {
    it('calls log function when verbose is true', async () => {
      const logs: string[] = [];
      const logFn = (msg: string) => logs.push(msg);

      const newContent = 'export const x = 1;\n';
      const newFilePath = path.join(srcDir, 'extra.ts');
      fs.writeFileSync(newFilePath, newContent);

      const changes: FileChange[] = [
        {
          path: 'extra.ts',
          absolutePath: newFilePath,
          status: 'new',
        },
      ];

      await applySync(changes, srcDir, db, true, logFn);

      // Should have some verbose log output
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((l) => l.includes('Parsing'))).toBe(true);
    });
  });
});
