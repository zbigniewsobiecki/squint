import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import { extractRubyDefinitions } from '../../../src/parser/adapters/ruby/definition-extractor.js';

const parser = new Parser();
parser.setLanguage(Ruby);

describe('extractRubyDefinitions', () => {
  it('extracts classes and modules', () => {
    const code = `
      class MyClass < Base
      end

      module MyModule
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(expect.objectContaining({ name: 'MyClass', kind: 'class', extends: 'Base' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'MyModule', kind: 'module' }));
  });

  it('extracts methods with visibility', () => {
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

    expect(definitions).toContainEqual(expect.objectContaining({ name: 'public_method', isExported: true }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'private_method', isExported: false }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'protected_method', isExported: false }));
  });

  it('extracts constants', () => {
    const code = `
      MY_CONST = 1
      Nested::CONST = 2
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(expect.objectContaining({ name: 'MY_CONST', kind: 'const' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'Nested::CONST', kind: 'const' }));
  });

  it('extracts attr_* macros', () => {
    const code = `
      class MyClass
        attr_reader :readable
        attr_writer :writable
        attr_accessor :both
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(expect.objectContaining({ name: 'readable', kind: 'method' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'writable=', kind: 'method' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'both', kind: 'method' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'both=', kind: 'method' }));
  });

  it('singleton methods are always public', () => {
    const code = `
      class MyClass
        private
        def self.my_singleton_method; end
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    const def = definitions.find(d => d.name === 'my_singleton_method');
    expect(def).toBeDefined();
    expect(def?.isExported).toBe(true);
  });

  it('handles private def foo style declarations', () => {
    const code = `
      class MyClass
        private def my_private_method; end
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    const def = definitions.find(d => d.name === 'my_private_method');
    expect(def).toBeDefined();
    expect(def?.isExported).toBe(false);
  });

  it('walks into call nodes for nested definitions', () => {
    const code = `
      some_method { class NestedInBlock; end }
      other_method(class NestedInArgs; end)
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(expect.objectContaining({ name: 'NestedInBlock', kind: 'class' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'NestedInArgs', kind: 'class' }));
  });

  it('walks into assignment nodes for RHS definitions', () => {
    const code = `
      MY_CONST = class NestedInAssignment; end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(expect.objectContaining({ name: 'MY_CONST', kind: 'const' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'NestedInAssignment', kind: 'class' }));
  });

  it('walks into method bodies for nested definitions', () => {
    const code = `
      def my_method
        class NestedInMethod; end
      end
    `;
    const tree = parser.parse(code);
    const definitions = extractRubyDefinitions(tree.rootNode);

    expect(definitions).toContainEqual(expect.objectContaining({ name: 'my_method', kind: 'method' }));
    expect(definitions).toContainEqual(expect.objectContaining({ name: 'NestedInMethod', kind: 'class' }));
  });
});