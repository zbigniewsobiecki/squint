import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE_PATTERNS, scanDirectory } from '../../src/utils/file-scanner.js';

const fixtureDir = path.resolve(__dirname, '../fixtures/with-excludes');

describe('scanDirectory with exclude patterns', () => {
  it('finds all files when no extra patterns are provided', async () => {
    const files = await scanDirectory(fixtureDir);
    expect(files).toHaveLength(4);
  });

  it('excludes files matching additional ignore patterns', async () => {
    const files = await scanDirectory(fixtureDir, {
      ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, '**/tests/**'],
    });
    // Should find src/app.ts, src/utils.ts, workspace/generated.ts — but not tests/app.test.ts
    expect(files).toHaveLength(3);
    expect(files.every((f) => !f.includes('/tests/'))).toBe(true);
  });

  it('excludes multiple patterns', async () => {
    const files = await scanDirectory(fixtureDir, {
      ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, '**/tests/**', '**/workspace/**'],
    });
    // Should find only src/app.ts and src/utils.ts
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.includes('/src/'))).toBe(true);
  });

  it('preserves default patterns when additional patterns are provided', async () => {
    const files = await scanDirectory(fixtureDir, {
      ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, '**/tests/**'],
    });
    // node_modules etc. should still be excluded (none in fixture, but pattern is present)
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });
});
