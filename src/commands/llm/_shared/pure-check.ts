/**
 * AST-based impure pattern detection for pure annotation gating.
 * Uses tree-sitter to detect structural impurity patterns rather than regex.
 */

import type { SyntaxNode } from 'tree-sitter';
import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import TypeScript from 'tree-sitter-typescript';
import { countArguments } from '../../../parser/_shared/ast-utils.js';

let tsParser: Parser | null = null;
function getParser(): Parser {
  if (!tsParser) {
    tsParser = new Parser();
    tsParser.setLanguage(TypeScript.tsx);
  }
  return tsParser;
}

let rubyParser: Parser | null = null;
function getRubyParser(): Parser {
  if (!rubyParser) {
    rubyParser = new Parser();
    rubyParser.setLanguage(Ruby);
  }
  return rubyParser;
}

/** ActiveRecord mutation methods that indicate database side effects. */
const ACTIVE_RECORD_MUTATION_METHODS = new Set([
  'save',
  'save!',
  'update',
  'update!',
  'destroy',
  'destroy!',
  'delete',
  'create',
  'create!',
  'update_all',
  'delete_all',
  'destroy_all',
  'insert',
  'insert!',
  'upsert',
  'touch',
]);

/** ActiveRecord/DB read methods that indicate database dependency.
 * Safe to include `select`, `first`, `last`, `count`, `all` because these are
 * only matched on constant receivers (e.g., User.first, not array.first). */
const ACTIVE_RECORD_READ_METHODS = new Set([
  'where',
  'find',
  'find_by',
  'find_by!',
  'find_by_sql',
  'pluck',
  'exists?',
  'transaction',
  'execute',
  'joins',
  'includes',
  'eager_load',
  'preload',
  'select',
  'first',
  'last',
  'count',
  'all',
]);

/** File/IO classes whose method calls indicate I/O side effects. */
const RUBY_IO_CLASSES = new Set(['File', 'IO', 'Dir', 'FileUtils', 'Open3', 'Kernel', 'Tempfile']);

/**
 * Ruby methods that are impure regardless of receiver.
 * Map from method name to impurity reason.
 */
const RUBY_IMPURE_METHODS = new Map<string, string>([
  // HTTP/rendering
  ['render', 'HTTP response (render)'],
  ['redirect_to', 'HTTP redirect (redirect_to)'],
  ['head', 'HTTP response (head)'],
  ['send_data', 'HTTP response (send_data)'],
  ['send_file', 'HTTP response (send_file)'],
  ['respond_to', 'HTTP response (respond_to)'],
  ['respond_with', 'HTTP response (respond_with)'],
  // Background jobs
  ['perform_later', 'enqueues background job (perform_later)'],
  ['perform_now', 'executes background job (perform_now)'],
  ['deliver_later', 'enqueues email delivery (deliver_later)'],
  ['deliver_now', 'sends email (deliver_now)'],
  ['perform_async', 'enqueues Sidekiq job (perform_async)'],
  ['perform_in', 'enqueues delayed Sidekiq job (perform_in)'],
  // Randomness
  ['rand', 'non-deterministic (rand)'],
  // Logging/output
  ['puts', 'console output (puts)'],
  ['print', 'console output (print)'],
  ['p', 'console output (p)'],
  ['pp', 'console output (pp)'],
  ['warn', 'console output (warn)'],
]);

/**
 * Rails delivery/job methods that are impure regardless of receiver type.
 * These are sufficiently Rails-specific to avoid false positives on chained calls
 * like UserMailer.welcome(user).deliver_now.
 */
const RUBY_DELIVERY_METHODS = new Set([
  'deliver_later',
  'deliver_now',
  'perform_later',
  'perform_now',
  'perform_async',
  'perform_in',
]);

/**
 * Ruby receiver classes/modules whose method calls indicate non-determinism or side effects.
 * Map from receiver name to impurity reason.
 */
