import type { SyntaxNode } from 'tree-sitter';
import path from 'node:path';
import fs from 'node:fs';
import type { Definition } from './definition-extractor.js';

export interface CallsiteMetadata {
  argumentCount: number;
  isMethodCall: boolean;      // true for obj.foo(), false for foo()
  isConstructorCall: boolean; // true for new Foo()
  receiverName?: string;      // 'obj' in obj.foo()
}

export interface SymbolUsage {
  position: { row: number; column: number };
  context: string; // Parent node type: 'call_expression', 'member_expression', etc.
  callsite?: CallsiteMetadata;  // Present when context is 'call_expression' or 'new_expression'
}

export interface ImportedSymbol {
  name: string; // Original exported name
  localName: string; // Name used in this file (may differ due to aliasing)
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  usages: SymbolUsage[];
}

export interface FileReference {
  type: 'import' | 'dynamic-import' | 'require' | 're-export' | 'export-all';
  source: string; // Raw import path
  resolvedPath?: string; // Absolute path if resolvable
  isExternal: boolean; // true for package imports
  isTypeOnly: boolean; // true for `import type`
  imports: ImportedSymbol[];
  position: { row: number; column: number };
}

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

// Cache for package.json imports field lookups
const packageJsonCache = new Map<string, { imports: Record<string, string>; dir: string } | null>();

/**
 * Find the nearest package.json with an imports field
 */
function findPackageJsonImports(startDir: string): { imports: Record<string, string>; dir: string } | null {
  if (packageJsonCache.has(startDir)) {
    return packageJsonCache.get(startDir) ?? null;
  }

  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      if (pkg.imports && typeof pkg.imports === 'object') {
        const result = { imports: pkg.imports, dir };
        packageJsonCache.set(startDir, result);
        return result;
      }
    } catch {
      // not found, continue up the tree
    }
    dir = path.dirname(dir);
  }

  packageJsonCache.set(startDir, null);
  return null;
}

/**
 * Resolve a subpath import (#...) using package.json imports field
 */
function resolveSubpathImport(
  source: string,
  imports: Record<string, string>,
  pkgDir: string
): string | null {
  // Sort by specificity (longer patterns first)
  const patterns = Object.keys(imports).sort((a, b) => b.length - a.length);

  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      // Wildcard pattern: #core/* -> ./src/modules/core/*
      const prefix = pattern.slice(0, pattern.indexOf('*'));
      if (source.startsWith(prefix)) {
        const suffix = source.slice(prefix.length);
        const target = imports[pattern];
        if (typeof target === 'string') {
          const resolved = target.replace('*', suffix);
          return path.resolve(pkgDir, resolved);
        }
      }
    } else if (source === pattern) {
      // Exact match
      const target = imports[pattern];
      if (typeof target === 'string') {
        return path.resolve(pkgDir, target);
      }
    }
  }
  return null;
}

/**
 * Resolve an import path to an absolute path if it exists in the known files set
 */
export function resolveImportPath(
  source: string,
  fromFile: string,
  knownFiles: Set<string>
): string | undefined {
  const fromDir = path.dirname(fromFile);

  // Handle subpath imports (#...)
  if (source.startsWith('#')) {
    const pkgInfo = findPackageJsonImports(fromDir);
    if (pkgInfo) {
      const resolved = resolveSubpathImport(source, pkgInfo.imports, pkgInfo.dir);
      if (resolved) {
        // Try exact match first
        if (knownFiles.has(resolved)) return resolved;
        // Try with extensions
        for (const ext of EXTENSIONS_TO_TRY) {
          if (knownFiles.has(resolved + ext)) return resolved + ext;
        }
        // Try index files
        for (const ext of EXTENSIONS_TO_TRY) {
          const indexPath = path.join(resolved, 'index' + ext);
          if (knownFiles.has(indexPath)) return indexPath;
        }
      }
    }
    return undefined;
  }

  // External packages can't be resolved
  if (!source.startsWith('.') && !source.startsWith('/')) {
    return undefined;
  }

  const resolved = path.resolve(fromDir, source);

  // Try exact match first
  if (knownFiles.has(resolved)) {
    return resolved;
  }

  // Try adding extensions
  for (const ext of EXTENSIONS_TO_TRY) {
    const withExt = resolved + ext;
    if (knownFiles.has(withExt)) {
      return withExt;
    }
  }

  // Handle TypeScript ESM imports that use .js extension
  // (e.g., import './foo.js' when actual file is './foo.ts')
  const ext = path.extname(resolved);
  if (ext === '.js' || ext === '.jsx') {
    const withoutExt = resolved.slice(0, -ext.length);
    const tsExt = ext === '.js' ? '.ts' : '.tsx';
    const tsPath = withoutExt + tsExt;
    if (knownFiles.has(tsPath)) {
      return tsPath;
    }
    // Also try the alternative: .js -> .tsx, .jsx -> .ts
    const altTsExt = ext === '.js' ? '.tsx' : '.ts';
    const altTsPath = withoutExt + altTsExt;
    if (knownFiles.has(altTsPath)) {
      return altTsPath;
    }
  }

  // Try as directory with index file
  for (const indexFile of INDEX_FILES) {
    const withIndex = path.join(resolved, indexFile);
    if (knownFiles.has(withIndex)) {
      return withIndex;
    }
  }

  return undefined;
}

