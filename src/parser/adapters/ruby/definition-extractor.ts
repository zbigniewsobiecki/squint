import type { SyntaxNode } from 'tree-sitter';
import type { Definition } from '../../definition-extractor.js';

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
          if (child && child.type !== 'constant' && child.type !== 'superclass') {
            walk(child);
          }
        }

        currentVisibility = savedVisibility;
        break;
      }

      case 'module': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
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
          if (child && child.type !== 'constant') {
            walk(child);
          }
        }

        currentVisibility = savedVisibility;
        break;
      }

      case 'method':
      case 'singleton_method': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'method',
            isExported: currentVisibility === 'public',
            isDefault: false,
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
          });
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
        break;
      }

      case 'identifier': {
        const name = node.text;
        if (name === 'private' || name === 'protected' || name === 'public') {
          currentVisibility = name as 'public' | 'private' | 'protected';
        }
        break;
      }

      case 'call': {
        const methodNode = node.childForFieldName('method');
        if (methodNode) {
          const methodName = methodNode.text;

          // Handle visibility declarations
          if (methodName === 'private' || methodName === 'protected' || methodName === 'public') {
            const argumentsNode = node.childForFieldName('arguments');
            if (!argumentsNode) {
              currentVisibility = methodName as 'public' | 'private' | 'protected';
            }
          }

          // Handle attr_* macros
          if (methodName === 'attr_reader' || methodName === 'attr_writer' || methodName === 'attr_accessor') {
            const argumentsNode = node.childForFieldName('arguments');
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