const RUBY_IMPURE_RECEIVERS = new Map<string, string>([
  // Time/randomness (non-deterministic)
  ['Time', 'non-deterministic time'],
  ['Date', 'non-deterministic date'],
  ['DateTime', 'non-deterministic datetime'],
  ['SecureRandom', 'non-deterministic random'],
  ['Random', 'non-deterministic random'],
  // External HTTP clients
  ['Net::HTTP', 'external HTTP call'],
  ['HTTParty', 'external HTTP call'],
  ['Faraday', 'external HTTP call'],
  ['RestClient', 'external HTTP call'],
  // External services
  ['Redis', 'external service (Redis)'],
  ['Elasticsearch', 'external service (Elasticsearch)'],
]);

/**
 * Specific receiver.method combos that indicate non-deterministic calls.
 * Map from "Receiver.method" to impurity reason.
 */
const RUBY_IMPURE_RECEIVER_METHODS = new Map<string, string>([
  ['Time.now', 'non-deterministic (Time.now)'],
  ['Time.current', 'non-deterministic (Time.current)'],
  ['Date.today', 'non-deterministic (Date.today)'],
  ['Date.current', 'non-deterministic (Date.current)'],
  ['DateTime.now', 'non-deterministic (DateTime.now)'],
]);

const AMBIENT_GLOBALS = new Set([
  'console',
  'process',
  'document',
  'window',
  'globalThis',
  'navigator',
  'localStorage',
  'sessionStorage',
  'location',
]);

/** Built-in global functions that are pure (no side effects when called at module scope). */
const PURE_GLOBAL_FUNCTIONS = new Set([
  'parseInt',
  'parseFloat',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Array',
  'Object',
  'Symbol',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'atob',
  'btoa',
  'structuredClone',
]);

/** Built-in constructors that are pure (no side effects when constructed at module scope). */
const PURE_GLOBAL_CONSTRUCTORS = new Set([
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'URL',
  'URLSearchParams',
  'Headers',
  'FormData',
  'AbortController',
  'TextEncoder',
  'TextDecoder',
  'Blob',
  'File',
  'Int8Array',
  'Uint8Array',
  'Float32Array',
  'Float64Array',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Promise',
]);

/**
 * Detect impure patterns in source code using AST analysis.
 * Returns a list of reasons why the code is impure (empty = possibly pure).
 *
 * @param sourceCode - The source code to analyze
 * @param language - Optional language hint ('ruby', 'typescript', 'javascript', etc.)
 *                   Defaults to TypeScript/JavaScript analysis for backward compatibility.
 *                   Unknown languages return 'needs manual review'.
 */
export function detectImpurePatterns(sourceCode: string, language?: string): string[] {
  if (!sourceCode.trim()) return [];

  // Normalize language to lowercase for comparison
  const lang = language?.toLowerCase();

  if (lang === 'ruby') {
    return detectRubyImpurePatterns(sourceCode);
  }

  // Unknown languages (non-TS/JS, non-Ruby) → needs manual review
  if (lang && lang !== 'typescript' && lang !== 'javascript') {
    return ['needs manual review'];
  }

  // TypeScript/JavaScript (default path — backward compatible)
  let tree: Parser.Tree;
  try {
    tree = getParser().parse(sourceCode);
  } catch {
    return [];
  }

  const root = tree.rootNode;
  if (!root || root.childCount === 0) return [];

  const funcNode = findOutermostFunction(root);
  const localIds = funcNode ? collectLocalIdentifiers(funcNode) : null;
  const reasons: string[] = [];
  walkForImpurity(root, localIds, reasons);
  return [...new Set(reasons)];
}

/**
 * Detect impure patterns in Ruby source code using AST analysis.
 * Checks for:
 * - ActiveRecord mutation calls (save, update, destroy, create, etc.)
 * - File/IO operations (File.read, IO.write, etc.)
 * - Instance variable assignments (@ivar = value, @ivar += value)
 */
