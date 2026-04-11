import type { SyntaxNode } from 'tree-sitter';
import type { Definition } from '../../definition-extractor.js';

/**
 * Returns true iff the given `module` node is a pure namespace wrapper:
 * its body contains at least one class declaration AND no own state
 * (no methods, constants, includes, or other top-level statements).
 *
 * Nested namespace-only modules count as classes for the purposes of
 * the outer module's check (so `module Outer; module Inner; class C; end; end; end`
 * marks Outer as namespace-only too).
 *
 * Empty modules (`module Foo; end`) are NOT namespace-only — they have no
 * wrapped class for the symbols stage's LLM to mis-describe, so emitting
 * them as definitions is harmless.
 */
function isNamespaceOnlyModule(moduleNode: SyntaxNode): boolean {
  let hasClass = false;
  let disqualified = false;

  function inspect(child: SyntaxNode): void {
    if (disqualified) return;
    if (!child.isNamed) return;
    if (child.type === 'name' || child.type === 'constant') return;

    // tree-sitter-ruby may wrap module bodies in a body_statement node
    if (child.type === 'body_statement') {
      for (let i = 0; i < child.childCount; i++) {
        const grand = child.child(i);
        if (grand) inspect(grand);
        if (disqualified) return;
      }
      return;
    }

    if (child.type === 'class') {
      hasClass = true;
      return;
    }

    if (child.type === 'module') {
      if (isNamespaceOnlyModule(child)) {
        hasClass = true;
      } else {
        disqualified = true;
      }
      return;
    }

    // Any other named node (method, singleton_method, assignment, call,
    // identifier, ...) is own state and disqualifies the module.
    disqualified = true;
  }

  for (let i = 0; i < moduleNode.childCount; i++) {
    const child = moduleNode.child(i);
    if (child) inspect(child);
    if (disqualified) break;
  }

  return hasClass && !disqualified;
}

/**
 * Ruby-specific definition extractor.
 * Handles classes, modules, methods, constants, and attr_* macros.
 */
