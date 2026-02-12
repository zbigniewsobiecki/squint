/**
 * AST-based impure pattern detection for pure annotation gating.
 * Uses tree-sitter to detect structural impurity patterns rather than regex.
 */

import type { SyntaxNode } from 'tree-sitter';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

let parser: Parser | null = null;
function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(TypeScript.tsx);
  }
  return parser;
}

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
 */
export function detectImpurePatterns(sourceCode: string): string[] {
  if (!sourceCode.trim()) return [];

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
 * Count non-punctuation arguments in an arguments node.
 */
function countArguments(argsNode: SyntaxNode): number {
  let count = 0;
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child) {
      const t = child.type;
      if (t !== '(' && t !== ')' && t !== ',') count++;
    }
  }
  return count;
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
