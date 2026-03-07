import fs from 'node:fs/promises';
import path from 'node:path';
import type { Definition } from './definition-extractor.js';
import { LanguageRegistry } from './language-adapter.js';
import type { FileReference, InternalSymbolUsage } from './reference-extractor.js';
import type { WorkspaceMap } from './workspace-resolver.js';
// Import the TypeScriptAdapter to ensure it's registered
import './adapters/typescript-adapter.js';

export interface ParsedFile {
  language: string;
  references: FileReference[];
  definitions: Definition[];
  internalUsages: InternalSymbolUsage[];
  content: string;
  sizeBytes: number;
  modifiedAt: string;
}

// Re-export types for backward compatibility
export type { FileReference, InternalSymbolUsage, Definition };

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
  const registry = LanguageRegistry.getInstance();
  const ext = path.extname(filePath).toLowerCase();
  const adapter = registry.getAdapter(ext);

  if (!adapter) {
    throw new Error(`No language adapter registered for extension: ${ext}`);
  }

  const parser = adapter.getParser(filePath);
  // Buffer size: file size × 2 (for UTF-16) + 1MB overhead, minimum 1MB
  const bufferSize = Math.max(1024 * 1024, content.length * 2 + 1024 * 1024);
  const tree = parser.parse(content, undefined, { bufferSize });

  // Determine language string from file extension for backward compatibility.
  // For the TypeScript adapter, we distinguish between 'typescript' (.ts, .tsx) and 'javascript' (.js, .jsx).
  // Future adapters should use their languageId directly if they don't need this distinction.
  let language: string;
  if (adapter.languageId === 'typescript') {
    language = ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript';
  } else {
    language = adapter.languageId;
  }

  const references = adapter.extractReferences(tree.rootNode, filePath, knownFiles, workspaceMap);
  const definitions = adapter.extractDefinitions(tree.rootNode);
  const internalUsages = adapter.extractInternalUsages(tree.rootNode, definitions);

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
