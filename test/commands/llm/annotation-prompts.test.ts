import { describe, expect, it } from 'vitest';
import {
  type ModuleCandidate,
  type SymbolContext,
  type SymbolContextEnhanced,
  buildModuleSystemPrompt,
  buildModuleUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  buildUserPromptEnhanced,
} from '../../../src/commands/llm/_shared/prompts.js';
import type { CoverageInfo } from '../../../src/commands/llm/_shared/prompts.js';

describe('prompts (annotation)', () => {
  // ============================================
  // buildSystemPrompt
  // ============================================
  describe('buildSystemPrompt', () => {
    it('includes all requested aspects', () => {
      const prompt = buildSystemPrompt(['purpose', 'domain', 'role', 'pure']);
      expect(prompt).toContain('**purpose**');
      expect(prompt).toContain('**domain**');
      expect(prompt).toContain('**role**');
      expect(prompt).toContain('**pure**');
    });

    it('includes CSV format instructions', () => {
      const prompt = buildSystemPrompt(['purpose']);
      expect(prompt).toContain('type,id,field,value');
    });

    it('includes relationship description guidance', () => {
      const prompt = buildSystemPrompt(['purpose']);
      expect(prompt).toContain('uses');
      expect(prompt).toContain('extends');
      expect(prompt).toContain('implements');
    });

    it('handles unknown aspects gracefully', () => {
      const prompt = buildSystemPrompt(['custom_aspect']);
      expect(prompt).toContain('**custom_aspect**');
      expect(prompt).toContain('A descriptive value for this aspect.');
    });
  });

  // ============================================
  // buildUserPrompt
  // ============================================
  describe('buildUserPrompt', () => {
    const makeSymbol = (overrides?: Partial<SymbolContext>): SymbolContext => ({
      id: 42,
      name: 'UserService',
      kind: 'class',
      filePath: '/src/services/user.ts',
      line: 10,
      endLine: 50,
      sourceCode: 'class UserService {}',
      dependencies: [],
      ...overrides,
    });

    it('includes coverage section', () => {
      const coverage: CoverageInfo[] = [{ aspect: 'purpose', covered: 50, total: 100, percentage: 50 }];
      const prompt = buildUserPrompt([makeSymbol()], ['purpose'], coverage);
      expect(prompt).toContain('## Current Coverage');
      expect(prompt).toContain('purpose: 50/100 (50.0%)');
    });

    it('omits coverage section when empty', () => {
      const prompt = buildUserPrompt([makeSymbol()], ['purpose'], []);
      expect(prompt).not.toContain('## Current Coverage');
    });

    it('formats symbol with file location and source code', () => {
      const prompt = buildUserPrompt([makeSymbol()], ['purpose'], []);
      expect(prompt).toContain('#42: UserService (class)');
      expect(prompt).toContain('File: /src/services/user.ts:10-50');
      expect(prompt).toContain('class UserService {}');
    });

    it('shows single line when line equals endLine', () => {
      const prompt = buildUserPrompt([makeSymbol({ line: 10, endLine: 10 })], ['purpose'], []);
      expect(prompt).toContain('File: /src/services/user.ts:10');
      expect(prompt).not.toContain('10-10');
    });

    it('shows dependencies with annotations', () => {
      const symbol = makeSymbol({
        dependencies: [
          {
            name: 'Logger',
            kind: 'class',
            filePath: '/src/logger.ts',
            line: 1,
            dependencyId: 10,
            aspectValue: 'Logging utility',
          },
        ],
      });
      const prompt = buildUserPrompt([symbol], ['purpose'], []);
      expect(prompt).toContain('Logger (class): "Logging utility"');
    });

    it('shows "not yet annotated" for deps without annotations', () => {
      const symbol = makeSymbol({
        dependencies: [
          {
            name: 'Helper',
            kind: 'function',
            filePath: '/src/helper.ts',
            line: 1,
            dependencyId: 11,
            aspectValue: null,
          },
        ],
      });
      const prompt = buildUserPrompt([symbol], ['purpose'], []);
      expect(prompt).toContain('Helper (function): (not yet annotated)');
    });

    it('shows "Dependencies: none" for zero deps', () => {
      const prompt = buildUserPrompt([makeSymbol()], ['purpose'], []);
      expect(prompt).toContain('Dependencies: none');
    });

    it('includes aspects in request line', () => {
      const prompt = buildUserPrompt([makeSymbol()], ['purpose', 'domain', 'role'], []);
      expect(prompt).toContain('Respond with CSV annotations for: purpose, domain, role');
    });
  });

  // ============================================
  // buildUserPromptEnhanced
  // ============================================
  describe('buildUserPromptEnhanced', () => {
    const makeEnhancedSymbol = (overrides?: Partial<SymbolContextEnhanced>): SymbolContextEnhanced => ({
      id: 42,
      name: 'UserService',
      kind: 'class',
      filePath: '/src/services/user.ts',
      line: 10,
      endLine: 50,
      sourceCode: 'class UserService {}',
      isExported: true,
      dependencies: [],
      relationshipsToAnnotate: [],
      incomingDependencies: [],
      incomingDependencyCount: 0,
      ...overrides,
    });

    it('shows enhanced dependency context with all aspects', () => {
      const symbol = makeEnhancedSymbol({
        dependencies: [
          {
            id: 10,
            name: 'Logger',
            kind: 'class',
            filePath: '/src/logger.ts',
            line: 1,
            purpose: 'Logging utility',
            domains: ['logging'],
            role: 'utility',
            pure: false,
          },
        ],
      });
      const prompt = buildUserPromptEnhanced([symbol], ['purpose'], []);
      expect(prompt).toContain('Logger (#10)');
      expect(prompt).toContain('"Logging utility"');
      expect(prompt).toContain('domains: ["logging"]');
      expect(prompt).toContain('role: "utility"');
      expect(prompt).toContain('pure: false');
    });

    it('shows "not yet annotated" for deps with no annotations', () => {
      const symbol = makeEnhancedSymbol({
        dependencies: [
          {
            id: 10,
            name: 'Foo',
            kind: 'function',
            filePath: '/f.ts',
            line: 1,
            purpose: null,
            domains: null,
            role: null,
            pure: null,
          },
        ],
      });
      const prompt = buildUserPromptEnhanced([symbol], ['purpose'], []);
      expect(prompt).toContain('(not yet annotated)');
    });

    it('shows relationships to annotate', () => {
      const symbol = makeEnhancedSymbol({
        relationshipsToAnnotate: [
          { toId: 15, toName: 'AuthService', toKind: 'class', usageLine: 25, relationshipType: 'uses' },
        ],
      });
      const prompt = buildUserPromptEnhanced([symbol], ['purpose'], []);
      expect(prompt).toContain('[uses]');
      expect(prompt).toContain('AuthService (#15)');
      expect(prompt).toContain('line 25');
    });

    it('shows incoming dependencies', () => {
      const symbol = makeEnhancedSymbol({
        incomingDependencies: [{ id: 99, name: 'Controller', kind: 'class', filePath: '/ctrl.ts' }],
        incomingDependencyCount: 1,
      });
      const prompt = buildUserPromptEnhanced([symbol], ['purpose'], []);
      expect(prompt).toContain('Incoming dependencies (1)');
      expect(prompt).toContain('Controller (class) from /ctrl.ts');
    });

    it('shows partial incoming count', () => {
      const symbol = makeEnhancedSymbol({
        incomingDependencies: [{ id: 99, name: 'Controller', kind: 'class', filePath: '/ctrl.ts' }],
        incomingDependencyCount: 5,
      });
      const prompt = buildUserPromptEnhanced([symbol], ['purpose'], []);
      expect(prompt).toContain('1 of 5 total');
    });

    it('shows export status', () => {
      const exported = makeEnhancedSymbol({ isExported: true });
      const internal = makeEnhancedSymbol({ isExported: false });
      expect(buildUserPromptEnhanced([exported], ['purpose'], [])).toContain('Symbol is exported: yes');
      expect(buildUserPromptEnhanced([internal], ['purpose'], [])).toContain('Symbol is exported: no');
    });

    it('includes aspects and relationship annotation request', () => {
      const prompt = buildUserPromptEnhanced([makeEnhancedSymbol()], ['purpose', 'domain'], []);
      expect(prompt).toContain('Annotate aspects: purpose, domain');
      expect(prompt).toContain('Include relationship annotations');
    });
  });

  // ============================================
  // Module Detection Prompts
  // ============================================
  describe('buildModuleSystemPrompt', () => {
    it('includes layer descriptions', () => {
      const prompt = buildModuleSystemPrompt();
      expect(prompt).toContain('controller');
      expect(prompt).toContain('service');
      expect(prompt).toContain('repository');
      expect(prompt).toContain('adapter');
      expect(prompt).toContain('utility');
    });

    it('includes CSV format', () => {
      const prompt = buildModuleSystemPrompt();
      expect(prompt).toContain('module_id,name,layer,subsystem,description');
    });
  });

  describe('buildModuleUserPrompt', () => {
    it('formats module candidates', () => {
      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          members: [
            { id: 42, name: 'UserService', kind: 'class', filePath: '/user.ts', domains: ['auth'], role: 'service' },
          ],
          internalEdges: 5,
          externalEdges: 3,
          dominantDomains: ['auth'],
          dominantRoles: ['service'],
        },
      ];

      const prompt = buildModuleUserPrompt(candidates);
      expect(prompt).toContain('Module Candidates (1)');
      expect(prompt).toContain('Module Candidate #1 (1 members)');
      expect(prompt).toContain('Internal edges: 5');
      expect(prompt).toContain('External edges: 3');
      expect(prompt).toContain('Dominant domains: auth');
      expect(prompt).toContain('Dominant roles: service');
      expect(prompt).toContain('UserService (class) (service) [auth]');
    });

    it('omits domains/roles when empty', () => {
      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          members: [{ id: 42, name: 'Helper', kind: 'function', filePath: '/h.ts', domains: [], role: null }],
          internalEdges: 0,
          externalEdges: 0,
          dominantDomains: [],
          dominantRoles: [],
        },
      ];

      const prompt = buildModuleUserPrompt(candidates);
      expect(prompt).not.toContain('Dominant domains:');
      expect(prompt).not.toContain('Dominant roles:');
      expect(prompt).toContain('Helper (function)');
      expect(prompt).not.toContain('[]');
    });
  });
});
