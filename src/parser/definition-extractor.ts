import type { SyntaxNode } from 'tree-sitter';

export type DefinitionKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'const'
  | 'type'
  | 'interface'
  | 'enum';

export interface Definition {
  name: string;
  kind: DefinitionKind;
  isExported: boolean;
  isDefault: boolean;
  position: { row: number; column: number };
  endPosition: { row: number; column: number };
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
          });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const exportInfo = exportedNames.get(name);
          definitions.push({
            name,
            kind: 'class',
            isExported: directlyExported || !!exportInfo,
            isDefault: directDefault || (exportInfo?.isDefault ?? false),
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
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
              definitions.push({
                name,
                kind,
                isExported: directlyExported || !!exportInfo,
                isDefault: directDefault || (exportInfo?.isDefault ?? false),
                position: { row: node.startPosition.row, column: node.startPosition.column },
                endPosition: { row: node.endPosition.row, column: node.endPosition.column },
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
          });
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const exportInfo = exportedNames.get(name);
          definitions.push({
            name,
            kind: 'interface',
            isExported: directlyExported || !!exportInfo,
            isDefault: directDefault || (exportInfo?.isDefault ?? false),
            position: { row: node.startPosition.row, column: node.startPosition.column },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column },
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