function detectRubyImpurePatterns(sourceCode: string): string[] {
  let tree: Parser.Tree;
  try {
    tree = getRubyParser().parse(sourceCode);
  } catch {
    return [];
  }

  const root = tree.rootNode;
  if (!root || root.childCount === 0) return [];

  const reasons: string[] = [];
  walkRubyForImpurity(root, reasons);
  return [...new Set(reasons)];
}

/**
 * Recursive walker for Ruby AST nodes to detect impurity.
 */
function walkRubyForImpurity(node: SyntaxNode, reasons: string[]): void {
  switch (node.type) {
    case 'call': {
      const receiver = node.childForFieldName('receiver');
      const method = node.childForFieldName('method');
      const methodName = method?.text;

      if (receiver && methodName) {
        // Check specific receiver.method combos first (e.g., Time.now, Date.today)
        const receiverText = receiver.text;
        const combo = `${receiverText}.${methodName}`;
        const comboReason = RUBY_IMPURE_RECEIVER_METHODS.get(combo);
        if (comboReason) {
          reasons.push(comboReason);
          break;
        }

        // Check for ActiveRecord mutation methods: user.save, user.update, User.create, etc.
        if (ACTIVE_RECORD_MUTATION_METHODS.has(methodName)) {
          reasons.push(`ActiveRecord mutation (${receiverText}.${methodName})`);
          break;
        }

        // Check for ActiveRecord/DB read methods: Model.where, Model.find, etc.
        // Only match on constant receivers (e.g., User.where) to avoid false positives
        // on Enumerable methods like array.find, array.select, etc.
        if (receiver.type === 'constant' && ACTIVE_RECORD_READ_METHODS.has(methodName)) {
          reasons.push(`database read (${receiverText}.${methodName})`);
          break;
        }

        // Check for File/IO class operations: File.read, IO.write, etc.
        if ((receiver.type === 'constant' || receiver.type === 'identifier') && RUBY_IO_CLASSES.has(receiverText)) {
          reasons.push(`File/IO operation (${receiverText}.${methodName})`);
          break;
        }

        // Check for impure receiver classes (Time, SecureRandom, Redis, etc.)
        if (receiver.type === 'constant' || receiver.type === 'identifier') {
          const receiverReason = RUBY_IMPURE_RECEIVERS.get(receiverText);
          if (receiverReason) {
            reasons.push(`${receiverReason} (${receiverText}.${methodName})`);
            break;
          }
        }

        // Check for scope_resolution receivers (e.g., Net::HTTP.get, ActiveRecord::Base.transaction)
        if (receiver.type === 'scope_resolution') {
          const scopeText = receiver.text;
          if (RUBY_IO_CLASSES.has(scopeText)) {
            reasons.push(`File/IO operation (${scopeText}.${methodName})`);
            break;
          }
          if (ACTIVE_RECORD_READ_METHODS.has(methodName)) {
            reasons.push(`database read (${scopeText}.${methodName})`);
            break;
          }
          const scopeReason = RUBY_IMPURE_RECEIVERS.get(scopeText);
          if (scopeReason) {
            reasons.push(`${scopeReason} (${scopeText}.${methodName})`);
            break;
          }
        }

        // Check for job/mailer methods on constant receivers (e.g., MyJob.perform_later)
        if (receiver.type === 'constant' && methodName) {
          const methodReason = RUBY_IMPURE_METHODS.get(methodName);
          if (methodReason) {
            reasons.push(methodReason);
            break;
          }
        }

        // Check for receiver-independent delivery methods (e.g., UserMailer.welcome(user).deliver_now)
        // These are Rails-specific enough to not cause false positives on any receiver type.
        if (methodName && RUBY_DELIVERY_METHODS.has(methodName)) {
          const deliveryReason = RUBY_IMPURE_METHODS.get(methodName);
          if (deliveryReason) {
            reasons.push(deliveryReason);
            break;
          }
        }

        // Check for chained receiver patterns: Rails.logger.*, Rails.cache.*, Net::HTTP.*
        if (receiver.type === 'call') {
          const innerReceiver = receiver.childForFieldName('receiver');
          const innerMethod = receiver.childForFieldName('method');
          if (innerReceiver && innerMethod) {
            const chainedName = `${innerReceiver.text}.${innerMethod.text}`;
            if (chainedName === 'Rails.logger' || chainedName === 'Rails.cache') {
              reasons.push(`${chainedName} side effect (${chainedName}.${methodName})`);
              break;
            }
          }
        }

        // Check for logger.* calls (common pattern: logger = Rails.logger)
        if (receiver.type === 'identifier' && receiverText === 'logger') {
          reasons.push(`logging side effect (logger.${methodName})`);
          break;
        }
      }

      // No receiver — bare method call
      if (!receiver && methodName) {
        // Check bare impure methods (render, redirect_to, puts, rand, etc.)
        const bareReason = RUBY_IMPURE_METHODS.get(methodName);
        if (bareReason) {
          reasons.push(bareReason);
          break;
        }
      }
      break;
    }

    case 'assignment': {
      // Instance variable assignment: @ivar = value
      const left = node.childForFieldName('left');
      if (left?.type === 'instance_variable') {
        reasons.push(`instance variable mutation (${left.text})`);
        break;
      }
      // session[:key] = value, cookies[:key] = value, flash[:key] = value
      if (left?.type === 'element_reference') {
        const obj = left.childForFieldName('object');
        if (obj?.type === 'identifier') {
          const objName = obj.text;
          if (objName === 'session') {
            reasons.push('session mutation (session[]=)');
            break;
          }
          if (objName === 'cookies') {
            reasons.push('cookie mutation (cookies[]=)');
            break;
          }
          if (objName === 'flash') {
            reasons.push('flash mutation (flash[]=)');
            break;
          }
        }
      }
      break;
    }

    case 'operator_assignment': {
      // Instance variable operator assignment: @ivar += 1, @ivar ||= value
      const left = node.childForFieldName('left');
      if (left?.type === 'instance_variable') {
        reasons.push(`instance variable mutation (${left.text})`);
        break;
      }
      break;
    }
  }

  // Recurse into children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkRubyForImpurity(child, reasons);
  }
}

