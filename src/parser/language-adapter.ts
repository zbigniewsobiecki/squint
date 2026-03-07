import type Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import type { Definition } from './definition-extractor.js';
import type { FileReference, InternalSymbolUsage } from './reference-extractor.js';
import type { WorkspaceMap } from './workspace-resolver.js';

/**
 * LanguageAdapter defines the contract for supporting different programming languages in Squint.
 * Each language adapter encapsulates language-specific parsing and extraction logic.
 */
export interface LanguageAdapter {
  /**
   * Unique identifier for this language (e.g., 'typescript', 'ruby', 'python')
   */
  readonly languageId: string;

  /**
   * File extensions this adapter handles (e.g., ['.ts', '.tsx'] for TypeScript)
   */
  readonly fileExtensions: string[];

  /**
   * Default patterns to ignore when scanning for files of this language
   * (e.g., ['node_modules/**', 'dist/**'] for JavaScript/TypeScript)
   */
  readonly defaultIgnorePatterns: string[];

  /**
   * Get the tree-sitter parser instance for a specific file path.
   * Different file extensions may require different parser configurations
   * (e.g., .ts vs .tsx for TypeScript).
   *
   * @param filePath - The file path to determine which parser to use
   * @returns Configured tree-sitter Parser instance
   */
  getParser(filePath: string): Parser;

  /**
   * Extract all top-level definitions from the syntax tree.
   * Definitions include functions, classes, variables, types, interfaces, enums, etc.
   *
   * @param rootNode - The root node of the syntax tree
   * @returns Array of extracted definitions
   */
  extractDefinitions(rootNode: SyntaxNode): Definition[];

  /**
   * Extract all import/export references from the syntax tree.
   * References include imports, dynamic imports, requires, re-exports, etc.
   *
   * @param rootNode - The root node of the syntax tree
   * @param filePath - The file being parsed (for resolving relative imports)
   * @param knownFiles - Set of known files in the project (for import resolution)
   * @param workspaceMap - Optional workspace map for resolving workspace imports
   * @returns Array of extracted file references
   */
  extractReferences(
    rootNode: SyntaxNode,
    filePath: string,
    knownFiles: Set<string>,
    workspaceMap?: WorkspaceMap | null
  ): FileReference[];

  /**
   * Extract internal symbol usages within the same file.
   * This tracks how local definitions reference each other within a single file.
   *
   * @param rootNode - The root node of the syntax tree
   * @param definitions - The definitions extracted from this file
   * @returns Array of internal symbol usages
   */
  extractInternalUsages(rootNode: SyntaxNode, definitions: Definition[]): InternalSymbolUsage[];

  /**
   * Resolve an import path to an absolute file path.
   * Handles relative imports, package imports, workspace imports, etc.
   *
   * @param source - The raw import path (e.g., './utils', 'lodash', '#core/types')
   * @param fromFile - The file containing the import statement
   * @param knownFiles - Set of known files in the project
   * @param workspaceMap - Optional workspace map for resolving workspace imports
   * @returns Resolved absolute path, or null if unresolvable
   */
  resolveImportPath(
    source: string,
    fromFile: string,
    knownFiles: Set<string>,
    workspaceMap?: WorkspaceMap | null
  ): string | null;
}

/**
 * LanguageRegistry is a singleton that manages the registration and lookup
 * of language adapters by file extension.
 */
export class LanguageRegistry {
  private static instance: LanguageRegistry | null = null;
  private adapters: Map<string, LanguageAdapter> = new Map();

  private constructor() {
    // Private constructor to enforce singleton pattern
  }

  /**
   * Get the singleton instance of LanguageRegistry
   */
  static getInstance(): LanguageRegistry {
    if (!LanguageRegistry.instance) {
      LanguageRegistry.instance = new LanguageRegistry();
    }
    return LanguageRegistry.instance;
  }

  /**
   * Reset the singleton instance. Useful for testing.
   */
  static reset(): void {
    LanguageRegistry.instance = null;
  }

  /**
   * Register a language adapter for one or more file extensions.
   * If an adapter is already registered for an extension, it will be replaced.
   *
   * @param adapter - The language adapter to register
   */
  register(adapter: LanguageAdapter): void {
    for (const ext of adapter.fileExtensions) {
      // Normalize extension to lowercase with leading dot
      const normalizedExt = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
      this.adapters.set(normalizedExt, adapter);
    }
  }

  /**
   * Look up a language adapter by file extension.
   *
   * @param extension - The file extension to look up (with or without leading dot)
   * @returns The language adapter for this extension, or undefined if not found
   */
  getAdapter(extension: string): LanguageAdapter | undefined {
    // Normalize extension to lowercase with leading dot
    const normalizedExt = extension.toLowerCase().startsWith('.')
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;
    return this.adapters.get(normalizedExt);
  }

  /**
   * Look up a language adapter by file path.
   * Extracts the extension from the path and looks up the adapter.
   *
   * @param filePath - The file path to look up
   * @returns The language adapter for this file, or undefined if not found
   */
  getAdapterForFile(filePath: string): LanguageAdapter | undefined {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return undefined;
    const extension = filePath.slice(lastDot);
    return this.getAdapter(extension);
  }

  /**
   * Check if an adapter is registered for a given extension.
   *
   * @param extension - The file extension to check
   * @returns True if an adapter is registered, false otherwise
   */
  hasAdapter(extension: string): boolean {
    return this.getAdapter(extension) !== undefined;
  }

  /**
   * Get all registered file extensions.
   *
   * @returns Array of registered file extensions
   */
  getRegisteredExtensions(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Unregister an adapter for a specific extension.
   *
   * @param extension - The file extension to unregister
   * @returns True if an adapter was unregistered, false if none was found
   */
  unregister(extension: string): boolean {
    const normalizedExt = extension.toLowerCase().startsWith('.')
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;
    return this.adapters.delete(normalizedExt);
  }

  /**
   * Clear all registered adapters. Useful for testing.
   */
  clear(): void {
    this.adapters.clear();
  }
}
