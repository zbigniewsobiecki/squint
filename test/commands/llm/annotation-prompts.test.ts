import { describe, expect, it } from 'vitest';
import {
  type SymbolContextEnhanced,
  buildRelationshipSystemPrompt,
  buildRelationshipUserPrompt,
  buildSystemPrompt,
  buildUserPromptEnhanced,
} from '../../../src/commands/llm/_shared/prompts.js';
import type { CoverageInfo, RelationshipSourceGroup } from '../../../src/commands/llm/_shared/prompts.js';

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

    // PR1/3: identity-vs-context guidance for the domain aspect.
    // The LLM tags symbols by consumer-context vocabulary (e.g. "task-management"
    // for an event bus that happens to deliver task events). The guidance biases
    // it toward identity vocabulary instead. Few-shot examples are deliberately
    // drawn from domains NOT present in either eval fixture (weather, compression,
    // cache-eviction) so the eval measures generalization, not memorization. See
    // CLAUDE.md "Prompt examples must NOT leak the eval answers".
    it('domain aspect includes identity-vs-context guidance (typescript)', () => {
      const prompt = buildSystemPrompt(['domain'], 'typescript');
      expect(prompt).toContain("Tag the symbol's IDENTITY (what it IS), not its CONTEXT");
    });

    it('domain aspect includes non-leaky few-shot examples', () => {
      const prompt = buildSystemPrompt(['domain'], 'typescript');
      // Three examples in three unrelated domains (weather, compression, cache eviction)
      // — none of which appear in the bookstore-api or todo-api eval fixtures.
      expect(prompt).toContain('WeatherFetcher');
      expect(prompt).toContain('["weather", "http-client"]');
      expect(prompt).toContain('CompressionWriter');
      expect(prompt).toContain('LRUEvictionPolicy');
    });

    it('domain aspect identity guidance applies to ruby too', () => {
      const prompt = buildSystemPrompt(['domain'], 'ruby');
      expect(prompt).toContain("Tag the symbol's IDENTITY");
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

    it('uses typescript code fence by default', () => {
      const symbol = makeEnhancedSymbol({ sourceCode: 'const x = 1;' });
      const prompt = buildUserPromptEnhanced([symbol], ['purpose'], []);
      expect(prompt).toContain('```typescript');
    });

    it('uses ruby code fence when language is ruby', () => {
      const symbol = makeEnhancedSymbol({ sourceCode: 'def hello; end' });
      const prompt = buildUserPromptEnhanced([symbol], ['purpose'], [], 'ruby');
      expect(prompt).toContain('```ruby');
      expect(prompt).not.toContain('```typescript');
    });
  });

  // ============================================
  // Language-aware buildSystemPrompt
  // ============================================
  describe('buildSystemPrompt — language parameterization', () => {
    it('defaults to TypeScript/JavaScript label', () => {
      const prompt = buildSystemPrompt(['purpose']);
      expect(prompt).toContain('TypeScript/JavaScript');
    });

    it('uses TypeScript/JavaScript label for typescript language', () => {
      const prompt = buildSystemPrompt(['purpose'], 'typescript');
      expect(prompt).toContain('TypeScript/JavaScript');
    });

    it('uses TypeScript/JavaScript label for javascript language', () => {
      const prompt = buildSystemPrompt(['purpose'], 'javascript');
      expect(prompt).toContain('TypeScript/JavaScript');
    });

    it('uses Ruby/Rails label for ruby language', () => {
      const prompt = buildSystemPrompt(['purpose'], 'ruby');
      expect(prompt).toContain('Ruby/Rails');
      expect(prompt).not.toContain('TypeScript/JavaScript');
    });

    it('uses TypeScript/JavaScript pure guidelines by default', () => {
      const prompt = buildSystemPrompt(['pure']);
      expect(prompt).toContain('vi.fn()');
      expect(prompt).toContain('process.env');
      expect(prompt).toContain('useXxx()');
    });

    it('uses Ruby-specific pure guidelines for ruby language', () => {
      const prompt = buildSystemPrompt(['pure'], 'ruby');
      expect(prompt).toContain('@variable =');
      expect(prompt).toContain('ActiveRecord');
      expect(prompt).toContain('redirect_to');
    });

    it('does not include TypeScript-specific pure patterns for ruby', () => {
      const prompt = buildSystemPrompt(['pure'], 'ruby');
      expect(prompt).not.toContain('vi.fn()');
      expect(prompt).not.toContain('useXxx()');
    });

    it('uses Rails-specific role description for ruby language', () => {
      const prompt = buildSystemPrompt(['role'], 'ruby');
      expect(prompt).toContain('serializer');
      expect(prompt).toContain('mailer');
      expect(prompt).toContain('job');
      expect(prompt).toContain('concern');
    });

    it('does not mention Rails-specific roles for typescript', () => {
      const prompt = buildSystemPrompt(['role'], 'typescript');
      expect(prompt).not.toContain('serializer');
      expect(prompt).not.toContain('mailer');
    });

    it('ruby pure aspect description mentions @ivar mutation', () => {
      const prompt = buildSystemPrompt(['pure'], 'ruby');
      expect(prompt).toContain('@ivar');
    });

    it('ruby pure aspect description mentions ActiveRecord finders', () => {
      const prompt = buildSystemPrompt(['pure'], 'ruby');
      expect(prompt).toContain('Model.find');
    });
  });

  // ============================================
  // buildUserPromptEnhanced — existingDomains
  // ============================================
  describe('buildUserPromptEnhanced — existingDomains', () => {
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

    it('includes existing domains section when domains provided and domain in aspects', () => {
      const prompt = buildUserPromptEnhanced([makeEnhancedSymbol()], ['domain'], [], 'typescript', [
        'authentication',
        'billing',
        'user-management',
      ]);
      expect(prompt).toContain('## Existing Domain Tags');
      expect(prompt).toContain('authentication, billing, user-management');
      expect(prompt).toContain('Prefer reusing');
    });

    it('omits existing domains section when no domains provided', () => {
      const prompt = buildUserPromptEnhanced([makeEnhancedSymbol()], ['domain'], [], 'typescript');
      expect(prompt).not.toContain('## Existing Domain Tags');
    });

    it('omits existing domains section when empty array provided', () => {
      const prompt = buildUserPromptEnhanced([makeEnhancedSymbol()], ['domain'], [], 'typescript', []);
      expect(prompt).not.toContain('## Existing Domain Tags');
    });

    it('omits existing domains section when domain is not in aspects', () => {
      const prompt = buildUserPromptEnhanced([makeEnhancedSymbol()], ['purpose', 'pure'], [], 'typescript', [
        'authentication',
      ]);
      expect(prompt).not.toContain('## Existing Domain Tags');
    });

    it('truncates large domain list (100+ entries) with ellipsis', () => {
      const domains = Array.from({ length: 120 }, (_, i) => `domain-${i}`);
      const prompt = buildUserPromptEnhanced([makeEnhancedSymbol()], ['domain'], [], 'typescript', domains);
      expect(prompt).toContain('## Existing Domain Tags');
      // Should contain the first 80 domains
      expect(prompt).toContain('domain-0');
      expect(prompt).toContain('domain-79');
      // Should NOT contain domains beyond 80
      expect(prompt).not.toContain('domain-80,');
      expect(prompt).not.toContain('domain-119,');
      // Should show the truncation message
      expect(prompt).toContain('... and 40 more');
    });

    it('does not truncate domain list with 80 or fewer entries', () => {
      const domains = Array.from({ length: 80 }, (_, i) => `domain-${i}`);
      const prompt = buildUserPromptEnhanced([makeEnhancedSymbol()], ['domain'], [], 'typescript', domains);
      expect(prompt).toContain('domain-79');
      expect(prompt).not.toContain('... and');
    });
  });

  // ============================================
  // Language-aware buildRelationshipSystemPrompt
  // ============================================
  describe('buildRelationshipSystemPrompt — language parameterization', () => {
    it('defaults to TypeScript/JavaScript label', () => {
      const prompt = buildRelationshipSystemPrompt();
      expect(prompt).toContain('TypeScript/JavaScript');
    });

    it('uses Ruby/Rails label for ruby language', () => {
      const prompt = buildRelationshipSystemPrompt('ruby');
      expect(prompt).toContain('Ruby/Rails');
      expect(prompt).not.toContain('TypeScript/JavaScript');
    });

    it('uses TypeScript/JavaScript label for typescript language', () => {
      const prompt = buildRelationshipSystemPrompt('typescript');
      expect(prompt).toContain('TypeScript/JavaScript');
    });
  });

  // ============================================
  // Language-aware buildRelationshipUserPrompt
  // ============================================
  describe('buildRelationshipUserPrompt — language parameterization', () => {
    const makeGroup = (overrides?: Partial<RelationshipSourceGroup>): RelationshipSourceGroup => ({
      id: 42,
      name: 'UserService',
      kind: 'class',
      filePath: '/src/services/user.ts',
      line: 1,
      endLine: 20,
      sourceCode: 'class UserService {}',
      purpose: null,
      domains: null,
      role: null,
      relationships: [],
      ...overrides,
    });

    it('uses typescript code fence by default', () => {
      const prompt = buildRelationshipUserPrompt([makeGroup()]);
      expect(prompt).toContain('```typescript');
    });

    it('uses ruby code fence when language is ruby', () => {
      const group = makeGroup({ sourceCode: 'class UserService; end' });
      const prompt = buildRelationshipUserPrompt([group], 'ruby');
      expect(prompt).toContain('```ruby');
      expect(prompt).not.toContain('```typescript');
    });
  });
});