/**
 * Find the outermost function body in the snippet.
 * Handles: export statement wrapping, lexical_declaration → variable_declarator → arrow_function,
 * direct function_declaration, and method_definition.
 */
function findOutermostFunction(root: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < root.childCount; i++) {
    let node = root.child(i);
    if (!node) continue;

    // Unwrap export_statement
    if (node.type === 'export_statement') {
      const decl = node.childForFieldName('declaration');
      if (decl) node = decl;
      else continue;
    }

    if (node.type === 'function_declaration') {
      return node;
    }

    // lexical_declaration → variable_declarator → arrow_function / function
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (let j = 0; j < node.childCount; j++) {
        const child = node.child(j);
        if (child?.type === 'variable_declarator') {
          const value = child.childForFieldName('value');
          if (value?.type === 'arrow_function' || value?.type === 'function') {
            return value;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Collect identifiers declared locally within a function scope.
 * Includes parameters (with destructuring), let/const/var declarations,
 * for-of/for-in loop variables, and catch clause parameters.
 * Does NOT recurse into nested function bodies.
 */
function collectLocalIdentifiers(funcNode: SyntaxNode): Set<string> {
  const ids = new Set<string>();

  // Collect formal parameters
  const params = funcNode.childForFieldName('parameters');
  if (params) {
    collectPatternIdentifiers(params, ids);
  }
  // Single arrow parameter (no parens): (x) => ...
  const param = funcNode.childForFieldName('parameter');
  if (param?.type === 'identifier') {
    ids.add(param.text);
  }

  // Walk the body for declarations
  const body = funcNode.childForFieldName('body');
  if (body) {
    collectBodyDeclarations(body, ids);
  }

  return ids;
}

/**
 * Recursively extract identifiers from parameter/destructuring patterns.
 */
function collectPatternIdentifiers(node: SyntaxNode, ids: Set<string>): void {
  switch (node.type) {
    case 'identifier':
      ids.add(node.text);
      break;
    case 'rest_pattern': {
      // ...rest
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) collectPatternIdentifiers(child, ids);
      }
      break;
    }
    case 'assignment_pattern': {
      // param = default
      const left = node.childForFieldName('left');
      if (left) collectPatternIdentifiers(left, ids);
      break;
    }
    case 'object_pattern':
    case 'array_pattern':
    case 'formal_parameters':
    case 'required_parameter':
    case 'optional_parameter': {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) collectPatternIdentifiers(child, ids);
      }
      break;
    }
    case 'shorthand_property_identifier_pattern':
      ids.add(node.text);
      break;
    case 'pair_pattern': {
      const value = node.childForFieldName('value');
      if (value) collectPatternIdentifiers(value, ids);
      break;
    }
  }
}

