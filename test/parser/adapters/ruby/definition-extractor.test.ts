import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import { describe, expect, it } from 'vitest';
import { extractRubyDefinitions } from '../../../../src/parser/adapters/ruby/definition-extractor.js';

describe('Ruby Definition Extractor', () => {
  const parser = new Parser();
  parser.setLanguage(Ruby);

  it('extracts classes with superclass inheritance', () => {
    const code = `
      class MyClass < BaseClass
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(
      expect.objectContaining({
        name: 'MyClass',
        kind: 'class',
        extends: 'BaseClass',
      })
    );
  });

  it('extracts modules', () => {
    const code = `
      module MyModule
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(
      expect.objectContaining({
        name: 'MyModule',
        kind: 'module',
      })
    );
  });

  it('extracts instance methods', () => {
    const code = `
      class MyClass
        def my_method
        end
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(
      expect.objectContaining({
        name: 'my_method',
        kind: 'method',
      })
    );
  });

  it('extracts singleton methods', () => {
    const code = `
      def self.my_singleton_method
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(
      expect.objectContaining({
        name: 'my_singleton_method',
        kind: 'method',
      })
    );
  });

  it('extracts constants', () => {
    const code = `
      MY_CONST = 123
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(
      expect.objectContaining({
        name: 'MY_CONST',
        kind: 'const',
      })
    );
  });

  it('handles visibility declarations', () => {
    const code = `
      class MyClass
        def public_method; end
        private
        def private_method; end
        protected
        def protected_method; end
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    const publicMethod = definitions.find((d) => d.name === 'public_method');
    const privateMethod = definitions.find((d) => d.name === 'private_method');
    const protectedMethod = definitions.find((d) => d.name === 'protected_method');

    expect(publicMethod?.isExported).toBe(true);
    expect(privateMethod?.isExported).toBe(false);
    expect(protectedMethod?.isExported).toBe(false);
  });

  it('handles attr_reader/writer/accessor', () => {
    const code = `
      class MyClass
        attr_reader :read_only
        attr_writer :write_only
        attr_accessor :read_write
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(expect.objectContaining({ name: 'read_only', kind: 'method' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'write_only=', kind: 'method' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'read_write', kind: 'method' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'read_write=', kind: 'method' }));
  });
});
