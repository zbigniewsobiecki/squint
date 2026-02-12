import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseContent } from '../../src/parser/ast-parser.js';
import {
  buildWorkspaceMap,
  clearWorkspaceMapCache,
  resolveWorkspaceImport,
} from '../../src/parser/workspace-resolver.js';

// Helper to create a temporary directory structure
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squint-ws-test-'));
}

function writeFile(dir: string, relativePath: string, content: string): string {
  const absPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
  return absPath;
}

describe('buildWorkspaceMap', () => {
  let tempDir: string;

  beforeEach(() => {
    clearWorkspaceMapCache();
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects npm-format workspaces (string[])', () => {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    const entryFile = writeFile(tempDir, 'packages/shared/src/index.ts', 'export const x = 1;');
    writeFile(
      tempDir,
      'packages/shared/package.json',
      JSON.stringify({
        name: '@org/shared',
        main: 'src/index.ts',
      })
    );

    const knownFiles = new Set([entryFile]);
    const map = buildWorkspaceMap(tempDir, knownFiles);

    expect(map).not.toBeNull();
    expect(map!.packages.has('@org/shared')).toBe(true);
    expect(map!.packages.get('@org/shared')!.entryPoint).toBe(entryFile);
  });

  it('detects yarn-format workspaces ({ packages: string[] })', () => {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: { packages: ['packages/*'] },
      })
    );
    const entryFile = writeFile(tempDir, 'packages/utils/src/index.ts', 'export const y = 2;');
    writeFile(
      tempDir,
      'packages/utils/package.json',
      JSON.stringify({
        name: '@org/utils',
        main: 'src/index.ts',
      })
    );

    const knownFiles = new Set([entryFile]);
    const map = buildWorkspaceMap(tempDir, knownFiles);

    expect(map).not.toBeNull();
    expect(map!.packages.has('@org/utils')).toBe(true);
    expect(map!.packages.get('@org/utils')!.entryPoint).toBe(entryFile);
  });

  it('detects pnpm-workspace.yaml format', () => {
    writeFile(
      tempDir,
      'pnpm-workspace.yaml',
      `packages:
  - "packages/*"
`
    );
    writeFile(tempDir, 'package.json', JSON.stringify({ name: 'root' }));
    const entryFile = writeFile(tempDir, 'packages/core/src/index.ts', 'export const z = 3;');
    writeFile(
      tempDir,
      'packages/core/package.json',
      JSON.stringify({
        name: '@org/core',
        main: 'src/index.ts',
      })
    );

    const knownFiles = new Set([entryFile]);
    const map = buildWorkspaceMap(tempDir, knownFiles);

    expect(map).not.toBeNull();
    expect(map!.packages.has('@org/core')).toBe(true);
  });

  it('resolves entry from exports field', () => {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    const entryFile = writeFile(tempDir, 'packages/lib/src/main.ts', 'export const a = 1;');
    writeFile(
      tempDir,
      'packages/lib/package.json',
      JSON.stringify({
        name: 'my-lib',
        exports: { '.': { import: './src/main.ts' } },
      })
    );

    const knownFiles = new Set([entryFile]);
    const map = buildWorkspaceMap(tempDir, knownFiles);

    expect(map).not.toBeNull();
    expect(map!.packages.get('my-lib')!.entryPoint).toBe(entryFile);
  });

  it('falls back to src/index.ts when no main or exports', () => {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    const entryFile = writeFile(tempDir, 'packages/types/src/index.ts', 'export type Foo = string;');
    writeFile(
      tempDir,
      'packages/types/package.json',
      JSON.stringify({
        name: '@org/types',
      })
    );

    const knownFiles = new Set([entryFile]);
    const map = buildWorkspaceMap(tempDir, knownFiles);

    expect(map).not.toBeNull();
    expect(map!.packages.get('@org/types')!.entryPoint).toBe(entryFile);
  });

  it('returns null when no workspace config found', () => {
    writeFile(tempDir, 'package.json', JSON.stringify({ name: 'root' }));

    const knownFiles = new Set<string>();
    const map = buildWorkspaceMap(tempDir, knownFiles);

    expect(map).toBeNull();
  });

  it('skips packages without matching entry in knownFiles', () => {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    // Create the package.json but DON'T add the entry file to knownFiles
    writeFile(tempDir, 'packages/ghost/src/index.ts', 'export const g = 1;');
    writeFile(
      tempDir,
      'packages/ghost/package.json',
      JSON.stringify({
        name: '@org/ghost',
        main: 'src/index.ts',
      })
    );

    const knownFiles = new Set<string>(); // Empty — nothing is known
    const map = buildWorkspaceMap(tempDir, knownFiles);

    // Workspace config found but no packages could be resolved
    expect(map).toBeNull();
  });
});