/**
 * Walk a function body collecting declarations. Stops at nested function boundaries.
 */
function collectBodyDeclarations(node: SyntaxNode, ids: Set<string>): void {
  // Don't recurse into nested functions
  if (
    node.type === 'arrow_function' ||
    node.type === 'function_declaration' ||
    node.type === 'function' ||
    node.type === 'method_definition'
  ) {
    return;
  }

  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) collectPatternIdentifiers(nameNode, ids);
      }
    }
  }

  // for...of / for...in loop variables
  if (node.type === 'for_in_statement') {
    const left = node.childForFieldName('left');
    if (left) {
      if (left.type === 'identifier') {
        ids.add(left.text);
      } else {
        collectPatternIdentifiers(left, ids);
      }
    }
  }

  // catch clause parameter
  if (node.type === 'catch_clause') {
    const paramNode = node.childForFieldName('parameter');
    if (paramNode) collectPatternIdentifiers(paramNode, ids);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectBodyDeclarations(child, ids);
  }
}

/**
 * Resolve the root identifier of a (possibly chained) member_expression.
 * Returns null for `this`, `super`, or non-identifier roots.
 */
function resolveRootIdentifier(node: SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'this' || node.type === 'super') return null;
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    if (obj) return resolveRootIdentifier(obj);
  }
  // subscript_expression: a[b] = ...
  if (node.type === 'subscript_expression') {
    const obj = node.childForFieldName('object');
    if (obj) return resolveRootIdentifier(obj);
  }
  return null;
}

/**
 * Check if a node has any function/arrow_function/method ancestor.
 * Used to determine if a throw_statement is inside a function body
 * (even a nested callback) vs. bare module scope.
 */
