import path from 'node:path';
import Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import { type Definition, extractDefinitions } from '../definition-extractor.js';
import type { LanguageAdapter } from '../language-adapter.js';
import { LanguageRegistry } from '../language-adapter.js';
import {
  type FileReference,
  type InternalSymbolUsage,
  extractInternalUsages,
  extractReferences,
  resolveImportPath,
} from '../reference-extractor.js';
import type { WorkspaceMap } from '../workspace-resolver.js';

/**
 * TypeScriptAdapter implements language support for TypeScript, JavaScript, TSX, and JSX files.
 * It wraps existing parser initialization and extractor logic into the LanguageAdapter pattern.
 */
export class TypeScriptAdapter implements LanguageAdapter {
  readonly languageId = 'typescript';
  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];
  readonly defaultIgnorePatterns = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/coverage/**',
    '**/.turbo/**',
  ];

  private typescriptParser: Parser;
  private tsxParser: Parser;
  private javascriptParser: Parser;

  constructor() {
    // Initialize TypeScript parser for .ts files
    this.typescriptParser = new Parser();
    this.typescriptParser.setLanguage(TypeScript.typescript);

    // Initialize TSX parser for .tsx files
    this.tsxParser = new Parser();
    this.tsxParser.setLanguage(TypeScript.tsx);

    // Initialize JavaScript parser for .js and .jsx files
    this.javascriptParser = new Parser();
    this.javascriptParser.setLanguage(JavaScript);
  }

  /**
   * Get the appropriate parser for a given file path based on extension.
   */
  getParser(filePath: string): Parser {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.tsx':
        return this.tsxParser;
      case '.ts':
        return this.typescriptParser;
      default:
        return this.javascriptParser;
    }
  }

  /**
   * Extract all top-level definitions from the syntax tree.
   * Delegates to the existing extractDefinitions function.
   */
  extractDefinitions(rootNode: SyntaxNode): Definition[] {
    return extractDefinitions(rootNode);
  }

  /**
   * Extract all import/export references from the syntax tree.
   * Delegates to the existing extractReferences function.
   */
  extractReferences(
    rootNode: SyntaxNode,
    filePath: string,
    knownFiles: Set<string>,
    workspaceMap?: WorkspaceMap | null
  ): FileReference[] {
    return extractReferences(rootNode, filePath, knownFiles, workspaceMap);
  }

  /**
   * Extract internal symbol usages within the same file.
   * Delegates to the existing extractInternalUsages function.
   */
  extractInternalUsages(rootNode: SyntaxNode, definitions: Definition[]): InternalSymbolUsage[] {
    return extractInternalUsages(rootNode, definitions);
  }

  /**
   * Resolve an import path to an absolute file path.
   * Delegates to the existing resolveImportPath function.
   */
  resolveImportPath(
    source: string,
    fromFile: string,
    knownFiles: Set<string>,
    workspaceMap?: WorkspaceMap | null
  ): string | null {
    return resolveImportPath(source, fromFile, knownFiles, workspaceMap) ?? null;
  }
}

// Auto-register the TypeScript adapter on import
const typeScriptAdapter = new TypeScriptAdapter();
const registry = LanguageRegistry.getInstance();
registry.register(typeScriptAdapter);