/**
 * Check if an identifier node should be tracked as a usage
 * Returns false for identifiers that are:
 * - Part of import/export declarations
 * - Property names in object literals
 * - Property access on right side
 */
function isValidUsage(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return true;

  const parentType = parent.type;

  // Skip if part of import/export declaration
  if (
    parentType === 'import_specifier' ||
    parentType === 'export_specifier' ||
    parentType === 'import_clause' ||
    parentType === 'namespace_import' ||
    parentType === 'named_imports'
  ) {
    return false;
  }

  // Skip if this is the property name in a property access (right side of .)
  if (parentType === 'member_expression') {
    const propertyNode = parent.childForFieldName('property');
    if (propertyNode && propertyNode.id === node.id) {
      return false;
    }
  }

  // Skip if this is a shorthand property key in object literal
  if (parentType === 'shorthand_property_identifier_pattern') {
    return false;
  }

  // Skip if this is a property key (not value) in object literal
  if (parentType === 'pair') {
    const keyNode = parent.childForFieldName('key');
    if (keyNode && keyNode.id === node.id) {
      return false;
    }
  }

  // Skip if this is part of a function/method/property definition name
  if (
    parentType === 'function_declaration' ||
    parentType === 'method_definition' ||
    parentType === 'class_declaration' ||
    parentType === 'variable_declarator'
  ) {
    const nameNode = parent.childForFieldName('name');
    if (nameNode && nameNode.id === node.id) {
      return false;
    }
  }

  return true;
}

interface UsageInfo {
  context: string;
  callsite?: CallsiteMetadata;
}

/**
 * Count the number of arguments in an arguments node
 */
function countArguments(argsNode: SyntaxNode): number {
  let count = 0;
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child) {
      // Skip punctuation: (, ), ,
      const type = child.type;
      if (type !== '(' && type !== ')' && type !== ',') {
        count++;
      }
    }
  }
  return count;
}

/**
 * Get the context (parent node type) for a usage, with optional callsite metadata
 */
function getUsageContext(node: SyntaxNode): UsageInfo {
  const parent = node.parent;
  if (!parent) return { context: 'unknown' };

  // Check for new_expression (constructor call): new Foo()
  if (parent.type === 'new_expression') {
    const argsNode = parent.childForFieldName('arguments');
    return {
      context: 'new_expression',
      callsite: {
        argumentCount: argsNode ? countArguments(argsNode) : 0,
        isMethodCall: false,
        isConstructorCall: true,
      },
    };
  }

  // Direct function call: foo()
  if (parent.type === 'call_expression') {
    const functionNode = parent.childForFieldName('function');
    // Make sure this identifier is the function being called, not an argument
    if (functionNode && functionNode.id === node.id) {
      const argsNode = parent.childForFieldName('arguments');
      return {
        context: 'call_expression',
        callsite: {
          argumentCount: argsNode ? countArguments(argsNode) : 0,
          isMethodCall: false,
          isConstructorCall: false,
        },
      };
    }
    return { context: 'call_expression' };
  }

  // For member expressions, look at what the member expression is used for
  if (parent.type === 'member_expression') {
    const grandparent = parent.parent;

    // Method call: obj.foo() - the identifier is the object, not the method
    if (grandparent?.type === 'call_expression') {
      // Check if this identifier is the object of the member expression
      const objectNode = parent.childForFieldName('object');
      if (objectNode && objectNode.id === node.id) {
        const argsNode = grandparent.childForFieldName('arguments');
        return {
          context: 'call_expression',
          callsite: {
            argumentCount: argsNode ? countArguments(argsNode) : 0,
            isMethodCall: true,
            isConstructorCall: false,
            receiverName: node.text,
          },
        };
      }
      return { context: 'call_expression' };
    }
    return { context: 'member_expression' };
  }

  return { context: parent.type };
}

