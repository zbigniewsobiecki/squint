import { afterEach, describe, expect, it } from 'vitest';
import { TypeScriptAdapter } from '../../../src/parser/adapters/typescript-adapter.js';
import { LanguageRegistry } from '../../../src/parser/language-adapter.js';

describe('TypeScriptAdapter', () => {
  describe('Adapter Properties', () => {
    it('has correct languageId', () => {
      const adapter = new TypeScriptAdapter();
      expect(adapter.languageId).toBe('typescript');
    });

    it('handles all TypeScript and JavaScript file extensions', () => {
      const adapter = new TypeScriptAdapter();
      expect(adapter.fileExtensions).toEqual(['.ts', '.tsx', '.js', '.jsx']);
    });

    it('has appropriate default ignore patterns', () => {
      const adapter = new TypeScriptAdapter();
      expect(adapter.defaultIgnorePatterns).toContain('node_modules/**');
      expect(adapter.defaultIgnorePatterns).toContain('dist/**');
      expect(adapter.defaultIgnorePatterns).toContain('build/**');
      expect(adapter.defaultIgnorePatterns).toContain('.next/**');
      expect(adapter.defaultIgnorePatterns).toContain('.nuxt/**');
    });
  });

  describe('Auto-registration', () => {
    it('auto-registers on import', () => {
      // TypeScriptAdapter is auto-registered when the module is imported
      // This happens at the top of the test file
      const registry = LanguageRegistry.getInstance();

      expect(registry.hasAdapter('.ts')).toBe(true);
      expect(registry.hasAdapter('.tsx')).toBe(true);
      expect(registry.hasAdapter('.js')).toBe(true);
      expect(registry.hasAdapter('.jsx')).toBe(true);
    });

    it('returns TypeScriptAdapter for .ts files', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = registry.getAdapterForFile('/path/to/file.ts');

      expect(adapter).toBeInstanceOf(TypeScriptAdapter);
    });

    it('returns TypeScriptAdapter for .tsx files', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = registry.getAdapterForFile('/path/to/component.tsx');

      expect(adapter).toBeInstanceOf(TypeScriptAdapter);
    });

    it('returns TypeScriptAdapter for .js files', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = registry.getAdapterForFile('/path/to/script.js');

      expect(adapter).toBeInstanceOf(TypeScriptAdapter);
    });

    it('returns TypeScriptAdapter for .jsx files', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = registry.getAdapterForFile('/path/to/component.jsx');

      expect(adapter).toBeInstanceOf(TypeScriptAdapter);
    });
  });

  describe('getParser', () => {
    it('returns TypeScript parser for .ts files', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/file.ts');

      expect(parser).toBeDefined();
      // Verify parser can parse TypeScript
      const tree = parser.parse('const x: number = 42;');
      expect(tree.rootNode).toBeDefined();
    });

    it('returns TSX parser for .tsx files', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/Component.tsx');

      expect(parser).toBeDefined();
      // Verify parser can parse JSX
      const tree = parser.parse('const elem = <div>Hello</div>;');
      expect(tree.rootNode).toBeDefined();
    });

    it('returns JavaScript parser for .js files', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/script.js');

      expect(parser).toBeDefined();
      // Verify parser can parse JavaScript
      const tree = parser.parse('const x = 42;');
      expect(tree.rootNode).toBeDefined();
    });

    it('returns JavaScript parser for .jsx files', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/Component.jsx');

      expect(parser).toBeDefined();
      // Verify parser can parse JSX
      const tree = parser.parse('const elem = <div>Hello</div>;');
      expect(tree.rootNode).toBeDefined();
    });

    it('handles case-insensitive extensions', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/file.TS');

      expect(parser).toBeDefined();
    });
  });

  describe('extractDefinitions', () => {
    it('extracts function definitions', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/utils.ts');
      const code = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
      const tree = parser.parse(code);
      const definitions = adapter.extractDefinitions(tree.rootNode);

      expect(definitions).toHaveLength(1);
      expect(definitions[0].name).toBe('add');
      expect(definitions[0].kind).toBe('function');
      expect(definitions[0].isExported).toBe(true);
    });

    it('extracts class definitions', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/Calculator.ts');
      const code = `
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}
`;
      const tree = parser.parse(code);
      const definitions = adapter.extractDefinitions(tree.rootNode);

      expect(definitions).toHaveLength(1);
      expect(definitions[0].name).toBe('Calculator');
      expect(definitions[0].kind).toBe('class');
      expect(definitions[0].isExported).toBe(true);
    });

    it('extracts interface definitions', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/types.ts');
      const code = `
export interface User {
  id: string;
  name: string;
}
`;
      const tree = parser.parse(code);
      const definitions = adapter.extractDefinitions(tree.rootNode);

      expect(definitions).toHaveLength(1);
      expect(definitions[0].name).toBe('User');
      expect(definitions[0].kind).toBe('interface');
      expect(definitions[0].isExported).toBe(true);
    });

    it('extracts type alias definitions', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/types.ts');
      const code = 'export type UserId = string;';
      const tree = parser.parse(code);
      const definitions = adapter.extractDefinitions(tree.rootNode);

      expect(definitions).toHaveLength(1);
      expect(definitions[0].name).toBe('UserId');
      expect(definitions[0].kind).toBe('type');
      expect(definitions[0].isExported).toBe(true);
    });

    it('extracts const and variable definitions', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/constants.ts');
      const code = `
export const PI = 3.14159;
export let counter = 0;
`;
      const tree = parser.parse(code);
      const definitions = adapter.extractDefinitions(tree.rootNode);

      expect(definitions).toHaveLength(2);

      const piDef = definitions.find((d) => d.name === 'PI');
      expect(piDef?.kind).toBe('const');

      const counterDef = definitions.find((d) => d.name === 'counter');
      expect(counterDef?.kind).toBe('variable');
    });

    it('extracts enum definitions', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/enums.ts');
      const code = `
export enum Color {
  Red = 'red',
  Blue = 'blue',
}
`;
      const tree = parser.parse(code);
      const definitions = adapter.extractDefinitions(tree.rootNode);

      expect(definitions).toHaveLength(1);
      expect(definitions[0].name).toBe('Color');
      expect(definitions[0].kind).toBe('enum');
      expect(definitions[0].isExported).toBe(true);
    });
  });

  describe('extractReferences', () => {
    it('extracts import statements', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/index.ts');
      const code = `import { add, subtract } from './utils';`;
      const tree = parser.parse(code);
      const references = adapter.extractReferences(tree.rootNode, '/project/index.ts', new Set(['/project/utils.ts']));

      expect(references).toHaveLength(1);
      expect(references[0].type).toBe('import');
      expect(references[0].source).toBe('./utils');
      expect(references[0].resolvedPath).toBe('/project/utils.ts');
      expect(references[0].isExternal).toBe(false);
      expect(references[0].imports).toHaveLength(2);
    });

    it('identifies external package imports', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/index.ts');
      const code = `import chalk from 'chalk';`;
      const tree = parser.parse(code);
      const references = adapter.extractReferences(tree.rootNode, '/project/index.ts', new Set());

      expect(references).toHaveLength(1);
      expect(references[0].isExternal).toBe(true);
      expect(references[0].source).toBe('chalk');
    });

    it('extracts type-only imports', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/index.ts');
      const code = `import type { User } from './types';`;
      const tree = parser.parse(code);
      const references = adapter.extractReferences(tree.rootNode, '/project/index.ts', new Set(['/project/types.ts']));

      expect(references).toHaveLength(1);
      expect(references[0].isTypeOnly).toBe(true);
    });
  });

  describe('extractInternalUsages', () => {
    it('tracks internal symbol usages', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/utils.ts');
      const code = `
function helper() {
  return 42;
}

export function main() {
  return helper();
}
`;
      const tree = parser.parse(code);
      const definitions = adapter.extractDefinitions(tree.rootNode);
      const usages = adapter.extractInternalUsages(tree.rootNode, definitions);

      const helperUsage = usages.find((u) => u.definitionName === 'helper');
      expect(helperUsage).toBeDefined();
      expect(helperUsage?.usages.length).toBeGreaterThan(0);
    });
  });

  describe('resolveImportPath', () => {
    it('resolves relative imports', () => {
      const adapter = new TypeScriptAdapter();
      const knownFiles = new Set(['/project/utils.ts', '/project/index.ts']);

      const resolved = adapter.resolveImportPath('./utils', '/project/index.ts', knownFiles);

      expect(resolved).toBe('/project/utils.ts');
    });

    it('resolves imports without extensions', () => {
      const adapter = new TypeScriptAdapter();
      const knownFiles = new Set(['/project/utils.ts']);

      const resolved = adapter.resolveImportPath('./utils', '/project/index.ts', knownFiles);

      expect(resolved).toBe('/project/utils.ts');
    });

    it('resolves directory imports to index files', () => {
      const adapter = new TypeScriptAdapter();
      const knownFiles = new Set(['/project/utils/index.ts']);

      const resolved = adapter.resolveImportPath('./utils', '/project/index.ts', knownFiles);

      expect(resolved).toBe('/project/utils/index.ts');
    });

    it('returns null for external package imports', () => {
      const adapter = new TypeScriptAdapter();
      const knownFiles = new Set<string>();

      const resolved = adapter.resolveImportPath('lodash', '/project/index.ts', knownFiles);

      expect(resolved).toBeNull();
    });

    it('handles .js imports that map to .ts files', () => {
      const adapter = new TypeScriptAdapter();
      const knownFiles = new Set(['/project/utils.ts']);

      // TypeScript ESM imports use .js extension even for .ts files
      const resolved = adapter.resolveImportPath('./utils.js', '/project/index.ts', knownFiles);

      expect(resolved).toBe('/project/utils.ts');
    });
  });

  describe('Integration', () => {
    it('works end-to-end with parser workflow', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/app.ts');
      const code = `
import { helper } from './utils';

export class App {
  run() {
    return helper();
  }
}

export const version = '1.0.0';
`;
      const tree = parser.parse(code);
      const knownFiles = new Set(['/project/utils.ts']);

      const definitions = adapter.extractDefinitions(tree.rootNode);
      const references = adapter.extractReferences(tree.rootNode, '/project/app.ts', knownFiles);
      const usages = adapter.extractInternalUsages(tree.rootNode, definitions);

      // Verify definitions
      expect(definitions).toHaveLength(2);
      expect(definitions.find((d) => d.name === 'App')).toBeDefined();
      expect(definitions.find((d) => d.name === 'version')).toBeDefined();

      // Verify references
      expect(references).toHaveLength(1);
      expect(references[0].source).toBe('./utils');
      expect(references[0].resolvedPath).toBe('/project/utils.ts');

      // Verify usages is array (even if empty)
      expect(Array.isArray(usages)).toBe(true);
    });

    it('handles complex TypeScript features', () => {
      const adapter = new TypeScriptAdapter();
      const parser = adapter.getParser('/project/complex.ts');
      const code = `
export interface Config {
  name: string;
}

export type Handler<T> = (data: T) => void;

export class Service implements Config {
  name = 'service';

  handle<T>(data: T): void {
    console.log(data);
  }
}
`;
      const tree = parser.parse(code);
      const definitions = adapter.extractDefinitions(tree.rootNode);

      expect(definitions).toHaveLength(3);
      expect(definitions.find((d) => d.name === 'Config' && d.kind === 'interface')).toBeDefined();
      expect(definitions.find((d) => d.name === 'Handler' && d.kind === 'type')).toBeDefined();
      expect(definitions.find((d) => d.name === 'Service' && d.kind === 'class')).toBeDefined();
    });
  });
});
