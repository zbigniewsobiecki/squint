import type Database from 'better-sqlite3';
import type { IIndexWriter } from '../db/schema.js';
import type { ParsedFile } from '../parser/ast-parser.js';

/**
 * Shared reference resolution utilities used by both parse.ts and incremental-indexer.ts.
 * Extracted to eliminate duplication of re-export chain following and symbol resolution logic.
 */

/**
 * Follow re-export chains to find the original definition.
 * When a module re-exports a symbol from another module, this traces through
 * the chain to find where the symbol is actually defined.
 *
 * When a file isn't in the parsedFiles map (unchanged file not re-parsed),
 * falls back to querying the imports table in the DB.
 *
 * @param symbolName - Symbol name to look up
 * @param filePath - Absolute path to start search
 * @param parsedFiles - Map of parsed files (in-memory)
 * @param definitionMap - Map of file paths to exported definition IDs
 * @param visited - Set of visited paths (cycle detection)
 * @param conn - Optional database connection for fallback (when file not in parsedFiles)
 * @param fileIdMap - Optional map of file paths to IDs (for DB fallback)
 * @returns Definition ID if found, null otherwise
 */
export function followReExportChain(
  symbolName: string,
  filePath: string,
  parsedFiles: Map<string, ParsedFile>,
  definitionMap: Map<string, Map<string, number>>,
  visited: Set<string>,
  conn?: Database.Database,
  fileIdMap?: Map<string, number>
): number | null {
  if (visited.has(filePath) || visited.size >= 5) return null;
  visited.add(filePath);

  const parsed = parsedFiles.get(filePath);
  if (parsed) {
    // Use parsed data when available
    for (const ref of parsed.references) {
      if ((ref.type !== 're-export' && ref.type !== 'export-all') || !ref.resolvedPath) continue;

      if (ref.type === 'export-all') {
        const defId = definitionMap.get(ref.resolvedPath)?.get(symbolName) ?? null;
        if (defId !== null) return defId;
        const found = followReExportChain(
          symbolName,
          ref.resolvedPath,
          parsedFiles,
          definitionMap,
          visited,
          conn,
          fileIdMap
        );
        if (found !== null) return found;
      } else {
        for (const sym of ref.imports) {
          if (sym.name === symbolName || sym.localName === symbolName) {
            const defId = definitionMap.get(ref.resolvedPath)?.get(sym.name) ?? null;
            if (defId !== null) return defId;
            const found = followReExportChain(
              sym.name,
              ref.resolvedPath,
              parsedFiles,
              definitionMap,
              visited,
              conn,
              fileIdMap
            );
            if (found !== null) return found;
          }
        }
      }
    }
    return null;
  }

  // Fallback: use DB imports table for unchanged files not in parsedFiles
  if (!conn || !fileIdMap) return null;
  const fileId = fileIdMap.get(filePath);
  if (!fileId) return null;

  const reExports = conn
    .prepare(
      `SELECT i.type, i.to_file_id as toFileId, tf.path as toFilePath
       FROM imports i
       LEFT JOIN files tf ON i.to_file_id = tf.id
       WHERE i.from_file_id = ? AND i.type IN ('re-export', 'export-all') AND i.to_file_id IS NOT NULL`
    )
    .all(fileId) as Array<{ type: string; toFileId: number; toFilePath: string }>;

  for (const reExp of reExports) {
    // Reconstruct absolute path to look up in definitionMap
    // definitionMap is keyed by absolute path
    let absResolvedPath: string | undefined;
    for (const [absPath, fId] of fileIdMap) {
      if (fId === reExp.toFileId) {
        absResolvedPath = absPath;
        break;
      }
    }
    if (!absResolvedPath) continue;

    if (reExp.type === 'export-all') {
      const defId = definitionMap.get(absResolvedPath)?.get(symbolName) ?? null;
      if (defId !== null) return defId;
      const found = followReExportChain(
        symbolName,
        absResolvedPath,
        parsedFiles,
        definitionMap,
        visited,
        conn,
        fileIdMap
      );
      if (found !== null) return found;
    } else {
      // re-export: check symbols on that import for the name
      const reExpSymbols = conn
        .prepare(
          `SELECT s.name, s.local_name as localName
           FROM symbols s
           JOIN imports i ON s.reference_id = i.id
           WHERE i.from_file_id = ? AND i.to_file_id = ? AND i.type = 're-export'`
        )
        .all(fileId, reExp.toFileId) as Array<{ name: string; localName: string }>;

      for (const sym of reExpSymbols) {
        if (sym.name === symbolName || sym.localName === symbolName) {
          const defId = definitionMap.get(absResolvedPath)?.get(sym.name) ?? null;
          if (defId !== null) return defId;
          const found = followReExportChain(
            sym.name,
            absResolvedPath,
            parsedFiles,
            definitionMap,
            visited,
            conn,
            fileIdMap
          );
          if (found !== null) return found;
        }
      }
    }
  }
  return null;
}

/**
 * Resolve a symbol to its definition ID, handling default imports specially.
 * Extracts the repeated pattern from parse.ts and incremental-indexer.ts.
 *
 * @param sym - Symbol to resolve
 * @param ref - Reference containing the symbol
 * @param definitionMap - Map of file paths to exported definition IDs
 * @param fileIdMap - Map of file paths to file IDs
 * @param db - Database interface for definition lookups
 * @returns Definition ID if found, null otherwise
 */
