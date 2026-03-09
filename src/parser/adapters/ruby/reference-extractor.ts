import path from 'node:path';
import type { SyntaxNode } from 'tree-sitter';
import type { FileReference, ImportedSymbol } from '../../reference-extractor.js';

// Ruby file extensions to try when resolving
const RUBY_EXTENSIONS_TO_TRY = ['.rb'];

/**
 * Rails Zeitwerk autoloading conventions:
 * - `User` → `app/models/user.rb`
 * - `UsersController` → `app/controllers/users_controller.rb`
 * - `Admin::UsersController` → `app/controllers/admin/users_controller.rb`
 */
const RAILS_AUTOLOAD_PATHS = [
  'app/models',
  'app/controllers',
  'app/helpers',
  'app/mailers',
  'app/jobs',
  'app/channels',
  'app/serializers',
  'app/services',
  'app/policies',
  'app/forms',
  'app/decorators',
  'app/presenters',
  'app/validators',
  'lib',
];

/**
 * Convert a CamelCase constant name to snake_case file name.
 * Examples:
 *   User → user
 *   UsersController → users_controller
 *   ApplicationRecord → application_record
 *   HTMLParser → html_parser (acronym handling)
 */
function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Map a Ruby constant to a list of candidate file paths using Rails Zeitwerk conventions.
 * E.g. `User` → `app/models/user.rb`, `UsersController` → `app/controllers/users_controller.rb`
 */
function railsAutoloadCandidates(constantName: string, projectRoot: string): string[] {
  // Handle namespaced constants like Admin::UsersController
  const parts = constantName.split('::');
  const namespaceParts = parts.slice(0, -1).map((p) => toSnakeCase(p));
  const baseName = parts[parts.length - 1];
  const fileName = `${toSnakeCase(baseName)}.rb`;

  const candidates: string[] = [];

  for (const autoloadPath of RAILS_AUTOLOAD_PATHS) {
    if (namespaceParts.length > 0) {
      // Namespaced: app/controllers/admin/users_controller.rb
      candidates.push(path.join(projectRoot, autoloadPath, ...namespaceParts, fileName));
    } else {
      // Simple: app/models/user.rb
      candidates.push(path.join(projectRoot, autoloadPath, fileName));
    }
  }

  return candidates;
}

/**
 * Find the project root by looking for Gemfile, Rakefile, or .git
 * starting from the file's directory and walking up.
 */
function findProjectRoot(filePath: string, knownFiles: Set<string>): string {
  // Use absolute path to avoid infinite loops with relative paths
  const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  let dir = path.dirname(absoluteFilePath);
  const fsRoot = path.parse(dir).root;

  while (dir !== fsRoot) {
    // Check for common Rails/Ruby project root indicators
    if (
      knownFiles.has(path.join(dir, 'Gemfile')) ||
      knownFiles.has(path.join(dir, 'Rakefile')) ||
      knownFiles.has(path.join(dir, 'config/application.rb'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    // Guard against infinite loop (shouldn't happen with absolute paths but just in case)
    if (parent === dir) break;
    dir = parent;
  }

  return path.dirname(absoluteFilePath);
}

/**
 * Extract the string content from a Ruby string node.
 * Handles both single-quoted and double-quoted strings.
 */
function extractStringContent(node: SyntaxNode): string | null {
  if (node.type === 'string') {
    // Find string_content child
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'string_content') {
        return child.text;
      }
    }
    // Fallback: strip quotes from the full text
    const text = node.text;
    if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
      return text.slice(1, -1);
    }
  }
  return null;
}

/**
 * Resolve a require path (not require_relative) to an absolute file path.
 * Treats it as external (gem) unless it matches a known file.
 */
function resolveRequirePath(source: string, fromFile: string, knownFiles: Set<string>): string | undefined {
  const fromDir = path.dirname(fromFile);
  const projectRoot = findProjectRoot(fromFile, knownFiles);

  // Try relative to common lib/ directories
  const searchDirs = [fromDir, projectRoot, path.join(projectRoot, 'lib')];

  for (const dir of searchDirs) {
    const resolved = path.resolve(dir, source);
    if (knownFiles.has(resolved)) return resolved;
    const withRb = `${resolved}.rb`;
    if (knownFiles.has(withRb)) return withRb;
  }

  return undefined;
}

/**
 * Resolve a require_relative path to an absolute file path.
 */
function resolveRequireRelativePath(source: string, fromFile: string, knownFiles: Set<string>): string | undefined {
  const fromDir = path.dirname(fromFile);
  const resolved = path.resolve(fromDir, source);

  // Try exact match
  if (knownFiles.has(resolved)) return resolved;

  // Try with .rb extension
  for (const ext of RUBY_EXTENSIONS_TO_TRY) {
    const withExt = `${resolved}${ext}`;
    if (knownFiles.has(withExt)) return withExt;
  }

  return undefined;
}

/**
 * Get the full text of a node (handles simple constants and scope_resolution).
 */
function getConstantText(node: SyntaxNode): string {
  return node.text;
}

/**
 * Create a side-effect import symbol (for require/require_relative without destructuring).
 */
function sideEffectImport(): ImportedSymbol[] {
  return [
    {
      name: '*',
      localName: '*',
      kind: 'side-effect',
      usages: [],
    },
  ];
}

