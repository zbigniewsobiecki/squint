import { describe, it, expect } from 'vitest';
import { resolveImportPath } from '../../src/parser/reference-extractor.js';

describe('resolveImportPath', () => {
  it('resolves relative paths with known files', () => {
    const knownFiles = new Set(['/project/utils.ts']);
    const result = resolveImportPath('./utils', '/project/index.ts', knownFiles);
    expect(result).toBe('/project/utils.ts');
  });

  it('resolves paths with .ts extension', () => {
    const knownFiles = new Set(['/project/utils.ts']);
    const result = resolveImportPath('./utils.ts', '/project/index.ts', knownFiles);
    expect(result).toBe('/project/utils.ts');
  });

  it('resolves TypeScript ESM imports with .js extension', () => {
    const knownFiles = new Set(['/project/utils.ts']);
    const result = resolveImportPath('./utils.js', '/project/index.ts', knownFiles);
    expect(result).toBe('/project/utils.ts');
  });

  it('resolves index files in directories', () => {
    const knownFiles = new Set(['/project/utils/index.ts']);
    const result = resolveImportPath('./utils', '/project/index.ts', knownFiles);
    expect(result).toBe('/project/utils/index.ts');
  });

  it('returns undefined for external packages', () => {
    const knownFiles = new Set(['/project/utils.ts']);
    const result = resolveImportPath('lodash', '/project/index.ts', knownFiles);
    expect(result).toBeUndefined();
  });

  it('returns undefined for scoped packages', () => {
    const knownFiles = new Set(['/project/utils.ts']);
    const result = resolveImportPath('@types/node', '/project/index.ts', knownFiles);
    expect(result).toBeUndefined();
  });

  it('returns undefined when file not found', () => {
    const knownFiles = new Set(['/project/other.ts']);
    const result = resolveImportPath('./utils', '/project/index.ts', knownFiles);
    expect(result).toBeUndefined();
  });

  it('resolves .tsx files', () => {
    const knownFiles = new Set(['/project/Button.tsx']);
    const result = resolveImportPath('./Button', '/project/index.ts', knownFiles);
    expect(result).toBe('/project/Button.tsx');
  });

  it('resolves nested paths', () => {
    const knownFiles = new Set(['/project/components/ui/Button.tsx']);
    const result = resolveImportPath('./components/ui/Button', '/project/index.ts', knownFiles);
    expect(result).toBe('/project/components/ui/Button.tsx');
  });

  it('resolves parent directory paths', () => {
    const knownFiles = new Set(['/project/utils.ts']);
    const result = resolveImportPath('../utils', '/project/src/index.ts', knownFiles);
    expect(result).toBe('/project/utils.ts');
  });
});
