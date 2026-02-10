import { describe, expect, it } from 'vitest';
import {
  type DirectoryInfo,
  type DomainSummary,
  type ModuleForDeepening,
  type SymbolForAssignment,
  type TreeGenerationContext,
  buildAssignmentSystemPrompt,
  buildAssignmentUserPrompt,
  buildDeepenSystemPrompt,
  buildDeepenUserPrompt,
  buildTreeSystemPrompt,
  buildTreeUserPrompt,
  formatModuleTreeForPrompt,
  toSymbolForAssignment,
} from '../../../src/commands/llm/_shared/module-prompts.js';
import type { Module } from '../../../src/db/schema.js';

function makeModule(overrides: Partial<Module> & { fullPath: string; name: string; depth: number }): Module {
  return {
    id: 1,
    parentId: null,
    slug: 'test',
    description: null,
    colorIndex: 0,
    isTest: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('module-prompts', () => {
  // ============================================
  // Phase 1: Tree Structure Generation
  // ============================================
  describe('buildTreeSystemPrompt', () => {
    it('returns a non-empty system prompt', () => {
      const prompt = buildTreeSystemPrompt();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes CSV format instructions', () => {
      const prompt = buildTreeSystemPrompt();
      expect(prompt).toContain('type,parent_path,slug,name,description,is_test');
    });

    it('includes slug rules', () => {
      const prompt = buildTreeSystemPrompt();
      expect(prompt).toContain('lowercase');
      expect(prompt).toContain('Maximum 50 characters');
    });

    it('includes guidelines about depth and domain parity', () => {
      const prompt = buildTreeSystemPrompt();
      expect(prompt).toContain('3-5 levels');
      expect(prompt).toContain('Business Domain Parity');
    });
  });

  describe('buildTreeUserPrompt', () => {
    it('formats context with domains and directory structure', () => {
      const context: TreeGenerationContext = {
        totalSymbolCount: 150,
        domains: [
          {
            domain: 'auth',
            count: 20,
            sampleSymbols: [{ name: 'LoginService', kind: 'class', role: 'service' }],
          },
        ],
        directoryStructure: [
          { path: 'src/services/', symbolCount: 10 },
          { path: 'src/controllers/', symbolCount: 5 },
        ],
      };

      const prompt = buildTreeUserPrompt(context);
      expect(prompt).toContain('Total symbols: 150');
      expect(prompt).toContain('## Domains Found (1)');
      expect(prompt).toContain('### auth (20 symbols)');
      expect(prompt).toContain('LoginService (class) [service]');
      expect(prompt).toContain('src/services/ (10 symbols)');
      expect(prompt).toContain('src/controllers/ (5 symbols)');
    });

    it('includes all directories without truncation', () => {
      const context: TreeGenerationContext = {
        totalSymbolCount: 10,
        domains: [],
        directoryStructure: Array.from({ length: 40 }, (_, i) => ({ path: `dir${i}/`, symbolCount: i })),
      };

      const prompt = buildTreeUserPrompt(context);
      expect(prompt).toContain('dir0/');
      expect(prompt).toContain('dir39/');
      expect(prompt).not.toContain('more directories');
    });

    it('includes all domain sample symbols without truncation', () => {
      const domain: DomainSummary = {
        domain: 'big',
        count: 50,
        sampleSymbols: Array.from({ length: 15 }, (_, i) => ({
          name: `Sym${i}`,
          kind: 'function',
          role: null,
        })),
      };

      const context: TreeGenerationContext = {
        totalSymbolCount: 50,
        domains: [domain],
        directoryStructure: [],
      };

      const prompt = buildTreeUserPrompt(context);
      // Should show all sample symbols (no truncation)
      expect(prompt).toContain('Sym0');
      expect(prompt).toContain('Sym9');
      expect(prompt).toContain('Sym10');
      expect(prompt).toContain('Sym14');
    });

    it('omits role tag when null', () => {
      const context: TreeGenerationContext = {
        totalSymbolCount: 1,
        domains: [
          {
            domain: 'test',
            count: 1,
            sampleSymbols: [{ name: 'Foo', kind: 'function', role: null }],
          },
        ],
        directoryStructure: [],
      };

      const prompt = buildTreeUserPrompt(context);
      expect(prompt).toContain('Foo (function)');
      expect(prompt).not.toContain('[');
    });

    it('includes budget hint when maxModules is set', () => {
      const context: TreeGenerationContext = {
        totalSymbolCount: 100,
        domains: [],
        directoryStructure: [],
        maxModules: 200,
      };

      const prompt = buildTreeUserPrompt(context);
      expect(prompt).toContain('Module budget: 200 total');
      expect(prompt).toContain('Create ~80 modules now');
      expect(prompt).toContain('oversized leaves will be split automatically later');
    });

    it('omits budget hint when maxModules is 0 or undefined', () => {
      const context1: TreeGenerationContext = {
        totalSymbolCount: 100,
        domains: [],
        directoryStructure: [],
        maxModules: 0,
      };

      const context2: TreeGenerationContext = {
        totalSymbolCount: 100,
        domains: [],
        directoryStructure: [],
      };

      expect(buildTreeUserPrompt(context1)).not.toContain('Module budget');
      expect(buildTreeUserPrompt(context2)).not.toContain('Module budget');
    });

    it('renders directory info with symbol counts', () => {
      const context: TreeGenerationContext = {
        totalSymbolCount: 150,
        domains: [],
        directoryStructure: [
          { path: 'packages/backend/src/agent/gadgets', symbolCount: 109 },
          { path: 'packages/frontend/src/components', symbolCount: 3 },
        ],
      };

      const prompt = buildTreeUserPrompt(context);
      expect(prompt).toContain('- packages/backend/src/agent/gadgets (109 symbols)');
      expect(prompt).toContain('- packages/frontend/src/components (3 symbols)');
    });
  });

  // ============================================
  // Phase 2: Symbol Assignment
  // ============================================
  describe('buildAssignmentSystemPrompt', () => {
    it('returns a non-empty prompt with CSV format', () => {
      const prompt = buildAssignmentSystemPrompt();
      expect(prompt.length).toBeGreaterThan(50);
      expect(prompt).toContain('type,symbol_id,module_path');
    });

    it('requires exactly one module per symbol', () => {
      const prompt = buildAssignmentSystemPrompt();
      expect(prompt).toContain('exactly one module');
    });
  });

  describe('formatModuleTreeForPrompt', () => {
    it('formats modules sorted by depth then path', () => {
      const modules: Module[] = [
        makeModule({ id: 3, fullPath: 'project.frontend.screens', name: 'Screens', depth: 2 }),
        makeModule({ id: 1, fullPath: 'project', name: 'Project', depth: 0 }),
        makeModule({ id: 2, fullPath: 'project.frontend', name: 'Frontend', depth: 1 }),
      ];

      const result = formatModuleTreeForPrompt(modules);
      const lines = result.split('\n');
      expect(lines[0]).toBe('project: Project');
      expect(lines[1]).toBe('  project.frontend: Frontend');
      expect(lines[2]).toBe('    project.frontend.screens: Screens');
    });

    it('includes description when present', () => {
      const modules = [makeModule({ fullPath: 'project.api', name: 'API', depth: 1, description: 'REST endpoints' })];
      const result = formatModuleTreeForPrompt(modules);
      expect(result).toContain('project.api: API - REST endpoints');
    });

    it('omits description when null', () => {
      const modules = [makeModule({ fullPath: 'project.api', name: 'API', depth: 1, description: null })];
      const result = formatModuleTreeForPrompt(modules);
      expect(result).toBe('  project.api: API');
    });

    it('includes directory hints when provided', () => {
      const modules = [
        makeModule({ id: 1, fullPath: 'project', name: 'Project', depth: 0 }),
        makeModule({ id: 2, fullPath: 'project.api', name: 'API', depth: 1, description: 'REST endpoints' }),
      ];
      const hints = new Map<number, string[]>();
      hints.set(2, ['src/controllers', 'src/routes']);

      const result = formatModuleTreeForPrompt(modules, hints);
      expect(result).toContain('project.api: API - REST endpoints [src/controllers, src/routes]');
    });

    it('omits hint brackets when module has no hints', () => {
      const modules = [makeModule({ id: 5, fullPath: 'project.core', name: 'Core', depth: 1 })];
      const hints = new Map<number, string[]>();
      // no entry for id 5

      const result = formatModuleTreeForPrompt(modules, hints);
      expect(result).toBe('  project.core: Core');
      expect(result).not.toContain('[');
    });

    it('omits hint brackets when hints map is not provided', () => {
      const modules = [makeModule({ id: 5, fullPath: 'project.core', name: 'Core', depth: 1 })];
      const result = formatModuleTreeForPrompt(modules);
      expect(result).not.toContain('[');
    });
  });

  describe('buildAssignmentUserPrompt', () => {
    it('includes module tree and symbols to assign', () => {
      const modules = [makeModule({ fullPath: 'project', name: 'Project', depth: 0 })];
      const symbols: SymbolForAssignment[] = [
        {
          id: 42,
          name: 'UserService',
          kind: 'class',
          filePath: '/src/services/user.ts',
          purpose: 'Manages users',
          domain: ['auth', 'user'],
          role: 'service',
        },
      ];

      const prompt = buildAssignmentUserPrompt(modules, symbols);
      expect(prompt).toContain('## Available Modules');
      expect(prompt).toContain('project: Project');
      expect(prompt).toContain('## Symbols to Assign (1)');
      expect(prompt).toContain('#42: UserService (class)');
      expect(prompt).toContain('File: /src/services/user.ts');
      expect(prompt).toContain('Purpose: Manages users');
      expect(prompt).toContain('Domains: auth, user');
      expect(prompt).toContain('Role: service');
    });

    it('omits null purpose, domain, role', () => {
      const modules = [makeModule({ fullPath: 'project', name: 'Project', depth: 0 })];
      const symbols: SymbolForAssignment[] = [
        { id: 1, name: 'Foo', kind: 'function', filePath: '/foo.ts', purpose: null, domain: null, role: null },
      ];

      const prompt = buildAssignmentUserPrompt(modules, symbols);
      expect(prompt).not.toContain('Purpose:');
      expect(prompt).not.toContain('Domains:');
      expect(prompt).not.toContain('Role:');
    });

    it('omits empty domain array', () => {
      const modules = [makeModule({ fullPath: 'project', name: 'Project', depth: 0 })];
      const symbols: SymbolForAssignment[] = [
        { id: 1, name: 'Foo', kind: 'function', filePath: '/foo.ts', purpose: null, domain: [], role: null },
      ];

      const prompt = buildAssignmentUserPrompt(modules, symbols);
      expect(prompt).not.toContain('Domains:');
    });
  });

  describe('toSymbolForAssignment', () => {
    it('maps AnnotatedSymbolInfo to SymbolForAssignment', () => {
      const sym = {
        id: 42,
        name: 'Foo',
        kind: 'function',
        filePath: '/foo.ts',
        line: 10,
        endLine: 20,
        isExported: true,
        purpose: 'Does stuff',
        domain: ['auth'],
        role: 'service',
      };

      const result = toSymbolForAssignment(sym);
      expect(result).toEqual({
        id: 42,
        name: 'Foo',
        kind: 'function',
        filePath: '/foo.ts',
        purpose: 'Does stuff',
        domain: ['auth'],
        role: 'service',
      });
    });
  });

  // ============================================
  // Phase 3: Module Deepening
  // ============================================
  describe('buildDeepenSystemPrompt', () => {
    it('returns a non-empty prompt', () => {
      const prompt = buildDeepenSystemPrompt();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes CSV format with module and reassign types', () => {
      const prompt = buildDeepenSystemPrompt();
      expect(prompt).toContain('module');
      expect(prompt).toContain('reassign');
      expect(prompt).toContain('type,parent_path,slug,name,description,definition_id');
    });

    it('mentions splitting into 2-5 sub-modules', () => {
      const prompt = buildDeepenSystemPrompt();
      expect(prompt).toContain('2-5');
    });
  });

  describe('buildDeepenUserPrompt', () => {
    it('includes module path, name, and members', () => {
      const module: ModuleForDeepening = {
        id: 1,
        fullPath: 'project.frontend.hooks',
        name: 'Frontend Hooks',
        members: [
          { definitionId: 42, name: 'useCustomers', kind: 'function', filePath: '/src/hooks/customers.ts' },
          { definitionId: 43, name: 'useSales', kind: 'function', filePath: '/src/hooks/sales.ts' },
        ],
      };

      const prompt = buildDeepenUserPrompt(module);
      expect(prompt).toContain('Path: project.frontend.hooks');
      expect(prompt).toContain('Name: Frontend Hooks');
      expect(prompt).toContain('Members (2):');
      expect(prompt).toContain('#42: useCustomers (function) from /src/hooks/customers.ts');
      expect(prompt).toContain('#43: useSales (function) from /src/hooks/sales.ts');
    });
  });
});
