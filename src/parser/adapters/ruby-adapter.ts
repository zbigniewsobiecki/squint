import Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import type { Definition } from '../definition-extractor.js';
import type { LanguageAdapter } from '../language-adapter.js';
import { LanguageRegistry } from '../language-adapter.js';
import type { FileReference, InternalSymbolUsage } from '../reference-extractor.js';
import type { WorkspaceMap } from '../workspace-resolver.js';
import { extractRubyDefinitions } from './ruby/definition-extractor.js';

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
   * (Stub implementation for now)
   */
  extractReferences(
    _rootNode: SyntaxNode,
    _filePath: string,
    _knownFiles: Set<string>,
    _workspaceMap?: WorkspaceMap | null
  ): FileReference[] {
    return [];
  }

  /**
   * Extract internal symbol usages within the same file.
   * (Stub implementation for now)
   */
  extractInternalUsages(_rootNode: SyntaxNode, _definitions: Definition[]): InternalSymbolUsage[] {
    return [];
  }

  /**
   * Resolve an import path to an absolute file path.
   * (Stub implementation for now)
   */
  resolveImportPath(
    _source: string,
    _fromFile: string,
    _knownFiles: Set<string>,
    _workspaceMap?: WorkspaceMap | null
  ): string | null {
    return null;
  }
}

// Auto-register the Ruby adapter on import
const rubyAdapter = new RubyAdapter();
const registry = LanguageRegistry.getInstance();
registry.register(rubyAdapter);
