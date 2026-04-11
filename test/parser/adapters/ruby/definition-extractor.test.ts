import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import { describe, expect, it } from 'vitest';
import { extractRubyDefinitions } from '../../../../src/parser/adapters/ruby/definition-extractor.js';

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

    const def = definitions.find((d) => d.name === 'my_singleton_method');
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

    const def = definitions.find((d) => d.name === 'my_private_method');
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

  describe('namespace-only modules', () => {
    // Background: a module whose body is purely class declarations is just a Ruby
    // namespace wrapper (e.g. `module Api; class BooksController; end; end`). When
    // such a module is emitted as its own definition, the symbols stage feeds the
    // full module source — including the wrapped class — to the LLM, which then
    // describes the class as if it were the namespace. The fix: skip the module
    // definition entirely, but still walk into the body to extract the wrapped
    // classes. Empty modules are KEPT (no class to mis-describe).

    it('skips namespace-only module wrapping a single class', () => {
      const code = `
        module Api
          class BooksController
          end
        end
      `;
      const tree = parser.parse(code);
      const definitions = extractRubyDefinitions(tree.rootNode);

      expect(definitions).not.toContainEqual(expect.objectContaining({ name: 'Api', kind: 'module' }));
      expect(definitions).toContainEqual(expect.objectContaining({ name: 'BooksController', kind: 'class' }));
    });

    it('keeps module that has its own constant assignment', () => {
      const code = `
        module MyMod
          CONST = 1
          class X
          end
        end
      `;
      const tree = parser.parse(code);
      const definitions = extractRubyDefinitions(tree.rootNode);

      expect(definitions).toContainEqual(expect.objectContaining({ name: 'MyMod', kind: 'module' }));
      expect(definitions).toContainEqual(expect.objectContaining({ name: 'CONST', kind: 'const' }));
      expect(definitions).toContainEqual(expect.objectContaining({ name: 'X', kind: 'class' }));
    });

    it('keeps module that has its own singleton method', () => {
      const code = `
        module MyMod
          def self.helper
          end
        end
      `;
      const tree = parser.parse(code);
      const definitions = extractRubyDefinitions(tree.rootNode);

      expect(definitions).toContainEqual(expect.objectContaining({ name: 'MyMod', kind: 'module' }));
      expect(definitions).toContainEqual(expect.objectContaining({ name: 'helper', kind: 'method' }));
    });

    it('keeps module that has an include directive', () => {
      const code = `
        module MyMod
          include Concern
        end
      `;
      const tree = parser.parse(code);
      const definitions = extractRubyDefinitions(tree.rootNode);

      expect(definitions).toContainEqual(expect.objectContaining({ name: 'MyMod', kind: 'module' }));
    });

    it('skips namespace-only module wrapping multiple classes', () => {
      const code = `
        module MyMod
          class A
          end
          class B
          end
        end
      `;
      const tree = parser.parse(code);
      const definitions = extractRubyDefinitions(tree.rootNode);

      expect(definitions).not.toContainEqual(expect.objectContaining({ name: 'MyMod', kind: 'module' }));
      expect(definitions).toContainEqual(expect.objectContaining({ name: 'A', kind: 'class' }));
      expect(definitions).toContainEqual(expect.objectContaining({ name: 'B', kind: 'class' }));
    });

    it('skips nested namespace-only modules recursively', () => {
      const code = `
        module Outer
          module Inner
            class C
            end
          end
        end
      `;
      const tree = parser.parse(code);
      const definitions = extractRubyDefinitions(tree.rootNode);

      expect(definitions).not.toContainEqual(expect.objectContaining({ name: 'Outer', kind: 'module' }));
      expect(definitions).not.toContainEqual(expect.objectContaining({ name: 'Inner', kind: 'module' }));
      expect(definitions).toContainEqual(expect.objectContaining({ name: 'C', kind: 'class' }));
    });

    // REGRESSION-GUARD: the existing 'extracts classes and modules' test asserts
    // that an empty `module MyModule; end` produces a definition. After the
    // namespace-only fix, empty modules MUST still be extracted because there's
    // no nested class to mis-describe.
    it('keeps empty module (regression guard for the existing test)', () => {
      const code = `
        module Empty
        end
      `;
      const tree = parser.parse(code);
      const definitions = extractRubyDefinitions(tree.rootNode);

      expect(definitions).toContainEqual(expect.objectContaining({ name: 'Empty', kind: 'module' }));
    });
  });
});
