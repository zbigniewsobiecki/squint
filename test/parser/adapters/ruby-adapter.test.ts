import { describe, expect, it } from 'vitest';
import { RubyAdapter } from '../../../src/parser/adapters/ruby-adapter.js';
import { LanguageRegistry } from '../../../src/parser/language-adapter.js';

describe('RubyAdapter', () => {
  describe('Adapter Properties', () => {
    it('has correct languageId', () => {
      const adapter = new RubyAdapter();
      expect(adapter.languageId).toBe('ruby');
    });

    it('handles Ruby file extensions', () => {
      const adapter = new RubyAdapter();
      expect(adapter.fileExtensions).toEqual(['.rb', '.rake', '.gemspec']);
    });

    it('has appropriate default ignore patterns', () => {
      const adapter = new RubyAdapter();
      expect(adapter.defaultIgnorePatterns).toContain('**/vendor/**');
      expect(adapter.defaultIgnorePatterns).toContain('**/tmp/**');
      expect(adapter.defaultIgnorePatterns).toContain('**/log/**');
      expect(adapter.defaultIgnorePatterns).toContain('**/.bundle/**');
    });
  });

  describe('Auto-registration', () => {
    it('auto-registers on import', () => {
      // RubyAdapter is auto-registered when the module is imported
      // This happens via src/parser/adapters/index.ts which is likely imported elsewhere
      // or we can just check if it's in the registry now.
      const registry = LanguageRegistry.getInstance();

      expect(registry.hasAdapter('.rb')).toBe(true);
      expect(registry.hasAdapter('.rake')).toBe(true);
      expect(registry.hasAdapter('.gemspec')).toBe(true);
    });

    it('returns RubyAdapter for .rb files', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = registry.getAdapterForFile('/path/to/file.rb');

      expect(adapter).toBeInstanceOf(RubyAdapter);
    });
  });

  describe('getParser', () => {
    it('returns Ruby parser and can parse basic Ruby code', () => {
      const adapter = new RubyAdapter();
      const parser = adapter.getParser('/project/file.rb');

      expect(parser).toBeDefined();

      const code = `
        class MyClass
          def my_method
            puts "Hello"
          end
        end
      `;
      const tree = parser.parse(code);
      expect(tree.rootNode).toBeDefined();
      expect(tree.rootNode.type).toBe('program');
    });

    it('handles .rake files', () => {
      const adapter = new RubyAdapter();
      const parser = adapter.getParser('/project/Rakefile');
      expect(parser).toBeDefined();
    });

    it('handles .gemspec files', () => {
      const adapter = new RubyAdapter();
      const parser = adapter.getParser('/project/my_gem.gemspec');
      expect(parser).toBeDefined();
    });
  });

  describe('Stub Implementations', () => {
    it('returns empty array for extractDefinitions', () => {
      const adapter = new RubyAdapter();
      const parser = adapter.getParser('test.rb');
      const tree = parser.parse('class A; end');
      const definitions = adapter.extractDefinitions(tree.rootNode);
      expect(definitions).toEqual([]);
    });

    it('returns empty array for extractReferences', () => {
      const adapter = new RubyAdapter();
      const parser = adapter.getParser('test.rb');
      const tree = parser.parse('require "other"');
      const references = adapter.extractReferences(tree.rootNode, 'test.rb', new Set());
      expect(references).toEqual([]);
    });

    it('returns empty array for extractInternalUsages', () => {
      const adapter = new RubyAdapter();
      const parser = adapter.getParser('test.rb');
      const tree = parser.parse('a = 1; puts a');
      const usages = adapter.extractInternalUsages(tree.rootNode, []);
      expect(usages).toEqual([]);
    });

    it('returns null for resolveImportPath', () => {
      const adapter = new RubyAdapter();
      const resolved = adapter.resolveImportPath('other', 'test.rb', new Set());
      expect(resolved).toBeNull();
    });
  });
});
