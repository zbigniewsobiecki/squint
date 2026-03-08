import Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import { afterEach, describe, expect, it } from 'vitest';
import type { Definition } from '../../src/parser/definition-extractor.js';
import { type LanguageAdapter, LanguageRegistry } from '../../src/parser/language-adapter.js';
import type { FileReference, InternalSymbolUsage } from '../../src/parser/reference-extractor.js';

// Mock adapter for testing
class MockLanguageAdapter implements LanguageAdapter {
  readonly languageId = 'mock';
  readonly fileExtensions = ['.mock', '.test'];
  readonly defaultIgnorePatterns = ['node_modules/**', 'dist/**'];

  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(JavaScript);
  }

  getParser(_filePath: string): Parser {
    return this.parser;
  }

  extractDefinitions(_rootNode: SyntaxNode): Definition[] {
    return [];
  }

  extractReferences(_rootNode: SyntaxNode, _filePath: string, _knownFiles: Set<string>): FileReference[] {
    return [];
  }

  extractInternalUsages(_rootNode: SyntaxNode, _definitions: Definition[]): InternalSymbolUsage[] {
    return [];
  }

  resolveImportPath(_source: string, _fromFile: string, _knownFiles: Set<string>): string | null {
    return null;
  }
}

// Another mock adapter for testing multiple registrations
class AnotherMockAdapter implements LanguageAdapter {
  readonly languageId = 'another';
  readonly fileExtensions = ['.other'];
  readonly defaultIgnorePatterns = ['build/**'];

  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(JavaScript);
  }

  getParser(_filePath: string): Parser {
    return this.parser;
  }

  extractDefinitions(_rootNode: SyntaxNode): Definition[] {
    return [];
  }

  extractReferences(_rootNode: SyntaxNode, _filePath: string, _knownFiles: Set<string>): FileReference[] {
    return [];
  }

  extractInternalUsages(_rootNode: SyntaxNode, _definitions: Definition[]): InternalSymbolUsage[] {
    return [];
  }

  resolveImportPath(_source: string, _fromFile: string, _knownFiles: Set<string>): string | null {
    return null;
  }
}

describe('LanguageAdapter Interface', () => {
  it('defines required properties', () => {
    const adapter = new MockLanguageAdapter();

    expect(adapter.languageId).toBe('mock');
    expect(adapter.fileExtensions).toEqual(['.mock', '.test']);
    expect(adapter.defaultIgnorePatterns).toEqual(['node_modules/**', 'dist/**']);
  });

  it('defines required methods', () => {
    const adapter = new MockLanguageAdapter();

    expect(typeof adapter.getParser).toBe('function');
    expect(typeof adapter.extractDefinitions).toBe('function');
    expect(typeof adapter.extractReferences).toBe('function');
    expect(typeof adapter.extractInternalUsages).toBe('function');
    expect(typeof adapter.resolveImportPath).toBe('function');
  });

  it('getParser returns a Parser instance', () => {
    const adapter = new MockLanguageAdapter();
    const parser = adapter.getParser('/path/to/file.mock');

    expect(parser).toBeInstanceOf(Parser);
  });

  it('extractDefinitions returns an array', () => {
    const adapter = new MockLanguageAdapter();
    const parser = adapter.getParser('/path/to/file.mock');
    const tree = parser.parse('');
    const definitions = adapter.extractDefinitions(tree.rootNode);

    expect(Array.isArray(definitions)).toBe(true);
  });

  it('extractReferences returns an array', () => {
    const adapter = new MockLanguageAdapter();
    const parser = adapter.getParser('/path/to/file.mock');
    const tree = parser.parse('');
    const references = adapter.extractReferences(tree.rootNode, '/path/to/file.mock', new Set());

    expect(Array.isArray(references)).toBe(true);
  });

  it('extractInternalUsages returns an array', () => {
    const adapter = new MockLanguageAdapter();
    const parser = adapter.getParser('/path/to/file.mock');
    const tree = parser.parse('');
    const usages = adapter.extractInternalUsages(tree.rootNode, []);

    expect(Array.isArray(usages)).toBe(true);
  });

  it('resolveImportPath returns null for unresolvable paths', () => {
    const adapter = new MockLanguageAdapter();
    const result = adapter.resolveImportPath('./unknown', '/path/to/file.mock', new Set());

    expect(result).toBeNull();
  });
});