/**
 * Find all usages of a symbol name in the AST
 */
export function findSymbolUsages(
  rootNode: SyntaxNode,
  symbolName: string
): SymbolUsage[] {
  const usages: SymbolUsage[] = [];

  function walk(node: SyntaxNode): void {
    // Check both regular identifiers and type identifiers (for type annotations)
    if (
      (node.type === 'identifier' || node.type === 'type_identifier') &&
      node.text === symbolName
    ) {
      if (isValidUsage(node)) {
        const usageInfo = getUsageContext(node);
        const usage: SymbolUsage = {
          position: {
            row: node.startPosition.row,
            column: node.startPosition.column,
          },
          context: usageInfo.context,
        };
        if (usageInfo.callsite) {
          usage.callsite = usageInfo.callsite;
        }
        usages.push(usage);
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        walk(child);
      }
    }
  }

  walk(rootNode);
  return usages;
}

/**
 * Extract the source string from an import/export/require statement
 */
function extractSourceString(node: SyntaxNode): string | null {
  // Look for string child which contains the path
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'string') {
      // Remove quotes from the string
      const text = child.text;
      return text.slice(1, -1);
    }
  }
  return null;
}

/**
 * Check if an import/export is type-only
 */
function isTypeOnlyImport(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'type' || child?.text === 'type') {
      return true;
    }
  }
  return false;
}

/**
 * Extract imported symbols from an import statement
 */
function extractImportedSymbols(
  importNode: SyntaxNode,
  rootNode: SyntaxNode
): ImportedSymbol[] {
  const symbols: ImportedSymbol[] = [];

  const importClause = importNode.childForFieldName('import') ||
    findChildByType(importNode, 'import_clause');

  if (!importClause) {
    // Side-effect import: import './file'
    return [
      {
        name: '*',
        localName: '*',
        kind: 'side-effect',
        usages: [],
      },
    ];
  }

  // Process import clause children
  for (let i = 0; i < importClause.childCount; i++) {
    const child = importClause.child(i);
    if (!child) continue;

    if (child.type === 'identifier') {
      // Default import: import Foo from './file'
      const localName = child.text;
      symbols.push({
        name: 'default',
        localName,
        kind: 'default',
        usages: findSymbolUsages(rootNode, localName),
      });
    } else if (child.type === 'namespace_import') {
      // Namespace import: import * as Foo from './file'
      const nameNode = child.childForFieldName('name') ||
        findChildByType(child, 'identifier');
      if (nameNode) {
        const localName = nameNode.text;
        symbols.push({
          name: '*',
          localName,
          kind: 'namespace',
          usages: findSymbolUsages(rootNode, localName),
        });
      }
    } else if (child.type === 'named_imports') {
      // Named imports: import { A, B as C } from './file'
      for (let j = 0; j < child.childCount; j++) {
        const specifier = child.child(j);
        if (specifier?.type === 'import_specifier') {
          const nameNode = specifier.childForFieldName('name');
          const aliasNode = specifier.childForFieldName('alias');

          const originalName = nameNode?.text || '';
          const localName = aliasNode?.text || originalName;

          if (originalName) {
            symbols.push({
              name: originalName,
              localName,
              kind: 'named',
              usages: findSymbolUsages(rootNode, localName),
            });
          }
        }
      }
    }
  }

  return symbols;
}

