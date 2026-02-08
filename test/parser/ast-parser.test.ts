import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseContent } from '../../src/parser/ast-parser.js';

describe('parseContent', () => {
  it('parses TypeScript content and extracts definitions', () => {
    const content = `
export function add(a: number, b: number): number {
  return a + b;
}

export const PI = 3.14159;
`;
    const filePath = '/project/utils.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.language).toBe('typescript');
    expect(result.content).toBe(content);
    expect(result.sizeBytes).toBe(content.length);
    expect(result.modifiedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result.definitions).toHaveLength(2);

    const funcDef = result.definitions.find((d) => d.name === 'add');
    expect(funcDef).toBeDefined();
    expect(funcDef?.kind).toBe('function');
    expect(funcDef?.isExported).toBe(true);

    const constDef = result.definitions.find((d) => d.name === 'PI');
    expect(constDef).toBeDefined();
    expect(constDef?.kind).toBe('const');
    expect(constDef?.isExported).toBe(true);
  });

  it('parses JavaScript content', () => {
    const content = `
function greet(name) {
  return 'Hello, ' + name;
}
`;
    const filePath = '/project/greet.js';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.language).toBe('javascript');
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0].name).toBe('greet');
    expect(result.definitions[0].kind).toBe('function');
  });

  it('extracts references from imports', () => {
    const content = `
import { add, subtract } from './utils';

const result = add(1, 2);
`;
    const filePath = '/project/index.ts';
    const utilsPath = '/project/utils.ts';
    const knownFiles = new Set([utilsPath]);
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(1);
    expect(result.references[0].type).toBe('import');
    expect(result.references[0].source).toBe('./utils');
    expect(result.references[0].resolvedPath).toBe(utilsPath);
    expect(result.references[0].isExternal).toBe(false);
    expect(result.references[0].imports).toHaveLength(2);

    const addImport = result.references[0].imports.find((i) => i.name === 'add');
    expect(addImport).toBeDefined();
    expect(addImport?.kind).toBe('named');
    expect(addImport?.usages).toHaveLength(1);
  });

  it('identifies external package imports', () => {
    const content = `
import chalk from 'chalk';
import { readFile } from 'fs/promises';
`;
    const filePath = '/project/index.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.references).toHaveLength(2);
    expect(result.references[0].isExternal).toBe(true);
    expect(result.references[0].resolvedPath).toBeUndefined();
    expect(result.references[1].isExternal).toBe(true);
  });

  it('handles TSX files', () => {
    const content = `
import React from 'react';

export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
`;
    const filePath = '/project/Button.tsx';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.language).toBe('typescript');
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0].name).toBe('Button');
  });

  it('extracts class definitions', () => {
    const content = `
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}
`;
    const filePath = '/project/calculator.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0].name).toBe('Calculator');
    expect(result.definitions[0].kind).toBe('class');
    expect(result.definitions[0].isExported).toBe(true);
  });

  it('extracts interface and type definitions', () => {
    const content = `
export interface User {
  id: string;
  name: string;
}

export type UserId = string;
`;
    const filePath = '/project/types.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.definitions).toHaveLength(2);

    const userDef = result.definitions.find((d) => d.name === 'User');
    expect(userDef?.kind).toBe('interface');

    const userIdDef = result.definitions.find((d) => d.name === 'UserId');
    expect(userIdDef?.kind).toBe('type');
  });
});
