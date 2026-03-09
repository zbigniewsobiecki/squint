import Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import type { Definition } from '../definition-extractor.js';
import type { LanguageAdapter } from '../language-adapter.js';
import { LanguageRegistry } from '../language-adapter.js';
import type { FileReference, InternalSymbolUsage } from '../reference-extractor.js';
import type { WorkspaceMap } from '../workspace-resolver.js';
import { extractRubyDefinitions } from './ruby/definition-extractor.js';
import { extractRubyInternalUsages, extractRubyReferences, resolveRubyImportPath } from './ruby/reference-extractor.js';

/**
 * RubyAdapter implements language support for Ruby files (.rb, .rake, .gemspec).
 * Currently provides a skeleton for parsing infrastructure.
 */
export class RubyAdapter implements LanguageAdapter {
  readonly languageId = 'ruby';
  readonly fileExtensions = ['.rb', '.rake', '.gemspec'];
  readonly defaultIgnorePatterns = ['**/vendor/**', '**/tmp/**', '**/log/**', '**/.bundle/**'];

  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Ruby);
  }

  /**
   * Get the tree-sitter parser instance for Ruby.
   */
  getParser(_filePath: string): Parser {
    return this.parser;
  }

  /**
   * Extract all top-level definitions from the syntax tree.
   */
  extractDefinitions(rootNode: SyntaxNode): Definition[] {
    return extractRubyDefinitions(rootNode);
  }

  /**
   * Extract all import/export references from the syntax tree.
   * Handles require, require_relative, include, extend, and prepend statements.
   */
  extractReferences(
    rootNode: SyntaxNode,
    filePath: string,
    knownFiles: Set<string>,
    _workspaceMap?: WorkspaceMap | null
  ): FileReference[] {
    return extractRubyReferences(rootNode, filePath, knownFiles);
  }

  /**
   * Extract internal symbol usages within the same file.
   * Detects method calls to locally-defined methods, handling implicit self
   * receiver and super calls.
   */
  extractInternalUsages(rootNode: SyntaxNode, definitions: Definition[]): InternalSymbolUsage[] {
    return extractRubyInternalUsages(rootNode, definitions);
  }

  /**
   * Resolve an import path to an absolute file path.
   * Handles require_relative (relative paths) and require (bare paths).
   */
  resolveImportPath(
    source: string,
    fromFile: string,
    knownFiles: Set<string>,
    _workspaceMap?: WorkspaceMap | null
  ): string | null {
    return resolveRubyImportPath(source, fromFile, knownFiles);
  }
}

// Auto-register the Ruby adapter on import
const rubyAdapter = new RubyAdapter();
const registry = LanguageRegistry.getInstance();
registry.register(rubyAdapter);
