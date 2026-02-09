import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAllLines, readSourceAsString, readSourceLines } from '../../../src/commands/_shared/source-reader.js';

describe('source-reader', () => {
  let tempDir: string;
  let testFilePath: string;

  const testContent = `line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9
line 10`;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-reader-test-'));
    testFilePath = path.join(tempDir, 'test-source.ts');
    await fs.writeFile(testFilePath, testContent);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('readSourceLines', () => {
    it('reads specific lines from a file (1-based indexing)', async () => {
      const lines = await readSourceLines(testFilePath, 2, 4);

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('line 2');
      expect(lines[1]).toBe('line 3');
      expect(lines[2]).toBe('line 4');
    });

    it('reads first line correctly', async () => {
      const lines = await readSourceLines(testFilePath, 1, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('line 1');
    });

    it('reads last line correctly', async () => {
      const lines = await readSourceLines(testFilePath, 10, 10);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('line 10');
    });

    it('reads all lines when range covers entire file', async () => {
      const lines = await readSourceLines(testFilePath, 1, 10);

      expect(lines).toHaveLength(10);
    });

    it('returns available lines when end exceeds file length', async () => {
      const lines = await readSourceLines(testFilePath, 8, 100);

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('line 8');
      expect(lines[1]).toBe('line 9');
      expect(lines[2]).toBe('line 10');
    });

    it('returns error message for non-existent file', async () => {
      const lines = await readSourceLines('/nonexistent/path.ts', 1, 10);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('<source code not available>');
    });

    it('handles position beyond file length', async () => {
      const lines = await readSourceLines(testFilePath, 100, 200);

      expect(lines).toHaveLength(0);
    });
  });

  describe('readSourceAsString', () => {
    it('reads specific lines as a single string', async () => {
      const content = await readSourceAsString(testFilePath, 2, 4);

      expect(content).toBe('line 2\nline 3\nline 4');
    });

    it('returns error message for non-existent file', async () => {
      const content = await readSourceAsString('/nonexistent/path.ts', 1, 10);

      expect(content).toBe('<source code not available>');
    });

    it('preserves line breaks in content', async () => {
      const content = await readSourceAsString(testFilePath, 1, 3);
      const lineCount = content.split('\n').length;

      expect(lineCount).toBe(3);
    });
  });

  describe('readAllLines', () => {
    it('reads all lines from a file', async () => {
      const lines = await readAllLines(testFilePath);

      expect(lines).toHaveLength(10);
      expect(lines[0]).toBe('line 1');
      expect(lines[9]).toBe('line 10');
    });

    it('returns empty array for non-existent file', async () => {
      const lines = await readAllLines('/nonexistent/path.ts');

      expect(lines).toHaveLength(0);
    });

    it('handles empty file', async () => {
      const emptyFilePath = path.join(tempDir, 'empty.ts');
      await fs.writeFile(emptyFilePath, '');

      const lines = await readAllLines(emptyFilePath);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('');
    });

    it('handles file with single line', async () => {
      const singleLinePath = path.join(tempDir, 'single.ts');
      await fs.writeFile(singleLinePath, 'single line content');

      const lines = await readAllLines(singleLinePath);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('single line content');
    });
  });
});