export function resolveSymbolToDefinition(
  sym: { name: string; kind: string; localName: string },
  ref: { resolvedPath?: string | null; isExternal: boolean },
  definitionMap: Map<string, Map<string, number>>,
  fileIdMap: Map<string, number>,
  db: { getDefinitionByName: (fileId: number, name: string) => number | null }
): number | null {
  if (!ref.resolvedPath || ref.isExternal) return null;

  const targetDefMap = definitionMap.get(ref.resolvedPath);
  if (!targetDefMap) return null;

  // For default imports, look for 'default' export
  // For named imports, look for the original name
  const lookupName = sym.kind === 'default' ? 'default' : sym.name;
  let defId = targetDefMap.get(lookupName) ?? null;

  // Also try the original name for default exports that use a named function/class
  if (defId === null && sym.kind === 'default') {
    const targetFileId = fileIdMap.get(ref.resolvedPath);
    if (targetFileId) {
      for (const [name, id] of targetDefMap) {
        const defCheck = db.getDefinitionByName(targetFileId, name);
        if (defCheck !== null) {
          defId = id;
          break;
        }
      }
    }
  }

  return defId;
}

/**
 * Insert references, symbols, and usages for a single parsed file.
 * Mirrors the logic in parse.ts indexParsedFiles pass 2.
 *
 * @param parsed - Parsed file data
 * @param fromFileId - File ID in database
 * @param db - Database interface
 * @param fileIdMap - Map of file paths to file IDs
 * @param definitionMap - Map of file paths to exported definition IDs
 * @param allParsedFiles - All parsed files (for re-export resolution)
 * @param conn - Database connection (for DB fallback in re-export chains)
 */
export function insertFileReferences(
  parsed: ParsedFile,
  fromFileId: number,
  db: IIndexWriter,
  fileIdMap: Map<string, number>,
  definitionMap: Map<string, Map<string, number>>,
  allParsedFiles: Map<string, ParsedFile>,
  conn: Database.Database
): void {
  for (const ref of parsed.references) {
    const toFileId = ref.resolvedPath ? (fileIdMap.get(ref.resolvedPath) ?? null) : null;
    const refId = db.insertReference(fromFileId, toFileId, ref);

    for (const sym of ref.imports) {
      let defId = resolveSymbolToDefinition(sym, ref, definitionMap, fileIdMap, db);

      // Follow re-export chains (with DB fallback for unchanged files)
      if (defId === null && ref.resolvedPath && !ref.isExternal) {
        defId = followReExportChain(
          sym.kind === 'default' ? 'default' : sym.name,
          ref.resolvedPath,
          allParsedFiles,
          definitionMap,
          new Set(),
          conn,
          fileIdMap
        );
      }

      const symbolId = db.insertSymbol(refId, defId, sym);
      for (const usage of sym.usages) {
        db.insertUsage(symbolId, usage);
      }
    }
  }
}

/**
 * Insert internal usages (same-file calls) for a single parsed file.
 * Mirrors the logic in parse.ts indexParsedFiles pass 3.
 *
 * @param parsed - Parsed file data
 * @param fileId - File ID in database
 * @param filePath - Absolute path to the file (key for allDefinitionMap)
 * @param allDefinitionMap - Map of file paths to all (not just exported) definition IDs
 * @param db - Database interface
 */
export function insertInternalUsages(
  parsed: ParsedFile,
  fileId: number,
  filePath: string,
  allDefinitionMap: Map<string, Map<string, number>>,
  db: IIndexWriter
): void {
  const allDefMap = allDefinitionMap.get(filePath);

  for (const internalUsage of parsed.internalUsages) {
    const defId = allDefMap?.get(internalUsage.definitionName) ?? null;

    // Create a symbol entry for internal usage (no reference_id, has file_id)
    const symbolId = db.insertSymbol(
      null, // no reference_id
      defId,
      {
        name: internalUsage.definitionName,
        localName: internalUsage.definitionName,
        kind: 'named',
        usages: internalUsage.usages,
      },
      fileId // file_id for internal symbols
    );

    // Insert usages for this internal symbol
    for (const usage of internalUsage.usages) {
      db.insertUsage(symbolId, usage);
    }
  }
}

/**
 * Delete all imports, symbols, and usages originating from a file.
 * Used during incremental sync when a file is modified.
 *
 * @param conn - Database connection
 * @param fileId - File ID to clean up
 */
export function deleteFileImportsAndSymbols(conn: Database.Database, fileId: number): void {
  // Delete usages for import-based symbols
  conn
    .prepare(
      `DELETE FROM usages WHERE symbol_id IN
      (SELECT s.id FROM symbols s JOIN imports i ON s.reference_id = i.id
       WHERE i.from_file_id = ?)`
    )
    .run(fileId);

  // Delete usages for internal symbols
  conn
    .prepare(
      `DELETE FROM usages WHERE symbol_id IN
      (SELECT id FROM symbols WHERE file_id = ?)`
    )
    .run(fileId);

  // Delete import-based symbols
  conn
    .prepare(
      `DELETE FROM symbols WHERE reference_id IN
      (SELECT id FROM imports WHERE from_file_id = ?)`
    )
    .run(fileId);

  // Delete internal symbols
  conn.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);

  // Delete imports
  conn.prepare('DELETE FROM imports WHERE from_file_id = ?').run(fileId);
}
