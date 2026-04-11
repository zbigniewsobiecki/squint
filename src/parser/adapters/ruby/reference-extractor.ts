import path from 'node:path';
import type { SyntaxNode } from 'tree-sitter';
import type { Definition } from '../../definition-extractor.js';
import type { FileReference, ImportedSymbol, InternalSymbolUsage, SymbolUsage } from '../../reference-extractor.js';

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
    // Check for common Rails/Ruby project root indicators.
    // knownFiles only contains source files (.rb), so Gemfile/Rakefile won't
    // be in the set. Also check for the Rails app/ directory convention by
    // looking for any known file under dir/app/.
    if (
      knownFiles.has(path.join(dir, 'Gemfile')) ||
      knownFiles.has(path.join(dir, 'Rakefile')) ||
      knownFiles.has(path.join(dir, 'config/application.rb')) ||
      hasKnownFileUnder(path.join(dir, 'app'), knownFiles)
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return path.dirname(absoluteFilePath);
}

/** Check if any file in knownFiles starts with the given directory prefix. */
function hasKnownFileUnder(dirPath: string, knownFiles: Set<string>): boolean {
  const prefix = dirPath + path.sep;
  for (const f of knownFiles) {
    if (f.startsWith(prefix)) return true;
  }
  return false;
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
  const seenConstants = new Set<string>();
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

      // Constant-receiver calls: BookSerializer.new(book), User.authenticate(...)
      // In Zeitwerk apps these are implicit cross-file dependencies. Resolve the
      // constant via Rails autoloading and emit a synthetic import reference.
      const receiverNode = node.childForFieldName('receiver');
      if (receiverNode && (receiverNode.type === 'constant' || receiverNode.type === 'scope_resolution')) {
        const constantName = getConstantText(receiverNode);
        if (!seenConstants.has(constantName)) {
          const resolvedPath = resolveConstantViaAutoloading(constantName, projectRoot, knownFiles);
          if (resolvedPath) {
            seenConstants.add(constantName);
            references.push({
              type: 'import',
              source: constantName,
              resolvedPath,
              isExternal: false,
              isTypeOnly: false,
              imports: moduleRefImport(constantName),
              position: {
                row: receiverNode.startPosition.row,
                column: receiverNode.startPosition.column,
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

/**
 * Build a set of method names defined in the file (from the definitions list).
 * This is used to identify calls to locally-defined methods.
 */
function buildLocalMethodNames(definitions: Definition[]): Set<string> {
  const names = new Set<string>();
  for (const def of definitions) {
    if (def.kind === 'method' || def.kind === 'function') {
      // Strip trailing '=' for setter methods (attr_writer generates e.g. 'name=')
      // We want to track calls to the base name
      names.add(def.name);
    }
  }
  return names;
}

/**
 * Extract the call metadata from a Ruby `call` AST node.
 * Returns the method name and argument count when the node is a plain method call
 * (no explicit receiver, i.e. implicit self).
 *
 * Ruby AST for `foo(a, b)` or `foo a, b`:
 *   (call
 *     receiver: <absent>
 *     method: (identifier) "foo"
 *     arguments: (argument_list ...))
 *
 * Ruby AST for `self.foo(a)`:
 *   (call
 *     receiver: (self)
 *     method: (identifier) "foo"
 *     arguments: ...)
 *
 * We handle both implicit-self and explicit-self receiver cases.
 */
function extractCallInfo(
  node: SyntaxNode
): { methodName: string; argumentCount: number; receiver: string | null } | null {
  if (node.type !== 'call') return null;

  const methodNode = node.childForFieldName('method');
  if (!methodNode) return null;

  const methodName = methodNode.text;

  // Check if there's a receiver
  const receiverNode = node.childForFieldName('receiver');
  let receiver: string | null = null;
  if (receiverNode) {
    receiver = receiverNode.text;
    // Only treat as internal call when receiver is `self` (explicit self call)
    if (receiver !== 'self') {
      // It's an external call (obj.foo) — not an internal usage
      return null;
    }
  }

  // Count arguments
  const argumentsNode = node.childForFieldName('arguments');
  let argumentCount = 0;
  if (argumentsNode) {
    for (let i = 0; i < argumentsNode.childCount; i++) {
      const child = argumentsNode.child(i);
      if (child) {
        const t = child.type;
        // Skip parentheses and commas
        if (t !== '(' && t !== ')' && t !== ',') {
          argumentCount++;
        }
      }
    }
  }

  return { methodName, argumentCount, receiver };
}

/**
 * Extract internal symbol usages from a Ruby AST.
 *
 * Detects:
 * 1. Method calls without explicit receiver (implicit self): `validate_email(email)`
 * 2. Method calls with explicit `self` receiver: `self.validate_email(email)`
 * 3. `super` calls — mapped to the enclosing method's name as a reference to parent class method
 *
 * @param rootNode - The root of the parsed Ruby AST
 * @param definitions - All definitions extracted from the same file
 * @returns Array of InternalSymbolUsage entries
 */
export function extractRubyInternalUsages(rootNode: SyntaxNode, definitions: Definition[]): InternalSymbolUsage[] {
  const localMethodNames = buildLocalMethodNames(definitions);

  // Map from definition name → collected usages
  const usageMap = new Map<string, SymbolUsage[]>();

  // Initialise empty arrays for each local method so we include even zero-usage methods if needed
  // (we'll only emit when there's at least one usage)

  // Track which method body we're currently in (for `super` resolution)
  const enclosingMethodStack: string[] = [];

  function walk(node: SyntaxNode): void {
    switch (node.type) {
      case 'method':
      case 'singleton_method': {
        // Push method name onto stack before walking body
        const nameNode = node.childForFieldName('name');
        const methodName = nameNode?.text ?? null;
        if (methodName) enclosingMethodStack.push(methodName);
        // Walk children
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walk(child);
        }
        if (methodName) enclosingMethodStack.pop();
        return; // already walked
      }

      case 'super': {
        // `super` inside a method body → reference to parent class method with same name
        const enclosingMethod = enclosingMethodStack[enclosingMethodStack.length - 1];
        if (enclosingMethod && localMethodNames.has(enclosingMethod)) {
          // Record a super call as a usage of the enclosing method's definition
          // (The parent class has a method with the same name)
          const usage: SymbolUsage = {
            position: {
              row: node.startPosition.row,
              column: node.startPosition.column,
            },
            context: 'super',
            callsite: {
              argumentCount: 0,
              isMethodCall: false,
              isConstructorCall: false,
            },
          };
          if (!usageMap.has(enclosingMethod)) {
            usageMap.set(enclosingMethod, []);
          }
          usageMap.get(enclosingMethod)!.push(usage);
        }
        break;
      }

      case 'call': {
        const info = extractCallInfo(node);
        if (info && localMethodNames.has(info.methodName)) {
          // Check this call is not at the definition site itself
          const defs = definitions.filter((d) => d.name === info.methodName);
          const isDefinitionSite = defs.some(
            (d) => d.position.row === node.startPosition.row && d.position.column === node.startPosition.column
          );

          if (!isDefinitionSite) {
            const usage: SymbolUsage = {
              position: {
                row: node.startPosition.row,
                column: node.startPosition.column,
              },
              context: 'call',
              callsite: {
                argumentCount: info.argumentCount,
                isMethodCall: info.receiver === 'self',
                isConstructorCall: false,
                ...(info.receiver === 'self' && { receiverName: 'self' }),
              },
            };
            if (!usageMap.has(info.methodName)) {
              usageMap.set(info.methodName, []);
            }
            usageMap.get(info.methodName)!.push(usage);
          }
        }
        break;
      }

      case 'identifier': {
        // In tree-sitter-ruby, a bare method call without arguments and without parens
        // is represented as a plain `identifier` node (e.g. `check_email` with no args).
        // We must only track identifiers that look like implicit method calls, not
        // identifiers that are definition names, parameter names, local variable references, etc.
        const name = node.text;
        if (!localMethodNames.has(name)) break;

        // Skip if this identifier is the name field of a method/singleton_method definition
        const parent = node.parent;
        if (!parent) break;
        if (
          (parent.type === 'method' || parent.type === 'singleton_method') &&
          parent.childForFieldName('name')?.id === node.id
        ) {
          break;
        }

        // Skip if it's the method identifier inside a `call` node (handled above)
        if (parent.type === 'call') break;

        // Skip if it's a parameter name
        if (parent.type === 'method_parameters' || parent.type === 'parameters') break;

        // Skip if it's in an argument_list (it's being passed as an argument, not called)
        if (parent.type === 'argument_list') break;

        // Skip if the parent is an assignment and this identifier is the left side (local variable)
        if (parent.type === 'assignment' && parent.childForFieldName('left')?.id === node.id) break;

        // Check it's not at the definition position of any definition
        const isDefinitionSite = definitions.some(
          (d) => d.position.row === node.startPosition.row && d.position.column === node.startPosition.column
        );
        if (isDefinitionSite) break;

        // Record as a bare method invocation (implicit self, no args)
        const usage: SymbolUsage = {
          position: {
            row: node.startPosition.row,
            column: node.startPosition.column,
          },
          context: 'call',
          callsite: {
            argumentCount: 0,
            isMethodCall: false,
            isConstructorCall: false,
          },
        };
        if (!usageMap.has(name)) {
          usageMap.set(name, []);
        }
        usageMap.get(name)!.push(usage);
        break;
      }
    }

    // Recurse into children (unless already handled above with a return)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(rootNode);

  // Build results — only emit definitions that have at least one usage
  const results: InternalSymbolUsage[] = [];
  for (const [definitionName, usages] of usageMap.entries()) {
    if (usages.length > 0) {
      results.push({ definitionName, usages });
    }
  }

  return results;
}
