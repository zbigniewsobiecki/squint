import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFileId } from '../../../src/commands/_shared/file-resolver.js';
import type { IndexDatabase } from '../../../src/db/database.js';

describe('resolveFileId', () => {
  let mockDb: IndexDatabase;
  const fakeRelativePath = 'src/services/user.ts';
  const fakeAbsolutePath = '/workspace/project/src/services/user.ts';

  beforeEach(() => {
    mockDb = {
      toRelativePath: vi.fn((p: string) => {
        // Simulate: strip workspace root prefix
        return p.startsWith('/workspace/project/') ? p.replace('/workspace/project/', '') : p;
      }),
      files: {
        getIdByPath: vi.fn((p: string): number | null => {
          if (p === fakeRelativePath) return 42;
          return null;
        }),
      },
    } as unknown as IndexDatabase;
  });

  it('resolves via relative path (primary strategy)', () => {
    // Provide absolute path; helper should convert to relative and find it
    const result = resolveFileId(mockDb, fakeAbsolutePath);
    expect(result).toBe(42);
    expect(mockDb.files.getIdByPath).toHaveBeenCalledWith(fakeRelativePath);
  });

  it('resolves via absolute path when relative lookup fails', () => {
    // Make relative lookup fail, absolute succeed
    vi.mocked(mockDb.files.getIdByPath).mockImplementation((p: string) => {
      if (p === fakeAbsolutePath) return 99;
      return null;
    });

    const result = resolveFileId(mockDb, fakeAbsolutePath);
    expect(result).toBe(99);
  });

  it('resolves via original path as last resort', () => {
    const shortPath = 'user.ts';
    vi.mocked(mockDb.files.getIdByPath).mockImplementation((p: string) => {
      if (p === shortPath) return 7;
      return null;
    });

    const result = resolveFileId(mockDb, shortPath);
    expect(result).toBe(7);
  });

  it('returns null when none of the strategies match', () => {
    vi.mocked(mockDb.files.getIdByPath).mockReturnValue(null);

    const result = resolveFileId(mockDb, '/nonexistent/path.ts');
    expect(result).toBeNull();
  });

  it('uses path.resolve internally so ~ and relative paths are normalised', () => {
    const relativePath = './src/services/user.ts';
    const expectedResolved = path.resolve(relativePath);
    const expectedRelative = expectedResolved.replace('/workspace/project/', '');

    vi.mocked(mockDb.toRelativePath).mockImplementation((p: string) => {
      return p === expectedResolved ? expectedRelative : p;
    });
    vi.mocked(mockDb.files.getIdByPath).mockImplementation((p: string) => {
      return p === expectedRelative ? 100 : null;
    });

    const result = resolveFileId(mockDb, relativePath);
    expect(result).toBe(100);
  });

  it('prefers relative path over absolute path result', () => {
    // Both relative and absolute would return a value; we should get relative one
    vi.mocked(mockDb.files.getIdByPath).mockImplementation((p: string) => {
      if (p === fakeRelativePath) return 42;
      if (p === fakeAbsolutePath) return 99;
      return null;
    });

    const result = resolveFileId(mockDb, fakeAbsolutePath);
    expect(result).toBe(42); // relative path wins
  });
});