describe('LanguageRegistry', () => {
  afterEach(() => {
    // Reset singleton after each test
    LanguageRegistry.reset();
  });

  describe('Singleton Pattern', () => {
    it('returns the same instance on multiple calls', () => {
      const registry1 = LanguageRegistry.getInstance();
      const registry2 = LanguageRegistry.getInstance();

      expect(registry1).toBe(registry2);
    });

    it('can be reset', () => {
      const registry1 = LanguageRegistry.getInstance();
      LanguageRegistry.reset();
      const registry2 = LanguageRegistry.getInstance();

      expect(registry1).not.toBe(registry2);
    });
  });

  describe('register', () => {
    it('registers an adapter for its file extensions', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.hasAdapter('.mock')).toBe(true);
      expect(registry.hasAdapter('.test')).toBe(true);
    });

    it('registers multiple adapters', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter1 = new MockLanguageAdapter();
      const adapter2 = new AnotherMockAdapter();

      registry.register(adapter1);
      registry.register(adapter2);

      expect(registry.hasAdapter('.mock')).toBe(true);
      expect(registry.hasAdapter('.other')).toBe(true);
    });

    it('normalizes extensions to lowercase with leading dot', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.hasAdapter('MOCK')).toBe(true);
      expect(registry.hasAdapter('Mock')).toBe(true);
      expect(registry.hasAdapter('.MOCK')).toBe(true);
    });

    it('replaces existing adapter for the same extension', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter1 = new MockLanguageAdapter();
      const adapter2 = new AnotherMockAdapter();

      // Modify adapter2 to use same extension as adapter1
      Object.defineProperty(adapter2, 'fileExtensions', { value: ['.mock'] });

      registry.register(adapter1);
      registry.register(adapter2);

      const result = registry.getAdapter('.mock');
      expect(result?.languageId).toBe('another');
    });
  });

  describe('getAdapter', () => {
    it('returns the registered adapter for an extension', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      const result = registry.getAdapter('.mock');
      expect(result).toBe(adapter);
    });

    it('returns undefined for unregistered extensions', () => {
      const registry = LanguageRegistry.getInstance();

      const result = registry.getAdapter('.unknown');
      expect(result).toBeUndefined();
    });

    it('handles extensions with or without leading dot', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.getAdapter('.mock')).toBe(adapter);
      expect(registry.getAdapter('mock')).toBe(adapter);
    });

    it('is case-insensitive', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.getAdapter('.MOCK')).toBe(adapter);
      expect(registry.getAdapter('Mock')).toBe(adapter);
    });
  });

  describe('getAdapterForFile', () => {
    it('returns the adapter for a file path', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      const result = registry.getAdapterForFile('/path/to/file.mock');
      expect(result).toBe(adapter);
    });

    it('returns undefined for files with no extension', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      const result = registry.getAdapterForFile('/path/to/file');
      expect(result).toBeUndefined();
    });

    it('returns undefined for files with unregistered extensions', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      const result = registry.getAdapterForFile('/path/to/file.unknown');
      expect(result).toBeUndefined();
    });

    it('handles complex file paths', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.getAdapterForFile('/complex/path/with.dots/in.it/file.mock')).toBe(adapter);
    });

    it('is case-insensitive for extensions', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.getAdapterForFile('/path/to/file.MOCK')).toBe(adapter);
      expect(registry.getAdapterForFile('/path/to/file.Mock')).toBe(adapter);
    });
  });

  describe('hasAdapter', () => {
    it('returns true for registered extensions', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.hasAdapter('.mock')).toBe(true);
    });

    it('returns false for unregistered extensions', () => {
      const registry = LanguageRegistry.getInstance();

      expect(registry.hasAdapter('.unknown')).toBe(false);
    });

    it('handles extensions with or without leading dot', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.hasAdapter('.mock')).toBe(true);
      expect(registry.hasAdapter('mock')).toBe(true);
    });
  });

  describe('getRegisteredExtensions', () => {
    it('returns all registered extensions', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter1 = new MockLanguageAdapter();
      const adapter2 = new AnotherMockAdapter();

      registry.register(adapter1);
      registry.register(adapter2);

      const extensions = registry.getRegisteredExtensions();
      expect(extensions).toContain('.mock');
      expect(extensions).toContain('.test');
      expect(extensions).toContain('.other');
      expect(extensions.length).toBe(3);
    });

    it('returns empty array when no adapters are registered', () => {
      const registry = LanguageRegistry.getInstance();

      const extensions = registry.getRegisteredExtensions();
      expect(extensions).toEqual([]);
    });

    it('returns extensions in normalized format (lowercase with dot)', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      const extensions = registry.getRegisteredExtensions();
      for (const ext of extensions) {
        expect(ext.startsWith('.')).toBe(true);
        expect(ext).toBe(ext.toLowerCase());
      }
    });
  });

  describe('unregister', () => {
    it('removes an adapter for a specific extension', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);
      expect(registry.hasAdapter('.mock')).toBe(true);

      const result = registry.unregister('.mock');

      expect(result).toBe(true);
      expect(registry.hasAdapter('.mock')).toBe(false);
    });

    it('returns false for unregistered extensions', () => {
      const registry = LanguageRegistry.getInstance();

      const result = registry.unregister('.unknown');
      expect(result).toBe(false);
    });

    it('handles extensions with or without leading dot', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      expect(registry.unregister('mock')).toBe(true);
      expect(registry.hasAdapter('.mock')).toBe(false);
    });

    it('only removes the specified extension, not others from the same adapter', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);
      registry.unregister('.mock');

      expect(registry.hasAdapter('.mock')).toBe(false);
      expect(registry.hasAdapter('.test')).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all registered adapters', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter1 = new MockLanguageAdapter();
      const adapter2 = new AnotherMockAdapter();

      registry.register(adapter1);
      registry.register(adapter2);

      expect(registry.getRegisteredExtensions().length).toBeGreaterThan(0);

      registry.clear();

      expect(registry.getRegisteredExtensions()).toEqual([]);
      expect(registry.hasAdapter('.mock')).toBe(false);
      expect(registry.hasAdapter('.other')).toBe(false);
    });

    it('can register new adapters after clearing', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);
      registry.clear();
      registry.register(adapter);

      expect(registry.hasAdapter('.mock')).toBe(true);
    });
  });

  describe('getAllExtensions', () => {
    it('returns extensions without leading dots', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = new MockLanguageAdapter();

      registry.register(adapter);

      const extensions = registry.getAllExtensions();
      expect(extensions).toContain('mock');
      expect(extensions).toContain('test');
      expect(extensions.every((ext) => !ext.startsWith('.'))).toBe(true);
    });

    it('returns empty array when no adapters are registered', () => {
      const registry = LanguageRegistry.getInstance();

      const extensions = registry.getAllExtensions();
      expect(extensions).toEqual([]);
    });

    it('deduplicates extensions from multiple adapters', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter1 = new MockLanguageAdapter();
      const adapter2 = new AnotherMockAdapter();

      registry.register(adapter1);
      registry.register(adapter2);

      const extensions = registry.getAllExtensions();
      const unique = [...new Set(extensions)];
      expect(extensions.length).toBe(unique.length);
    });
  });

  describe('getAllIgnorePatterns', () => {
    it('returns all ignore patterns from all adapters', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter1 = new MockLanguageAdapter();
      const adapter2 = new AnotherMockAdapter();

      registry.register(adapter1);
      registry.register(adapter2);

      const patterns = registry.getAllIgnorePatterns();
      expect(patterns).toContain('node_modules/**');
      expect(patterns).toContain('dist/**');
      expect(patterns).toContain('build/**');
    });

    it('returns empty array when no adapters are registered', () => {
      const registry = LanguageRegistry.getInstance();

      const patterns = registry.getAllIgnorePatterns();
      expect(patterns).toEqual([]);
    });

    it('deduplicates patterns from multiple adapters', () => {
      const registry = LanguageRegistry.getInstance();
      const adapter1 = new MockLanguageAdapter();
      const adapter2 = new MockLanguageAdapter();

      registry.register(adapter1);
      // Register the second adapter with different extensions
      Object.defineProperty(adapter2, 'fileExtensions', { value: ['.foo'] });
      registry.register(adapter2);

      const patterns = registry.getAllIgnorePatterns();
      const unique = [...new Set(patterns)];
      expect(patterns.length).toBe(unique.length);
    });
  });
});