function hasAncestorFunction(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'arrow_function' ||
      current.type === 'function_declaration' ||
      current.type === 'function' ||
      current.type === 'method_definition'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Check if a node is inside a type annotation context (should be ignored).
 */
function isInTypeContext(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    const t = current.type;
    if (
      t === 'type_annotation' ||
      t === 'type_alias_declaration' ||
      t === 'interface_declaration' ||
      t === 'type_arguments' ||
      t === 'type_parameter'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Single recursive walk dispatching on node.type to detect impurity.
 */
function walkForImpurity(node: SyntaxNode, localIds: Set<string> | null, reasons: string[]): void {
  // Skip type-only constructs entirely
  if (
    node.type === 'type_annotation' ||
    node.type === 'type_alias_declaration' ||
    node.type === 'interface_declaration' ||
    node.type === 'enum_declaration'
  ) {
    return;
  }

  switch (node.type) {
    case 'await_expression':
      reasons.push('async I/O (await)');
      break;

    case 'yield_expression':
      reasons.push('generator side effect (yield)');
      break;

    case 'throw_statement':
      if (!localIds && !hasAncestorFunction(node)) {
        reasons.push('module-scope throw');
      }
      break;

    case 'assignment_expression':
    case 'augmented_assignment_expression':
      checkMutationTarget(node.childForFieldName('left'), localIds, reasons);
      break;

    case 'update_expression':
      checkMutationTarget(node.childForFieldName('argument'), localIds, reasons);
      break;

    case 'new_expression': {
      const ctor = node.childForFieldName('constructor');
      if (ctor?.type === 'identifier' && ctor.text === 'Date') {
        const args = node.childForFieldName('arguments');
        if (!args || countArguments(args) === 0) {
          reasons.push('non-deterministic (new Date())');
        }
      }
      // Module-scope construction of non-builtin class
      if (!localIds && ctor?.type === 'identifier' && !PURE_GLOBAL_CONSTRUCTORS.has(ctor.text)) {
        reasons.push(`module-scope side effect (new ${ctor.text}())`);
      }
      // Function-scope construction of non-builtin class → creates mutable identity
      if (localIds && ctor?.type === 'identifier' && !PURE_GLOBAL_CONSTRUCTORS.has(ctor.text)) {
        reasons.push(`creates mutable instance (new ${ctor.text}())`);
      }
      break;
    }

    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'member_expression') {
        const obj = fn.childForFieldName('object');
        const prop = fn.childForFieldName('property');
        if (obj?.type === 'identifier' && prop) {
          // Math.random()
          if (obj.text === 'Math' && prop.text === 'random') {
            reasons.push('non-deterministic (Math.random)');
            break;
          }
          // Ambient global call: console.log(), document.getElementById(), etc.
          if (AMBIENT_GLOBALS.has(obj.text)) {
            reasons.push(`ambient global I/O (${obj.text}.${prop.text})`);
            break;
          }
        }
      }
      // Module-scope call to non-builtin function
      if (!localIds && fn?.type === 'identifier' && !PURE_GLOBAL_FUNCTIONS.has(fn.text)) {
        reasons.push(`module-scope side effect (${fn.text}())`);
      }
      break;
    }

    case 'member_expression': {
      // Skip if this member_expression is the function of a call_expression (handled above)
      if (node.parent?.type === 'call_expression') {
        const callFn = node.parent.childForFieldName('function');
        if (callFn && callFn.id === node.id) break;
      }

      // Skip if in type context
      if (isInTypeContext(node)) break;

      const obj = node.childForFieldName('object');
      const prop = node.childForFieldName('property');

      // import.meta.env — tree-sitter parses `import.meta` as a `meta_property` node
      if (obj?.type === 'meta_property' && prop?.text === 'env') {
        reasons.push('environment dependency (import.meta.env)');
        break;
      }
      if (obj?.type === 'member_expression') {
        const innerObj = obj.childForFieldName('object');
        if (innerObj?.type === 'meta_property' && prop) {
          reasons.push('environment dependency (import.meta.env)');
          break;
        }
      }

      // Ambient global access: process.env, window.location, etc.
      if (obj?.type === 'identifier' && prop && AMBIENT_GLOBALS.has(obj.text)) {
        reasons.push(`ambient global access (${obj.text}.${prop.text})`);
        break;
      }
      break;
    }
  }

  // Recurse into children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkForImpurity(child, localIds, reasons);
  }
}

/**
 * Check if a mutation target (left side of assignment / update operand) refers to
 * an outer-scope variable. If localIds is null (no function found), skip the check.
 */
function checkMutationTarget(target: SyntaxNode | null, localIds: Set<string> | null, reasons: string[]): void {
  if (!target || !localIds) return;

  // Handle destructuring assignment patterns: [a, b] = ...
  if (target.type === 'array_pattern' || target.type === 'object_pattern') {
    collectAssignmentPatternIds(target, localIds, reasons);
    return;
  }

  const rootId = resolveRootIdentifier(target);
  if (!rootId) return; // this.x, super.x — not flagged

  if (!localIds.has(rootId)) {
    reasons.push(`outer-scope mutation (${rootId})`);
  }
}

/**
 * Collect identifiers from destructuring assignment patterns and check for outer-scope mutation.
 */
function collectAssignmentPatternIds(node: SyntaxNode, localIds: Set<string>, reasons: string[]): void {
  if (node.type === 'identifier') {
    if (!localIds.has(node.text)) {
      reasons.push(`outer-scope mutation (${node.text})`);
    }
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectAssignmentPatternIds(child, localIds, reasons);
  }
}
