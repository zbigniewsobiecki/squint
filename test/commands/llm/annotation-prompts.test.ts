import { describe, expect, it } from 'vitest';
import {
  type SymbolContextEnhanced,
  buildSystemPrompt,
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
});