export function extractRubyDefinitions(rootNode: SyntaxNode): Definition[] {
  const definitions: Definition[] = [];
  let currentVisibility: 'public' | 'private' | 'protected' = 'public';

  function walk(node: SyntaxNode): void {
    switch (node.type) {
      case 'class': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const superclassNode = node.childForFieldName('superclass');
          let extendsName: string | undefined;
          if (superclassNode) {
            // superclass node contains '<' and the actual constant
            for (let i = 0; i < superclassNode.childCount; i++) {
              const child = superclassNode.child(i);
              if (child && (child.type === 'constant' || child.type === 'scope_resolution')) {
                extendsName = child.text;
                break;
              }
            }
          }

          definitions.push({
            name: nameNode.text,
            kind: 'class',
            isExported: true, // Ruby classes are generally public
            isDefault: false,
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
            ...(extendsName && { extends: extendsName }),
          });
        }
        // Reset visibility inside class
        const savedVisibility = currentVisibility;
        currentVisibility = 'public';

        // Walk all children to find body_statement or other nodes
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type !== 'constant' && child.type !== 'superclass' && child.type !== 'name') {
            walk(child);
          }
        }

        currentVisibility = savedVisibility;
        break;
      }

      case 'module': {
        const nameNode = node.childForFieldName('name');
        // Namespace-only modules (`module Api ... end` whose body is purely
        // class declarations) are not emitted as their own definitions because
        // the symbols stage cannot meaningfully describe them — its prompt feeds
        // the full module source, which contains the wrapped class, and the LLM
        // ends up describing the class instead of the namespace. The contained
        // classes are still emitted via the recursive walk below. Empty modules
        // are kept because they don't trigger the bug (there's no class for the
        // LLM to mis-describe).
        if (nameNode && !isNamespaceOnlyModule(node)) {
          definitions.push({
            name: nameNode.text,
            kind: 'module',
            isExported: true,
            isDefault: false,
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
          });
        }
        // Reset visibility inside module
        const savedVisibility = currentVisibility;
        currentVisibility = 'public';

        // Walk all children
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type !== 'constant' && child.type !== 'name') {
            walk(child);
          }
        }

        currentVisibility = savedVisibility;
        break;
      }

      case 'method':
      case 'singleton_method': {
        const nameNode = node.childForFieldName('name');
        const objectNode = node.type === 'singleton_method' ? node.childForFieldName('object') : null;

        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'method',
            isExported: node.type === 'singleton_method' ? true : currentVisibility === 'public',
            isDefault: false,
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
          });
        }

        // Walk into children (body, etc.) for nested definitions
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (
            child &&
            child !== nameNode &&
            child !== objectNode &&
            child.type !== 'method_parameters' &&
            child.type !== 'parameters'
          ) {
            walk(child);
          }
        }
        break;
      }

      case 'identifier': {
        const text = node.text;
        if (text === 'public' || text === 'private' || text === 'protected') {
          currentVisibility = text as 'public' | 'private' | 'protected';
        }
        break;
      }

      case 'assignment': {
        const leftNode = node.childForFieldName('left');
        if (leftNode && (leftNode.type === 'constant' || leftNode.type === 'scope_resolution')) {
          definitions.push({
            name: leftNode.text,
            kind: 'const',
            isExported: true,
            isDefault: false,
            position: { row: leftNode.startPosition.row, column: leftNode.startPosition.column },
            endPosition: { row: leftNode.endPosition.row, column: leftNode.endPosition.column },
            declarationEndPosition: { row: leftNode.endPosition.row, column: leftNode.endPosition.column },
          });
        }
        // Walk into RHS for nested definitions
        const rightNode = node.childForFieldName('right');
        if (rightNode) {
          walk(rightNode);
        }
        break;
      }

      case 'call': {
        const methodNode = node.childForFieldName('method');
        if (methodNode) {
          const methodName = methodNode.text;
          const argumentsNode = node.childForFieldName('arguments');

          // Handle visibility declarations
          if (methodName === 'private' || methodName === 'protected' || methodName === 'public') {
            if (!argumentsNode) {
              currentVisibility = methodName as 'public' | 'private' | 'protected';
            } else {
              // Handle 'private def foo' style
              const savedVisibility = currentVisibility;
              currentVisibility = methodName as 'public' | 'private' | 'protected';
              walk(argumentsNode);
              currentVisibility = savedVisibility;
            }
          }

          // Handle attr_* macros
          if (methodName === 'attr_reader' || methodName === 'attr_writer' || methodName === 'attr_accessor') {
            if (argumentsNode) {
              for (let i = 0; i < argumentsNode.childCount; i++) {
                const arg = argumentsNode.child(i);
                if (arg && (arg.type === 'simple_symbol' || arg.type === 'symbol' || arg.type === 'string')) {
                  // Remove leading colon from symbol or quotes from string
                  const attrName = arg.text.replace(/^:/, '').replace(/^['"]|['"]$/g, '');

                  if (methodName === 'attr_reader' || methodName === 'attr_accessor') {
                    definitions.push({
                      name: attrName,
                      kind: 'method',
                      isExported: currentVisibility === 'public',
                      isDefault: false,
                      position: { row: arg.startPosition.row, column: arg.startPosition.column },
                      endPosition: { row: arg.endPosition.row, column: arg.endPosition.column },
                      declarationEndPosition: { row: arg.endPosition.row, column: arg.endPosition.column },
                    });
                  }

                  if (methodName === 'attr_writer' || methodName === 'attr_accessor') {
                    definitions.push({
                      name: `${attrName}=`,
                      kind: 'method',
                      isExported: currentVisibility === 'public',
                      isDefault: false,
                      position: { row: arg.startPosition.row, column: arg.startPosition.column },
                      endPosition: { row: arg.endPosition.row, column: arg.endPosition.column },
                      declarationEndPosition: { row: arg.endPosition.row, column: arg.endPosition.column },
                    });
                  }
                }
              }
            }
          }
        }

        // Walk into arguments and block for other calls to find nested definitions
        // (If it was a visibility modifier with args, we already walked them)
        const methodNode2 = node.childForFieldName('method');
        const methodName2 = methodNode2?.text;
        const argumentsNode2 = node.childForFieldName('arguments');
        const isVisibilityWithArgs =
          (methodName2 === 'private' || methodName2 === 'protected' || methodName2 === 'public') && argumentsNode2;

        if (!isVisibilityWithArgs) {
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && child !== methodNode2) {
              walk(child);
            }
          }
        }
        break;
      }

      default:
        // Continue walking for other nodes
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walk(child);
        }
        break;
    }
  }

  walk(rootNode);
  return definitions;
}
