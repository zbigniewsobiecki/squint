import type { Command } from '@oclif/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SymbolResolver } from '../../../src/commands/_shared/symbol-resolver.js';
import type { IndexDatabase } from '../../../src/db/database.js';

// Mock definition data
const mockDefinitions = [
  {
    id: 1,
    name: 'UserService',
    kind: 'class',
    filePath: '/src/services/user-service.ts',
    line: 10,
    endLine: 100,
    isExported: true,
  },
  {
    id: 2,
    name: 'UserService',
    kind: 'class',
    filePath: '/src/other/user-service.ts',
    line: 5,
    endLine: 50,
    isExported: true,
  },
  {
    id: 3,
    name: 'AuthHelper',
    kind: 'function',
    filePath: '/src/helpers/auth.ts',
    line: 1,
    endLine: 20,
    isExported: true,
  },
];

describe('SymbolResolver', () => {
  let mockDb: IndexDatabase;
  let mockCommand: Command;
  let resolver: SymbolResolver;
  let logOutput: string[];
  let errorThrown: Error | null;

  beforeEach(() => {
    logOutput = [];
    errorThrown = null;

    mockDb = {
      getDefinitionById: vi.fn((id: number) => {
        return mockDefinitions.find((d) => d.id === id) ?? null;
      }),
      getDefinitionsByName: vi.fn((name: string) => {
        return mockDefinitions.filter((d) => d.name === name);
      }),
    } as unknown as IndexDatabase;

    mockCommand = {
      log: vi.fn((...args: unknown[]) => {
        logOutput.push(args.join(' '));
      }),
      error: vi.fn((message: string) => {
        errorThrown = new Error(message);
        throw errorThrown;
      }),
    } as unknown as Command;

    resolver = new SymbolResolver(mockDb, mockCommand);
  });

  describe('resolve', () => {
    it('resolves by exact name (single match)', () => {
      const result = resolver.resolve('AuthHelper');

      expect(result).not.toBeNull();
      expect(result!.id).toBe(3);
      expect(mockDb.getDefinitionsByName).toHaveBeenCalledWith('AuthHelper');
    });

    it('resolves by ID (direct lookup)', () => {
      const result = resolver.resolve(undefined, 1);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(mockDb.getDefinitionById).toHaveBeenCalledWith(1);
    });

    it('handles ambiguous names (multiple matches) - returns null with disambiguation', () => {
      const result = resolver.resolve('UserService');

      expect(result).toBeNull();
      expect(logOutput.some((line) => line.includes('Multiple symbols found'))).toBe(true);
      expect(logOutput.some((line) => line.includes('--id') || line.includes('--file'))).toBe(true);
    });

    it('throws error for non-existent name', () => {
      expect(() => resolver.resolve('NonExistent')).toThrow();
      expect(mockCommand.error).toHaveBeenCalled();
    });

    it('throws error for non-existent ID', () => {
      expect(() => resolver.resolve(undefined, 999)).toThrow();
      expect(mockCommand.error).toHaveBeenCalled();
    });

    it('filters by file path to disambiguate', () => {
      const result = resolver.resolve('UserService', undefined, '/src/services/user-service.ts');

      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
    });

    it('filters by partial file path', () => {
      const result = resolver.resolve('UserService', undefined, 'other/user-service.ts');

      expect(result).not.toBeNull();
      expect(result!.id).toBe(2);
    });

    it('throws error when file path filter yields no results', () => {
      expect(() => resolver.resolve('UserService', undefined, 'nonexistent/path.ts')).toThrow();
    });

    it('throws error when name is missing and no ID provided', () => {
      expect(() => resolver.resolve(undefined, undefined)).toThrow();
    });

    it('uses custom flag prefix for error messages', () => {
      expect(() => resolver.resolve(undefined, undefined, undefined, 'from')).toThrow();
      expect(mockCommand.error).toHaveBeenCalledWith(expect.stringContaining('--from'));
    });

    it('shows disambiguation with custom flag prefix', () => {
      const result = resolver.resolve('UserService', undefined, undefined, 'source');

      expect(result).toBeNull();
      expect(logOutput.some((line) => line.includes('--source-id'))).toBe(true);
    });
  });

  describe('resolveSilent', () => {
    it('resolves by ID silently', () => {
      const result = resolver.resolveSilent(undefined, 1);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.name).toBe('UserService');
      expect(result!.kind).toBe('class');
    });

    it('returns null for non-existent ID silently', () => {
      const result = resolver.resolveSilent(undefined, 999);

      expect(result).toBeNull();
      expect(mockCommand.error).not.toHaveBeenCalled();
    });

    it('resolves by name silently (single match)', () => {
      const result = resolver.resolveSilent('AuthHelper');

      expect(result).not.toBeNull();
      expect(result!.id).toBe(3);
      expect(result!.name).toBe('AuthHelper');
    });

    it('returns null for non-existent name silently', () => {
      const result = resolver.resolveSilent('NonExistent');

      expect(result).toBeNull();
      expect(mockCommand.error).not.toHaveBeenCalled();
    });

    it('returns null when no name or id provided', () => {
      const result = resolver.resolveSilent();

      expect(result).toBeNull();
    });

    it('returns null for ambiguous names silently', () => {
      const result = resolver.resolveSilent('UserService');

      expect(result).toBeNull();
      expect(mockCommand.error).not.toHaveBeenCalled();
      expect(mockCommand.log).not.toHaveBeenCalled();
    });

    it('filters by file path silently', () => {
      const result = resolver.resolveSilent('UserService', undefined, '/src/services/user-service.ts');

      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
    });

    it('returns null when file path filter yields no results silently', () => {
      const result = resolver.resolveSilent('UserService', undefined, 'nonexistent/path.ts');

      expect(result).toBeNull();
      expect(mockCommand.error).not.toHaveBeenCalled();
    });
  });
});