/**
 * Extract exported symbols from a re-export statement.
 * For re-exports, we create a synthetic usage at the export location
 * to ensure dependency edges are created in the database.
 */
function extractReExportedSymbols(
  exportNode: SyntaxNode,
  _rootNode: SyntaxNode
): ImportedSymbol[] {
  const symbols: ImportedSymbol[] = [];

  const exportClause = findChildByType(exportNode, 'export_clause');

  // Synthetic usage at the export statement location
  const syntheticUsage: SymbolUsage = {
    position: {
      row: exportNode.startPosition.row,
      column: exportNode.startPosition.column,
    },
    context: 're-export',
  };

  if (!exportClause) {
    // Check for export * from './file'
    for (let i = 0; i < exportNode.childCount; i++) {
      const child = exportNode.child(i);
      if (child?.text === '*') {
        return [
          {
            name: '*',
            localName: '*',
            kind: 'namespace',
            usages: [syntheticUsage],
          },
        ];
      }
    }
    return symbols;
  }

  // Named re-exports: export { A, B as C } from './file'
  for (let i = 0; i < exportClause.childCount; i++) {
    const specifier = exportClause.child(i);
    if (specifier?.type === 'export_specifier') {
      const nameNode = specifier.childForFieldName('name');
      const aliasNode = specifier.childForFieldName('alias');

      const originalName = nameNode?.text || '';
      const localName = aliasNode?.text || originalName;

      if (originalName) {
        symbols.push({
          name: originalName,
          localName,
          kind: 'named',
          usages: [syntheticUsage],
        });
      }
    }
  }

  return symbols;
}

/**
 * Helper to find a child node by type
 */
function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) {
      return child;
    }
  }
  return null;
}

/**
 * Extract dynamic import from a call expression
 */
function extractDynamicImport(
  callNode: SyntaxNode,
  _rootNode: SyntaxNode,
  filePath: string,
  knownFiles: Set<string>
): FileReference | null {
  // Check if this is import()
  const functionNode = callNode.childForFieldName('function');
  if (!functionNode || functionNode.text !== 'import') {
    return null;
  }

  const args = callNode.childForFieldName('arguments');
  if (!args) return null;

  const firstArg = args.child(1); // Skip opening paren
  if (!firstArg || firstArg.type !== 'string') return null;

  const source = firstArg.text.slice(1, -1);
  const isExternal = !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('#');

  return {
    type: 'dynamic-import',
    source,
    resolvedPath: resolveImportPath(source, filePath, knownFiles),
    isExternal,
    isTypeOnly: false,
    imports: [
      {
        name: '*',
        localName: '*',
        kind: 'namespace',
        usages: [],
      },
    ],
    position: {
      row: callNode.startPosition.row,
      column: callNode.startPosition.column,
    },
  };
}

/**
 * Extract require() call from a call expression
 */
function extractRequireCall(
  callNode: SyntaxNode,
  rootNode: SyntaxNode,
  filePath: string,
  knownFiles: Set<string>
): FileReference | null {
  const functionNode = callNode.childForFieldName('function');
  if (!functionNode || functionNode.text !== 'require') {
    return null;
  }

  const args = callNode.childForFieldName('arguments');
  if (!args) return null;

  const firstArg = args.child(1); // Skip opening paren
  if (!firstArg || firstArg.type !== 'string') return null;

  const source = firstArg.text.slice(1, -1);
  const isExternal = !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('#');

  // Try to find what variable this require is assigned to
  const imports: ImportedSymbol[] = [];
  const parent = callNode.parent;

  if (parent?.type === 'variable_declarator') {
    const nameNode = parent.childForFieldName('name');
    if (nameNode) {
      if (nameNode.type === 'identifier') {
        const localName = nameNode.text;
        imports.push({
          name: '*',
          localName,
          kind: 'namespace',
          usages: findSymbolUsages(rootNode, localName),
        });
      } else if (nameNode.type === 'object_pattern') {
        // Destructured require: const { a, b } = require('./file')
        for (let i = 0; i < nameNode.childCount; i++) {
          const prop = nameNode.child(i);
          if (prop?.type === 'shorthand_property_identifier_pattern') {
            const localName = prop.text;
            imports.push({
              name: localName,
              localName,
              kind: 'named',
              usages: findSymbolUsages(rootNode, localName),
            });
          } else if (prop?.type === 'pair_pattern') {
            const keyNode = prop.childForFieldName('key');
            const valueNode = prop.childForFieldName('value');
            if (keyNode && valueNode) {
              imports.push({
                name: keyNode.text,
                localName: valueNode.text,
                kind: 'named',
                usages: findSymbolUsages(rootNode, valueNode.text),
              });
            }
          }
        }
      }
    }
  }

  if (imports.length === 0) {
    imports.push({
      name: '*',
      localName: '*',
      kind: 'side-effect',
      usages: [],
    });
  }

  return {
    type: 'require',
    source,
    resolvedPath: resolveImportPath(source, filePath, knownFiles),
    isExternal,
    isTypeOnly: false,
    imports,
    position: {
      row: callNode.startPosition.row,
      column: callNode.startPosition.column,
    },
  };
}