/**
 * Create a module reference import symbol (for include/extend/prepend).
 */
function moduleRefImport(moduleName: string): ImportedSymbol[] {
  return [
    {
      name: moduleName,
      localName: moduleName,
      kind: 'named',
      usages: [],
    },
  ];
}

/**
 * Extract all Ruby references from an AST.
 * Handles:
 * - require 'something' → external gem or internal file
 * - require_relative '../path' → relative file
 * - include/extend/prepend ModuleName → mixin references
 * - Basic Rails autoloading: User → app/models/user.rb
 */
export function extractRubyReferences(
  rootNode: SyntaxNode,
  filePath: string,
  knownFiles: Set<string>
): FileReference[] {
  const references: FileReference[] = [];
  const projectRoot = findProjectRoot(filePath, knownFiles);

  function walk(node: SyntaxNode): void {
    if (node.type === 'call') {
      const methodNode = node.childForFieldName('method');
      // For top-level calls, the method identifier is a direct child named 'method'
      // but tree-sitter-ruby may use a different structure
      // We need to find the identifier that is the method name
      let methodName: string | null = null;
      let identifierNode: SyntaxNode | null = null;

      // Try childForFieldName first
      if (methodNode) {
        methodName = methodNode.text;
        identifierNode = methodNode;
      } else {
        // Find the first identifier child for function-call style: `require 'x'`
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.type === 'identifier') {
            methodName = child.text;
            identifierNode = child;
            break;
          }
        }
      }

      if (methodName && identifierNode) {
        const argumentsNode = node.childForFieldName('arguments');

        if (methodName === 'require' && argumentsNode) {
          // require 'something'
          const firstArg = getFirstStringArg(argumentsNode);
          if (firstArg !== null) {
            const resolvedPath = resolveRequirePath(firstArg, filePath, knownFiles);
            const isExternal = !resolvedPath;

            references.push({
              type: 'require',
              source: firstArg,
              resolvedPath,
              isExternal,
              isTypeOnly: false,
              imports: sideEffectImport(),
              position: {
                row: node.startPosition.row,
                column: node.startPosition.column,
              },
            });

            // Don't recurse into require call arguments
            return;
          }
        }

        if (methodName === 'require_relative' && argumentsNode) {
          // require_relative '../path/to/file'
          const firstArg = getFirstStringArg(argumentsNode);
          if (firstArg !== null) {
            const resolvedPath = resolveRequireRelativePath(firstArg, filePath, knownFiles);
            const isExternal = false; // require_relative is always local

            references.push({
              type: 'require',
              source: firstArg,
              resolvedPath,
              isExternal,
              isTypeOnly: false,
              imports: sideEffectImport(),
              position: {
                row: node.startPosition.row,
                column: node.startPosition.column,
              },
            });

            return;
          }
        }

        if ((methodName === 'include' || methodName === 'extend' || methodName === 'prepend') && argumentsNode) {
          // include/extend/prepend ModuleName
          const constants = getConstantArgs(argumentsNode);
          for (const constantName of constants) {
            // Try to resolve via Rails autoloading
            const resolvedPath = resolveConstantViaAutoloading(constantName, projectRoot, knownFiles);
            const isExternal = !resolvedPath;

            references.push({
              type: 'import',
              source: constantName,
              resolvedPath,
              isExternal,
              isTypeOnly: false,
              imports: moduleRefImport(constantName),
              position: {
                row: node.startPosition.row,
                column: node.startPosition.column,
              },
            });
          }
        }
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(rootNode);
  return references;
}

/**
 * Get the first string argument from an argument_list node.
 */
function getFirstStringArg(argumentsNode: SyntaxNode): string | null {
  for (let i = 0; i < argumentsNode.childCount; i++) {
    const child = argumentsNode.child(i);
    if (child?.type === 'string') {
      return extractStringContent(child);
    }
  }
  return null;
}

/**
 * Get all constant (or scope_resolution) arguments from an argument_list node.
 * These are used for include/extend/prepend arguments.
 */
function getConstantArgs(argumentsNode: SyntaxNode): string[] {
  const constants: string[] = [];
  for (let i = 0; i < argumentsNode.childCount; i++) {
    const child = argumentsNode.child(i);
    if (child && (child.type === 'constant' || child.type === 'scope_resolution')) {
      constants.push(getConstantText(child));
    }
  }
  return constants;
}

/**
 * Try to resolve a Ruby constant to a file path using Rails Zeitwerk autoloading conventions.
 */
function resolveConstantViaAutoloading(
  constantName: string,
  projectRoot: string,
  knownFiles: Set<string>
): string | undefined {
  const candidates = railsAutoloadCandidates(constantName, projectRoot);
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve a require_relative path to an absolute file path (exported for use in RubyAdapter).
 */
export function resolveRubyImportPath(source: string, fromFile: string, knownFiles: Set<string>): string | null {
  // require_relative style (starts with . or ..)
  if (source.startsWith('.')) {
    return resolveRequireRelativePath(source, fromFile, knownFiles) ?? null;
  }

  // Plain require style
  return resolveRequirePath(source, fromFile, knownFiles) ?? null;
}
