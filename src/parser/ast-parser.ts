import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import { getLanguageFromExtension } from '../utils/file-scanner.js';
import { type Definition, extractDefinitions } from './definition-extractor.js';
import {
  type FileReference,
  type InternalSymbolUsage,
  extractInternalUsages,
  extractReferences,
} from './reference-extractor.js';
import type { WorkspaceMap } from './workspace-resolver.js';

export interface ParsedFile {
  language: 'typescript' | 'javascript';
  references: FileReference[];
  definitions: Definition[];
  internalUsages: InternalSymbolUsage[];
  content: string;
  sizeBytes: number;
  modifiedAt: string;
}

export type { FileReference, Definition, InternalSymbolUsage };

const typescriptParser = new Parser();
typescriptParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

const javascriptParser = new Parser();
javascriptParser.setLanguage(JavaScript);

function getParser(filePath: string): Parser {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.tsx':
      return tsxParser;
    case '.ts':
      return typescriptParser;
    default:
      return javascriptParser;
  }
}

/**
 * Pure function that parses already-loaded content into a ParsedFile.
 * This enables testing without file I/O.
 */
export function parseContent(
  content: string,
  filePath: string,
  knownFiles: Set<string>,
  metadata: { sizeBytes: number; modifiedAt: string },
  workspaceMap?: WorkspaceMap | null
): ParsedFile {
  const parser = getParser(filePath);
  // Buffer size: file size × 2 (for UTF-16) + 1MB overhead, minimum 1MB
  const bufferSize = Math.max(1024 * 1024, content.length * 2 + 1024 * 1024);
  const tree = parser.parse(content, undefined, { bufferSize });
  const language = getLanguageFromExtension(filePath);
  const references = extractReferences(tree.rootNode, filePath, knownFiles, workspaceMap);
  const definitions = extractDefinitions(tree.rootNode);
  const internalUsages = extractInternalUsages(tree.rootNode, definitions);

  return {
    language,
    references,
    definitions,
    internalUsages,
    content,
    sizeBytes: metadata.sizeBytes,
    modifiedAt: metadata.modifiedAt,
  };
}

export async function parseFile(
  filePath: string,
  knownFiles: Set<string> = new Set(),
  workspaceMap?: WorkspaceMap | null
): Promise<ParsedFile> {
  const [content, stat] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
  return parseContent(
    content,
    filePath,
    knownFiles,
    {
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    },
    workspaceMap
  );
}

export async function parseFiles(filePaths: string[]): Promise<Map<string, ParsedFile>> {
  const results = new Map<string, ParsedFile>();
  const knownFiles = new Set(filePaths);

  for (const filePath of filePaths) {
    const parsed = await parseFile(filePath, knownFiles);
    results.set(filePath, parsed);
  }

  return results;
}