/**
 * Extract all references from an AST
 */
export function extractReferences(
  rootNode: SyntaxNode,
  filePath: string,
  knownFiles: Set<string>
): FileReference[] {
  const references: FileReference[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === 'import_statement') {
      const source = extractSourceString(node);
      if (source) {
        const isExternal = !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('#');
        const isTypeOnly = isTypeOnlyImport(node);
        const imports = extractImportedSymbols(node, rootNode);

        references.push({
          type: 'import',
          source,
          resolvedPath: resolveImportPath(source, filePath, knownFiles),
          isExternal,
          isTypeOnly,
          imports,
          position: {
            row: node.startPosition.row,
            column: node.startPosition.column,
          },
        });
      }
    } else if (node.type === 'export_statement') {
      const source = extractSourceString(node);
      if (source) {
        // This is a re-export
        const isExternal = !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('#');
        const imports = extractReExportedSymbols(node, rootNode);

        // Determine if it's export-all or re-export
        const isExportAll = imports.some(
          (imp) => imp.name === '*' && imp.kind === 'namespace'
        );

        references.push({
          type: isExportAll ? 'export-all' : 're-export',
          source,
          resolvedPath: resolveImportPath(source, filePath, knownFiles),
          isExternal,
          isTypeOnly: isTypeOnlyImport(node),
          imports,
          position: {
            row: node.startPosition.row,
            column: node.startPosition.column,
          },
        });
      }
    } else if (node.type === 'call_expression') {
      // Check for dynamic import
      const dynamicImport = extractDynamicImport(
        node,
        rootNode,
        filePath,
        knownFiles
      );
      if (dynamicImport) {
        references.push(dynamicImport);
        return; // Don't recurse into import()
      }

      // Check for require()
      const requireCall = extractRequireCall(
        node,
        rootNode,
        filePath,
        knownFiles
      );
      if (requireCall) {
        references.push(requireCall);
        return; // Don't recurse into require()
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        walk(child);
      }
    }
  }

  walk(rootNode);
  return references;
}

/**
 * Internal symbol usage - for tracking calls to local definitions within the same file
 */
export interface InternalSymbolUsage {
  definitionName: string;
  usages: SymbolUsage[];
}

/**
 * Extract internal usages of definitions within the same file.
 * This captures calls to local functions, classes, etc. that are not imported.
 */
export function extractInternalUsages(
  rootNode: SyntaxNode,
  definitions: Definition[]
): InternalSymbolUsage[] {
  const results: InternalSymbolUsage[] = [];

  for (const def of definitions) {
    // Find all usages of this definition's name
    const usages = findSymbolUsages(rootNode, def.name);

    // Filter out the definition itself (where the function/class is declared)
    // by checking if the usage is at the same position as the definition
    const filteredUsages = usages.filter(usage => {
      // Definition position is 0-based, usage position is also 0-based
      const isDefinitionSite =
        usage.position.row === def.position.row &&
        usage.position.column === def.position.column;
      return !isDefinitionSite;
    });

    // Only include if there are actual usages (with call sites)
    const callUsages = filteredUsages.filter(u => u.callsite);
    if (callUsages.length > 0) {
      results.push({
        definitionName: def.name,
        usages: callUsages,
      });
    }
  }

  return results;
}
