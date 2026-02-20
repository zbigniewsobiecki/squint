import type { SyntaxNode } from 'tree-sitter';

export type DefinitionKind = 'function' | 'class' | 'variable' | 'const' | 'type' | 'interface' | 'enum';

export interface Definition {
  name: string;
  kind: DefinitionKind;
  isExported: boolean;
  isDefault: boolean;
  position: { row: number; column: number };
  endPosition: { row: number; column: number };
  /** Syntactic end of the declaration (before any EOF extension). Used for relationship queries. Defaults to endPosition. */
  declarationEndPosition?: { row: number; column: number };
  extends?: string; // Parent class name (classes only)
  implements?: string[]; // Implemented interfaces (classes only)
  extendsAll?: string[]; // Extended interfaces (interfaces only, can be multiple)
}

interface ExportedName {
  name: string;
  isDefault: boolean;
}

/**
 * Collect all exported names from export statements
 */
function collectExportedNames(rootNode: SyntaxNode): Map<string, ExportedName> {
  const exportedNames = new Map<string, ExportedName>();

  function walk(node: SyntaxNode): void {
    if (node.type === 'export_statement') {
      // Check for export { foo, bar } or export { foo as bar }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'export_clause') {
          for (let j = 0; j < child.childCount; j++) {
            const specifier = child.child(j);
            if (specifier?.type === 'export_specifier') {
              const nameNode = specifier.childForFieldName('name');
              if (nameNode) {
                exportedNames.set(nameNode.text, {
                  name: nameNode.text,
                  isDefault: false,
                });
              }
            }
          }
        }
      }

      // Check for export default identifier
      const declaration = node.childForFieldName('declaration');
      if (!declaration) {
        // Could be export default <identifier>
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.text === 'default') {
            const next = node.child(i + 1);
            if (next?.type === 'identifier') {
              exportedNames.set(next.text, {
                name: next.text,
                isDefault: true,
              });
            }
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(rootNode);
  return exportedNames;
}

/**
 * Check if a node is directly exported (has export keyword as parent or sibling)
 */
function isDirectlyExported(node: SyntaxNode): { exported: boolean; isDefault: boolean } {
  const parent = node.parent;
  if (!parent) return { exported: false, isDefault: false };

  // Check if parent is export_statement
  if (parent.type === 'export_statement') {
    // Check for 'default' keyword
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i);
      if (child?.text === 'default') {
        return { exported: true, isDefault: true };
      }
    }
    return { exported: true, isDefault: false };
  }

  return { exported: false, isDefault: false };
}

/**
 * Extract the name from a variable declarator
 */
function getVariableName(declarator: SyntaxNode): string | null {
  const nameNode = declarator.childForFieldName('name');
  if (nameNode?.type === 'identifier') {
    return nameNode.text;
  }
  // Destructuring patterns are ignored for now
  return null;
}

/**
 * Get variable declaration kind (const, let, var)
 */
function getVariableKind(varDecl: SyntaxNode): 'const' | 'variable' {
  for (let i = 0; i < varDecl.childCount; i++) {
    const child = varDecl.child(i);
    if (child?.text === 'const') return 'const';
  }
  return 'variable';
}

/**
 * Extract class inheritance info (extends and implements)
 */
function extractClassInheritance(classNode: SyntaxNode): { extends?: string; implements?: string[] } {
  const result: { extends?: string; implements?: string[] } = {};

  // Look for class_heritage child
  for (let i = 0; i < classNode.childCount; i++) {
    const child = classNode.child(i);
    if (child?.type === 'class_heritage') {
      // Process heritage clauses
      for (let j = 0; j < child.childCount; j++) {
        const clause = child.child(j);
        if (clause?.type === 'extends_clause') {
          // Get the identifier from extends clause
          // Structure: extends_clause -> identifier (or generic_type)
          for (let k = 0; k < clause.childCount; k++) {
            const typeNode = clause.child(k);
            if (typeNode?.type === 'identifier' || typeNode?.type === 'type_identifier') {
              result.extends = typeNode.text;
              break;
            }
            if (typeNode?.type === 'generic_type') {
              // For generic types like Base<T>, get the base name
              const nameNode = typeNode.childForFieldName('name');
              if (nameNode) {
                result.extends = nameNode.text;
              }
              break;
            }
            if (typeNode?.type === 'call_expression') {
              // For call expressions like extends Gadget({...}), get the function name
              const fnNode = typeNode.childForFieldName('function');
              if (fnNode?.type === 'identifier') {
                result.extends = fnNode.text;
              } else if (fnNode?.type === 'member_expression') {
                const property = fnNode.childForFieldName('property');
                if (property) result.extends = property.text;
              }
              break;
            }
          }
        } else if (clause?.type === 'implements_clause') {
          // Get all type identifiers from implements clause
          const interfaces: string[] = [];
          for (let k = 0; k < clause.childCount; k++) {
            const typeNode = clause.child(k);
            if (typeNode?.type === 'type_identifier') {
              interfaces.push(typeNode.text);
            } else if (typeNode?.type === 'generic_type') {
              const nameNode = typeNode.childForFieldName('name');
              if (nameNode) {
                interfaces.push(nameNode.text);
              }
            }
          }
          if (interfaces.length > 0) {
            result.implements = interfaces;
          }
        }
      }
    }
  }

  return result;
}

