import { describe, it, expect } from 'vitest';
import { resolveImportPath } from '../../src/parser/reference-extractor.js';
import { parseContent } from '../../src/parser/ast-parser.js';
import type { FileReference } from '../../src/parser/reference-extractor.js';

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

describe('callsite metadata extraction', () => {
  const metadata = { sizeBytes: 100, modifiedAt: '2024-01-01T00:00:00.000Z' };

  it('extracts callsite metadata for direct function calls', () => {
    const content = `
import { add } from './utils';

const result = add(1, 2);
`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/utils.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(1);
    const addImport = result.references[0].imports.find(i => i.name === 'add');
    expect(addImport).toBeDefined();
    expect(addImport?.usages).toHaveLength(1);

    const usage = addImport?.usages[0];
    expect(usage?.context).toBe('call_expression');
    expect(usage?.callsite).toBeDefined();
    expect(usage?.callsite?.argumentCount).toBe(2);
    expect(usage?.callsite?.isMethodCall).toBe(false);
    expect(usage?.callsite?.isConstructorCall).toBe(false);
  });

  it('extracts callsite metadata for constructor calls', () => {
    const content = `
import { MyClass } from './classes';

const instance = new MyClass('arg1', 'arg2', 'arg3');
`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/classes.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(1);
    const classImport = result.references[0].imports.find(i => i.name === 'MyClass');
    expect(classImport).toBeDefined();
    expect(classImport?.usages).toHaveLength(1);

    const usage = classImport?.usages[0];
    expect(usage?.context).toBe('new_expression');
    expect(usage?.callsite).toBeDefined();
    expect(usage?.callsite?.argumentCount).toBe(3);
    expect(usage?.callsite?.isMethodCall).toBe(false);
    expect(usage?.callsite?.isConstructorCall).toBe(true);
  });

  it('extracts callsite metadata for method calls on imported object', () => {
    const content = `
import { api } from './services';

api.fetchData(url, options);
`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/services.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(1);
    const apiImport = result.references[0].imports.find(i => i.name === 'api');
    expect(apiImport).toBeDefined();
    expect(apiImport?.usages).toHaveLength(1);

    const usage = apiImport?.usages[0];
    expect(usage?.context).toBe('call_expression');
    expect(usage?.callsite).toBeDefined();
    expect(usage?.callsite?.argumentCount).toBe(2);
    expect(usage?.callsite?.isMethodCall).toBe(true);
    expect(usage?.callsite?.isConstructorCall).toBe(false);
    expect(usage?.callsite?.receiverName).toBe('api');
  });

  it('extracts callsite metadata for zero-argument calls', () => {
    const content = `
import { getConfig } from './config';

const config = getConfig();
`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/config.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    const configImport = result.references[0].imports.find(i => i.name === 'getConfig');
    expect(configImport?.usages[0]?.callsite?.argumentCount).toBe(0);
    expect(configImport?.usages[0]?.callsite?.isMethodCall).toBe(false);
  });

  it('does not add callsite metadata for non-call usages', () => {
    const content = `
import { helper } from './utils';

const fn = helper;  // assignment, not a call
`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/utils.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    const helperImport = result.references[0].imports.find(i => i.name === 'helper');
    expect(helperImport?.usages).toHaveLength(1);
    expect(helperImport?.usages[0]?.callsite).toBeUndefined();
  });

  it('extracts multiple callsites from same import', () => {
    const content = `
import { format } from './utils';

const a = format('hello');
const b = format('world', 'extra');
`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/utils.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    const formatImport = result.references[0].imports.find(i => i.name === 'format');
    expect(formatImport?.usages).toHaveLength(2);
    expect(formatImport?.usages[0]?.callsite?.argumentCount).toBe(1);
    expect(formatImport?.usages[1]?.callsite?.argumentCount).toBe(2);
  });
});

describe('re-export tracking', () => {
  const metadata = { sizeBytes: 100, modifiedAt: '2024-01-01T00:00:00.000Z' };

  it('creates synthetic usage for named re-exports', () => {
    const content = `export { foo, bar } from './utils';`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/utils.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(1);
    const ref = result.references[0];
    expect(ref.type).toBe('re-export');

    // Each re-exported symbol should have a synthetic usage
    const fooImport = ref.imports.find(i => i.name === 'foo');
    expect(fooImport).toBeDefined();
    expect(fooImport?.usages).toHaveLength(1);
    expect(fooImport?.usages[0]?.context).toBe('re-export');

    const barImport = ref.imports.find(i => i.name === 'bar');
    expect(barImport).toBeDefined();
    expect(barImport?.usages).toHaveLength(1);
    expect(barImport?.usages[0]?.context).toBe('re-export');
  });

  it('creates synthetic usage for aliased re-exports', () => {
    const content = `export { foo as renamedFoo } from './utils';`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/utils.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(1);
    const ref = result.references[0];

    const fooImport = ref.imports.find(i => i.name === 'foo');
    expect(fooImport).toBeDefined();
    expect(fooImport?.localName).toBe('renamedFoo');
    expect(fooImport?.usages).toHaveLength(1);
    expect(fooImport?.usages[0]?.context).toBe('re-export');
  });

  it('creates synthetic usage for export * (namespace re-export)', () => {
    const content = `export * from './utils';`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set(['/project/utils.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(1);
    const ref = result.references[0];
    expect(ref.type).toBe('export-all');

    // Namespace re-export should have a synthetic usage
    const namespaceImport = ref.imports.find(i => i.name === '*');
    expect(namespaceImport).toBeDefined();
    expect(namespaceImport?.usages).toHaveLength(1);
    expect(namespaceImport?.usages[0]?.context).toBe('re-export');
  });

  it('synthetic usage position matches export statement position', () => {
    const content = `// comment
export { query } from './database';`;
    const filePath = '/project/db.ts';
    const knownFiles = new Set(['/project/database.ts']);

    const result = parseContent(content, filePath, knownFiles, metadata);

    const ref = result.references[0];
    const queryImport = ref.imports.find(i => i.name === 'query');

    // The synthetic usage should be at the export statement's position (line 1, 0-indexed)
    expect(queryImport?.usages[0]?.position.row).toBe(1);
    expect(queryImport?.usages[0]?.position.column).toBe(0);
  });

  it('handles multiple re-exports in same file', () => {
    const content = `
export { a } from './moduleA';
export { b, c } from './moduleB';
export * from './moduleC';
`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set([
      '/project/moduleA.ts',
      '/project/moduleB.ts',
      '/project/moduleC.ts',
    ]);

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(3);

    // First re-export: { a }
    const refA = result.references.find(r => r.source === './moduleA') as FileReference;
    expect(refA.imports.find(i => i.name === 'a')?.usages).toHaveLength(1);

    // Second re-export: { b, c }
    const refB = result.references.find(r => r.source === './moduleB') as FileReference;
    expect(refB.imports.find(i => i.name === 'b')?.usages).toHaveLength(1);
    expect(refB.imports.find(i => i.name === 'c')?.usages).toHaveLength(1);

    // Third re-export: * (namespace)
    const refC = result.references.find(r => r.source === './moduleC') as FileReference;
    expect(refC.imports.find(i => i.name === '*')?.usages).toHaveLength(1);
  });
});
