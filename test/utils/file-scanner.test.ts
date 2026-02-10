import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLanguageFromExtension, scanDirectory } from '../../src/utils/file-scanner.js';

describe('getLanguageFromExtension', () => {
  it('.ts → typescript', () => {
    expect(getLanguageFromExtension('src/index.ts')).toBe('typescript');
  });

  it('.tsx → typescript', () => {
    expect(getLanguageFromExtension('src/App.tsx')).toBe('typescript');
  });

  it('.js → javascript', () => {
    expect(getLanguageFromExtension('src/index.js')).toBe('javascript');
  });

  it('.jsx → javascript', () => {
    expect(getLanguageFromExtension('src/App.jsx')).toBe('javascript');
  });
});

describe('scanDirectory', () => {
  const fixtureDir = path.resolve(__dirname, '../fixtures/simple');

  it('scans test/fixtures/simple/ and finds .ts files', async () => {
    const files = await scanDirectory(fixtureDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      expect(path.isAbsolute(file)).toBe(true);
      expect(file).toMatch(/\.(ts|tsx|js|jsx)$/);
    }
  });

  it('returns sorted absolute paths', async () => {
    const files = await scanDirectory(fixtureDir);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  it('respects custom ignore patterns', async () => {
    // Ignore everything — should return no files
    const files = await scanDirectory(fixtureDir, { ignorePatterns: ['**/*.ts'] });
    expect(files).toHaveLength(0);
  });
});