describe('resolveWorkspaceImport', () => {
  let tempDir: string;

  beforeEach(() => {
    clearWorkspaceMapCache();
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupWorkspace(): {
    knownFiles: Set<string>;
    entryFile: string;
    typesFile: string;
  } {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    const entryFile = writeFile(tempDir, 'packages/shared/src/index.ts', 'export * from "./types";');
    const typesFile = writeFile(tempDir, 'packages/shared/src/types.ts', 'export type User = { id: string };');
    writeFile(
      tempDir,
      'packages/shared/package.json',
      JSON.stringify({
        name: '@org/shared-types',
        main: 'src/index.ts',
      })
    );

    return {
      knownFiles: new Set([entryFile, typesFile]),
      entryFile,
      typesFile,
    };
  }

  it('resolves scoped package to entry point', () => {
    const { knownFiles, entryFile } = setupWorkspace();
    const map = buildWorkspaceMap(tempDir, knownFiles)!;

    const result = resolveWorkspaceImport('@org/shared-types', map, knownFiles);
    expect(result).toBe(entryFile);
  });

  it('resolves scoped package subpath', () => {
    const { knownFiles, typesFile } = setupWorkspace();
    const map = buildWorkspaceMap(tempDir, knownFiles)!;

    const result = resolveWorkspaceImport('@org/shared-types/src/types', map, knownFiles);
    expect(result).toBe(typesFile);
  });

  it('returns undefined for non-workspace bare import', () => {
    const { knownFiles } = setupWorkspace();
    const map = buildWorkspaceMap(tempDir, knownFiles)!;

    const result = resolveWorkspaceImport('lodash', map, knownFiles);
    expect(result).toBeUndefined();
  });

  it('returns undefined for unknown scoped package', () => {
    const { knownFiles } = setupWorkspace();
    const map = buildWorkspaceMap(tempDir, knownFiles)!;

    const result = resolveWorkspaceImport('@other/pkg', map, knownFiles);
    expect(result).toBeUndefined();
  });

  it('resolves subpath with exports field patterns', () => {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    const typesFile = writeFile(tempDir, 'packages/shared/src/types/index.ts', 'export type T = number;');
    const entryFile = writeFile(tempDir, 'packages/shared/src/index.ts', 'export const main = 1;');
    writeFile(
      tempDir,
      'packages/shared/package.json',
      JSON.stringify({
        name: '@org/shared',
        main: 'src/index.ts',
        exports: {
          '.': './src/index.ts',
          './types': './src/types/index.ts',
        },
      })
    );

    const knownFiles = new Set([entryFile, typesFile]);
    const map = buildWorkspaceMap(tempDir, knownFiles)!;

    const result = resolveWorkspaceImport('@org/shared/types', map, knownFiles);
    expect(result).toBe(typesFile);
  });
});

describe('workspace-aware parsing integration', () => {
  let tempDir: string;

  beforeEach(() => {
    clearWorkspaceMapCache();
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves workspace imports as non-external in parseContent', () => {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    const sharedEntry = writeFile(tempDir, 'packages/shared/src/index.ts', 'export type User = { id: string };');
    writeFile(
      tempDir,
      'packages/shared/package.json',
      JSON.stringify({
        name: '@org/shared-types',
        main: 'src/index.ts',
      })
    );

    const appFile = path.join(tempDir, 'packages/app/src/main.ts');
    const content = `import { User } from '@org/shared-types';
const u: User = { id: '1' };
`;

    const knownFiles = new Set([sharedEntry, appFile]);
    const workspaceMap = buildWorkspaceMap(tempDir, knownFiles)!;

    const result = parseContent(
      content,
      appFile,
      knownFiles,
      {
        sizeBytes: content.length,
        modifiedAt: new Date().toISOString(),
      },
      workspaceMap
    );

    expect(result.references).toHaveLength(1);
    const ref = result.references[0];
    expect(ref.source).toBe('@org/shared-types');
    expect(ref.isExternal).toBe(false);
    expect(ref.resolvedPath).toBe(sharedEntry);
  });

  it('still marks true external packages as external', () => {
    writeFile(
      tempDir,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    const sharedEntry = writeFile(tempDir, 'packages/shared/src/index.ts', 'export const x = 1;');
    writeFile(
      tempDir,
      'packages/shared/package.json',
      JSON.stringify({
        name: '@org/shared',
        main: 'src/index.ts',
      })
    );

    const appFile = path.join(tempDir, 'packages/app/src/main.ts');
    const content = `import lodash from 'lodash';
import { x } from '@org/shared';
`;

    const knownFiles = new Set([sharedEntry, appFile]);
    const workspaceMap = buildWorkspaceMap(tempDir, knownFiles)!;

    const result = parseContent(
      content,
      appFile,
      knownFiles,
      {
        sizeBytes: content.length,
        modifiedAt: new Date().toISOString(),
      },
      workspaceMap
    );

    expect(result.references).toHaveLength(2);

    const lodashRef = result.references.find((r) => r.source === 'lodash')!;
    expect(lodashRef.isExternal).toBe(true);
    expect(lodashRef.resolvedPath).toBeUndefined();

    const sharedRef = result.references.find((r) => r.source === '@org/shared')!;
    expect(sharedRef.isExternal).toBe(false);
    expect(sharedRef.resolvedPath).toBe(sharedEntry);
  });
});