/**
 * Extract interface extends info (can extend multiple interfaces)
 */
function extractInterfaceExtends(interfaceNode: SyntaxNode): string[] {
  const result: string[] = [];

  // Look for extends_type_clause child
  for (let i = 0; i < interfaceNode.childCount; i++) {
    const child = interfaceNode.child(i);
    if (child?.type === 'extends_type_clause') {
      // Get all type identifiers from extends clause
      for (let j = 0; j < child.childCount; j++) {
        const typeNode = child.child(j);
        if (typeNode?.type === 'type_identifier') {
          result.push(typeNode.text);
        } else if (typeNode?.type === 'generic_type') {
          const nameNode = typeNode.childForFieldName('name');
          if (nameNode) {
            result.push(nameNode.text);
            // Also extract first type argument for extends resolution
            // e.g. Partial<CreateVehicleDto> → ["Partial", "CreateVehicleDto"]
            const typeArgs = typeNode.childForFieldName('type_arguments');
            if (typeArgs) {
              for (let k = 0; k < typeArgs.childCount; k++) {
                const argNode = typeArgs.child(k);
                if (argNode?.type === 'type_identifier') {
                  result.push(argNode.text);
                  break;
                }
              }
            }
          }
        }
      }
    }
  }

  return result;
}

/**
 * Check if a module-level variable has later member expression usages
 * (e.g., `app.use(...)`, `router.get(...)`) that follow the declaration.
 * If so, we need to extend endPosition to EOF to capture those usages.
 */
function hasLaterMemberUsages(name: string, afterRow: number, rootNode: SyntaxNode): boolean {
  function check(node: SyntaxNode): boolean {
    if (node.startPosition.row <= afterRow) return false;

    if (node.type === 'member_expression') {
      const object = node.childForFieldName('object');
      if (object?.type === 'identifier' && object.text === name) {
        return true;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && check(child)) return true;
    }
    return false;
  }

  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child && child.startPosition.row > afterRow && check(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract all top-level definitions from the AST
 */
export function extractDefinitions(rootNode: SyntaxNode): Definition[] {
  const definitions: Definition[] = [];
  const exportedNames = collectExportedNames(rootNode);

  function processNode(node: SyntaxNode): void {
    const { exported: directlyExported, isDefault: directDefault } = isDirectlyExported(node);

    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const exportInfo = exportedNames.get(name);
          definitions.push({
            name,
            kind: 'function',
            isExported: directlyExported || !!exportInfo,
            isDefault: directDefault || (exportInfo?.isDefault ?? false),
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
          });
        }
        break;
      }

      case 'class_declaration':
      case 'abstract_class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const exportInfo = exportedNames.get(name);
          const inheritance = extractClassInheritance(node);
          definitions.push({
            name,
            kind: 'class',
            isExported: directlyExported || !!exportInfo,
            isDefault: directDefault || (exportInfo?.isDefault ?? false),
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
            ...(inheritance.extends && { extends: inheritance.extends }),
            ...(inheritance.implements && { implements: inheritance.implements }),
          });
        }
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        const kind = getVariableKind(node);
        // Process each declarator in the declaration
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.type === 'variable_declarator') {
            const name = getVariableName(child);
            if (name) {
              const exportInfo = exportedNames.get(name);
              // For module-level variables, only extend endPosition to EOF if there are
              // later member expression usages (e.g., `app.use(...)`, `router.get(...)`).
              // Otherwise, use the declaration's own endPosition.
              const extendToEof = hasLaterMemberUsages(name, node.endPosition.row, rootNode);
              definitions.push({
                name,
                kind,
                isExported: directlyExported || !!exportInfo,
                isDefault: directDefault || (exportInfo?.isDefault ?? false),
                position: { row: node.startPosition.row, column: node.startPosition.column },
                endPosition: extendToEof
                  ? { row: rootNode.endPosition.row, column: rootNode.endPosition.column }
                  : { row: node.endPosition.row, column: node.endPosition.column },
                declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
              });
            }
          }
        }
        break;
      }

      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const exportInfo = exportedNames.get(name);
          definitions.push({
            name,
            kind: 'type',
            isExported: directlyExported || !!exportInfo,
            isDefault: directDefault || (exportInfo?.isDefault ?? false),
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
          });
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const exportInfo = exportedNames.get(name);
          const extendsAll = extractInterfaceExtends(node);
          definitions.push({
            name,
            kind: 'interface',
            isExported: directlyExported || !!exportInfo,
            isDefault: directDefault || (exportInfo?.isDefault ?? false),
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
            ...(extendsAll.length > 0 && { extendsAll }),
          });
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const exportInfo = exportedNames.get(name);
          definitions.push({
            name,
            kind: 'enum',
            isExported: directlyExported || !!exportInfo,
            isDefault: directDefault || (exportInfo?.isDefault ?? false),
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
            declarationEndPosition: { row: node.endPosition.row, column: node.endPosition.column },
          });
        }
        break;
      }

      case 'export_statement': {
        // Process the declaration inside export statement
        const declaration = node.childForFieldName('declaration');
        if (declaration) {
          processNode(declaration);
        }
        break;
      }
    }
  }

  // Process only top-level statements (children of program node)
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child) {
      processNode(child);
    }
  }

  return definitions;
}
