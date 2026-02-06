import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Definition } from '../parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../parser/reference-extractor.js';

export interface FileInsert {
  path: string;
  language: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface CallsiteResult {
  usageId: number;
  symbolId: number;
  definitionId: number | null;
  filePath: string;
  line: number;
  column: number;
  symbolName: string;
  localName: string;
  argumentCount: number;
  isMethodCall: boolean;
  isConstructorCall: boolean;
  receiverName: string | null;
}

const SCHEMA = `
-- Metadata about the indexing run
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Files indexed by this run
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at TEXT NOT NULL
);

-- All definitions (functions, classes, variables, types) in each file
CREATE TABLE definitions (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  is_exported INTEGER NOT NULL,
  is_default INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  extends_name TEXT,          -- Parent class name (for classes)
  implements_names TEXT,      -- JSON array of interface names (for classes)
  extends_interfaces TEXT,    -- JSON array of parent interfaces (for interfaces)
  FOREIGN KEY (file_id) REFERENCES files(id)
);

-- Import/export relationships between files
CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  from_file_id INTEGER NOT NULL,
  to_file_id INTEGER,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  is_external INTEGER NOT NULL,
  is_type_only INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column INTEGER NOT NULL,
  FOREIGN KEY (from_file_id) REFERENCES files(id),
  FOREIGN KEY (to_file_id) REFERENCES files(id)
);

-- Symbols imported in each reference
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  reference_id INTEGER NOT NULL,
  definition_id INTEGER,
  name TEXT NOT NULL,
  local_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  FOREIGN KEY (reference_id) REFERENCES imports(id),
  FOREIGN KEY (definition_id) REFERENCES definitions(id)
);

-- Where each imported symbol is used in the file
CREATE TABLE usages (
  id INTEGER PRIMARY KEY,
  symbol_id INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column INTEGER NOT NULL,
  context TEXT NOT NULL,
  argument_count INTEGER,
  is_method_call INTEGER,
  is_constructor_call INTEGER,
  receiver_name TEXT,
  FOREIGN KEY (symbol_id) REFERENCES symbols(id)
);

-- Indexes for efficient queries
CREATE INDEX idx_files_path ON files(path);
CREATE INDEX idx_definitions_file ON definitions(file_id);
CREATE INDEX idx_definitions_name ON definitions(name);
CREATE INDEX idx_definitions_extends ON definitions(extends_name);
CREATE INDEX idx_imports_from_file ON imports(from_file_id);
CREATE INDEX idx_imports_to_file ON imports(to_file_id);
CREATE INDEX idx_symbols_reference ON symbols(reference_id);
CREATE INDEX idx_symbols_definition ON symbols(definition_id);
CREATE INDEX idx_usages_symbol ON usages(symbol_id);
CREATE INDEX idx_usages_context ON usages(context);
`;

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Interface for database operations, enabling mocking in tests.
 */
export interface IIndexWriter {
  initialize(): void;
  setMetadata(key: string, value: string): void;
  insertFile(file: FileInsert): number;
  insertDefinition(fileId: number, def: Definition): number;
  insertReference(fromFileId: number, toFileId: number | null, ref: FileReference): number;
  insertSymbol(refId: number, defId: number | null, sym: ImportedSymbol): number;
  insertUsage(symbolId: number, usage: SymbolUsage): void;
  getDefinitionByName(fileId: number, name: string): number | null;
  getDefinitionCount(): number;
  getReferenceCount(): number;
  getUsageCount(): number;
  getCallsites(definitionId: number): CallsiteResult[];
  getCallsitesForFile(fileId: number): CallsiteResult[];
  getCallsiteCount(): number;
  close(): void;
}

export class IndexDatabase implements IIndexWriter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  initialize(): void {
    // Drop all tables if they exist and recreate
    this.db.exec(`
      DROP TABLE IF EXISTS usages;
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS imports;
      DROP TABLE IF EXISTS definitions;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS metadata;
    `);
    this.db.exec(SCHEMA);
  }

  setMetadata(key: string, value: string): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
    );
    stmt.run(key, value);
  }

  insertFile(file: FileInsert): number {
    const stmt = this.db.prepare(`
      INSERT INTO files (path, language, content_hash, size_bytes, modified_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      file.path,
      file.language,
      file.contentHash,
      file.sizeBytes,
      file.modifiedAt
    );
    return result.lastInsertRowid as number;
  }

  insertDefinition(fileId: number, def: Definition): number {
    const stmt = this.db.prepare(`
      INSERT INTO definitions (file_id, name, kind, is_exported, is_default, line, column, end_line, end_column, extends_name, implements_names, extends_interfaces)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      fileId,
      def.name,
      def.kind,
      def.isExported ? 1 : 0,
      def.isDefault ? 1 : 0,
      def.position.row + 1, // Convert to 1-based line numbers
      def.position.column,
      def.endPosition.row + 1,
      def.endPosition.column,
      def.extends ?? null,
      def.implements ? JSON.stringify(def.implements) : null,
      def.extendsAll ? JSON.stringify(def.extendsAll) : null
    );
    return result.lastInsertRowid as number;
  }

  insertReference(
    fromFileId: number,
    toFileId: number | null,
    ref: FileReference
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO imports (from_file_id, to_file_id, type, source, is_external, is_type_only, line, column)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      fromFileId,
      toFileId,
      ref.type,
      ref.source,
      ref.isExternal ? 1 : 0,
      ref.isTypeOnly ? 1 : 0,
      ref.position.row + 1,
      ref.position.column
    );
    return result.lastInsertRowid as number;
  }

  insertSymbol(
    refId: number,
    defId: number | null,
    sym: ImportedSymbol
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO symbols (reference_id, definition_id, name, local_name, kind)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(refId, defId, sym.name, sym.localName, sym.kind);
    return result.lastInsertRowid as number;
  }

  insertUsage(symbolId: number, usage: SymbolUsage): void {
    const stmt = this.db.prepare(`
      INSERT INTO usages (symbol_id, line, column, context, argument_count, is_method_call, is_constructor_call, receiver_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      symbolId,
      usage.position.row + 1,
      usage.position.column,
      usage.context,
      usage.callsite?.argumentCount ?? null,
      usage.callsite?.isMethodCall !== undefined ? (usage.callsite.isMethodCall ? 1 : 0) : null,
      usage.callsite?.isConstructorCall !== undefined ? (usage.callsite.isConstructorCall ? 1 : 0) : null,
      usage.callsite?.receiverName ?? null
    );
  }

  getFileId(path: string): number | null {
    const stmt = this.db.prepare('SELECT id FROM files WHERE path = ?');
    const row = stmt.get(path) as { id: number } | undefined;
    return row?.id ?? null;
  }

  getDefinitionByName(fileId: number, name: string): number | null {
    const stmt = this.db.prepare(
      'SELECT id FROM definitions WHERE file_id = ? AND name = ? AND is_exported = 1'
    );
    const row = stmt.get(fileId, name) as { id: number } | undefined;
    return row?.id ?? null;
  }

  getDefinitionCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM definitions');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  getReferenceCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM imports');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  getUsageCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM usages');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Find all classes that extend a given class
   */
  getSubclasses(className: string): Definition[] {
    const stmt = this.db.prepare(`
      SELECT
        d.name,
        d.kind,
        d.is_exported,
        d.is_default,
        d.line,
        d.column,
        d.end_line,
        d.end_column,
        d.extends_name,
        d.implements_names,
        d.extends_interfaces
      FROM definitions d
      WHERE d.extends_name = ?
    `);
    const rows = stmt.all(className) as Array<{
      name: string;
      kind: string;
      is_exported: number;
      is_default: number;
      line: number;
      column: number;
      end_line: number;
      end_column: number;
      extends_name: string | null;
      implements_names: string | null;
      extends_interfaces: string | null;
    }>;

    return rows.map((row) => ({
      name: row.name,
      kind: row.kind as Definition['kind'],
      isExported: row.is_exported === 1,
      isDefault: row.is_default === 1,
      position: { row: row.line - 1, column: row.column },
      endPosition: { row: row.end_line - 1, column: row.end_column },
      ...(row.extends_name && { extends: row.extends_name }),
      ...(row.implements_names && { implements: JSON.parse(row.implements_names) as string[] }),
      ...(row.extends_interfaces && { extendsAll: JSON.parse(row.extends_interfaces) as string[] }),
    }));
  }

  /**
   * Find all classes that implement a given interface
   */
  getImplementations(interfaceName: string): Definition[] {
    const stmt = this.db.prepare(`
      SELECT
        d.name,
        d.kind,
        d.is_exported,
        d.is_default,
        d.line,
        d.column,
        d.end_line,
        d.end_column,
        d.extends_name,
        d.implements_names,
        d.extends_interfaces
      FROM definitions d
      WHERE d.implements_names LIKE ?
    `);
    // Use LIKE with JSON pattern to find interface name in the array
    const pattern = `%"${interfaceName}"%`;
    const rows = stmt.all(pattern) as Array<{
      name: string;
      kind: string;
      is_exported: number;
      is_default: number;
      line: number;
      column: number;
      end_line: number;
      end_column: number;
      extends_name: string | null;
      implements_names: string | null;
      extends_interfaces: string | null;
    }>;

    return rows.map((row) => ({
      name: row.name,
      kind: row.kind as Definition['kind'],
      isExported: row.is_exported === 1,
      isDefault: row.is_default === 1,
      position: { row: row.line - 1, column: row.column },
      endPosition: { row: row.end_line - 1, column: row.end_column },
      ...(row.extends_name && { extends: row.extends_name }),
      ...(row.implements_names && { implements: JSON.parse(row.implements_names) as string[] }),
      ...(row.extends_interfaces && { extendsAll: JSON.parse(row.extends_interfaces) as string[] }),
    }));
  }

  getCallsites(definitionId: number): CallsiteResult[] {
    const stmt = this.db.prepare(`
      SELECT
        u.id as usage_id,
        u.symbol_id,
        s.definition_id,
        f.path as file_path,
        u.line,
        u.column,
        s.name as symbol_name,
        s.local_name,
        u.argument_count,
        u.is_method_call,
        u.is_constructor_call,
        u.receiver_name
      FROM usages u
      JOIN symbols s ON u.symbol_id = s.id
      JOIN imports i ON s.reference_id = i.id
      JOIN files f ON i.from_file_id = f.id
      WHERE s.definition_id = ?
        AND (u.context = 'call_expression' OR u.context = 'new_expression')
        AND u.argument_count IS NOT NULL
    `);
    const rows = stmt.all(definitionId) as Array<{
      usage_id: number;
      symbol_id: number;
      definition_id: number | null;
      file_path: string;
      line: number;
      column: number;
      symbol_name: string;
      local_name: string;
      argument_count: number;
      is_method_call: number;
      is_constructor_call: number;
      receiver_name: string | null;
    }>;

    return rows.map((row) => ({
      usageId: row.usage_id,
      symbolId: row.symbol_id,
      definitionId: row.definition_id,
      filePath: row.file_path,
      line: row.line,
      column: row.column,
      symbolName: row.symbol_name,
      localName: row.local_name,
      argumentCount: row.argument_count,
      isMethodCall: row.is_method_call === 1,
      isConstructorCall: row.is_constructor_call === 1,
      receiverName: row.receiver_name,
    }));
  }

  getCallsitesForFile(fileId: number): CallsiteResult[] {
    const stmt = this.db.prepare(`
      SELECT
        u.id as usage_id,
        u.symbol_id,
        s.definition_id,
        f.path as file_path,
        u.line,
        u.column,
        s.name as symbol_name,
        s.local_name,
        u.argument_count,
        u.is_method_call,
        u.is_constructor_call,
        u.receiver_name
      FROM usages u
      JOIN symbols s ON u.symbol_id = s.id
      JOIN imports i ON s.reference_id = i.id
      JOIN files f ON i.from_file_id = f.id
      WHERE i.from_file_id = ?
        AND (u.context = 'call_expression' OR u.context = 'new_expression')
        AND u.argument_count IS NOT NULL
    `);
    const rows = stmt.all(fileId) as Array<{
      usage_id: number;
      symbol_id: number;
      definition_id: number | null;
      file_path: string;
      line: number;
      column: number;
      symbol_name: string;
      local_name: string;
      argument_count: number;
      is_method_call: number;
      is_constructor_call: number;
      receiver_name: string | null;
    }>;

    return rows.map((row) => ({
      usageId: row.usage_id,
      symbolId: row.symbol_id,
      definitionId: row.definition_id,
      filePath: row.file_path,
      line: row.line,
      column: row.column,
      symbolName: row.symbol_name,
      localName: row.local_name,
      argumentCount: row.argument_count,
      isMethodCall: row.is_method_call === 1,
      isConstructorCall: row.is_constructor_call === 1,
      receiverName: row.receiver_name,
    }));
  }

  getCallsiteCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM usages
      WHERE (context = 'call_expression' OR context = 'new_expression')
        AND argument_count IS NOT NULL
    `);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  // ============================================
  // Read-only query methods for the browse API
  // ============================================

  /**
   * Get statistics about the indexed database
   */
  getStats(): { files: number; definitions: number; imports: number; usages: number } {
    const files = (this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number }).count;
    const definitions = this.getDefinitionCount();
    const imports = this.getReferenceCount();
    const usages = this.getUsageCount();
    return { files, definitions, imports, usages };
  }

  /**
   * Get all indexed files
   */
  getAllFiles(): Array<{ id: number; path: string; language: string; sizeBytes: number }> {
    const stmt = this.db.prepare(`
      SELECT id, path, language, size_bytes as sizeBytes
      FROM files
      ORDER BY path
    `);
    return stmt.all() as Array<{ id: number; path: string; language: string; sizeBytes: number }>;
  }

  /**
   * Get all indexed files with import statistics
   */
  getAllFilesWithStats(): Array<{
    id: number;
    path: string;
    importedByCount: number;
    importsCount: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        f.id,
        f.path,
        (SELECT COUNT(DISTINCT i.from_file_id)
         FROM imports i
         WHERE i.to_file_id = f.id AND i.is_external = 0) as importedByCount,
        (SELECT COUNT(DISTINCT i.to_file_id)
         FROM imports i
         WHERE i.from_file_id = f.id AND i.is_external = 0 AND i.to_file_id IS NOT NULL) as importsCount
      FROM files f
      ORDER BY f.path
    `);
    return stmt.all() as Array<{
      id: number;
      path: string;
      importedByCount: number;
      importsCount: number;
    }>;
  }

  /**
   * Get all definitions with optional filters
   */
  getAllDefinitions(filters?: { kind?: string; exported?: boolean }): Array<{
    id: number;
    fileId: number;
    name: string;
    kind: string;
    isExported: boolean;
    isDefault: boolean;
    line: number;
    column: number;
    extendsName: string | null;
  }> {
    let sql = `
      SELECT
        id,
        file_id as fileId,
        name,
        kind,
        is_exported as isExported,
        is_default as isDefault,
        line,
        column,
        extends_name as extendsName
      FROM definitions
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (filters?.kind) {
      sql += ' AND kind = ?';
      params.push(filters.kind);
    }
    if (filters?.exported !== undefined) {
      sql += ' AND is_exported = ?';
      params.push(filters.exported ? 1 : 0);
    }

    sql += ' ORDER BY name';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      id: number;
      fileId: number;
      name: string;
      kind: string;
      isExported: number;
      isDefault: number;
      line: number;
      column: number;
      extendsName: string | null;
    }>;

    return rows.map(row => ({
      ...row,
      isExported: row.isExported === 1,
      isDefault: row.isDefault === 1,
    }));
  }

  /**
   * Get definitions for a specific file
   */
  getFileDefinitions(fileId: number): Array<{
    id: number;
    name: string;
    kind: string;
    isExported: boolean;
    isDefault: boolean;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    extendsName: string | null;
    implementsNames: string[] | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        id,
        name,
        kind,
        is_exported as isExported,
        is_default as isDefault,
        line,
        column,
        end_line as endLine,
        end_column as endColumn,
        extends_name as extendsName,
        implements_names as implementsNames
      FROM definitions
      WHERE file_id = ?
      ORDER BY line
    `);
    const rows = stmt.all(fileId) as Array<{
      id: number;
      name: string;
      kind: string;
      isExported: number;
      isDefault: number;
      line: number;
      column: number;
      endLine: number;
      endColumn: number;
      extendsName: string | null;
      implementsNames: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      isExported: row.isExported === 1,
      isDefault: row.isDefault === 1,
      line: row.line,
      column: row.column,
      endLine: row.endLine,
      endColumn: row.endColumn,
      extendsName: row.extendsName,
      implementsNames: row.implementsNames ? JSON.parse(row.implementsNames) : null,
    }));
  }

  /**
   * Get imports for a specific file
   */
  getFileImports(fileId: number): Array<{
    id: number;
    toFileId: number | null;
    type: string;
    source: string;
    isExternal: boolean;
    isTypeOnly: boolean;
    line: number;
    column: number;
    toFilePath: string | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        i.id,
        i.to_file_id as toFileId,
        i.type,
        i.source,
        i.is_external as isExternal,
        i.is_type_only as isTypeOnly,
        i.line,
        i.column,
        tf.path as toFilePath
      FROM imports i
      LEFT JOIN files tf ON i.to_file_id = tf.id
      WHERE i.from_file_id = ?
      ORDER BY i.line
    `);
    const rows = stmt.all(fileId) as Array<{
      id: number;
      toFileId: number | null;
      type: string;
      source: string;
      isExternal: number;
      isTypeOnly: number;
      line: number;
      column: number;
      toFilePath: string | null;
    }>;

    return rows.map(row => ({
      ...row,
      isExternal: row.isExternal === 1,
      isTypeOnly: row.isTypeOnly === 1,
    }));
  }

  /**
   * Get files that import a specific file
   */
  getFilesImportedBy(fileId: number): Array<{
    id: number;
    path: string;
    line: number;
    column: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT
        f.id,
        f.path,
        i.line,
        i.column
      FROM imports i
      JOIN files f ON i.from_file_id = f.id
      WHERE i.to_file_id = ? AND i.is_external = 0
      ORDER BY f.path
    `);
    return stmt.all(fileId) as Array<{ id: number; path: string; line: number; column: number }>;
  }

  /**
   * Get file details by ID
   */
  getFileById(id: number): {
    id: number;
    path: string;
    language: string;
    sizeBytes: number;
    modifiedAt: string;
    contentHash: string;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        id,
        path,
        language,
        size_bytes as sizeBytes,
        modified_at as modifiedAt,
        content_hash as contentHash
      FROM files
      WHERE id = ?
    `);
    const row = stmt.get(id) as {
      id: number;
      path: string;
      language: string;
      sizeBytes: number;
      modifiedAt: string;
      contentHash: string;
    } | undefined;
    return row ?? null;
  }

  /**
   * Get definition details by ID
   */
  getDefinitionById(id: number): {
    id: number;
    fileId: number;
    filePath: string;
    name: string;
    kind: string;
    isExported: boolean;
    isDefault: boolean;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    extendsName: string | null;
    implementsNames: string[] | null;
    extendsInterfaces: string[] | null;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        d.id,
        d.file_id as fileId,
        f.path as filePath,
        d.name,
        d.kind,
        d.is_exported as isExported,
        d.is_default as isDefault,
        d.line,
        d.column,
        d.end_line as endLine,
        d.end_column as endColumn,
        d.extends_name as extendsName,
        d.implements_names as implementsNames,
        d.extends_interfaces as extendsInterfaces
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.id = ?
    `);
    const row = stmt.get(id) as {
      id: number;
      fileId: number;
      filePath: string;
      name: string;
      kind: string;
      isExported: number;
      isDefault: number;
      line: number;
      column: number;
      endLine: number;
      endColumn: number;
      extendsName: string | null;
      implementsNames: string | null;
      extendsInterfaces: string | null;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      fileId: row.fileId,
      filePath: row.filePath,
      name: row.name,
      kind: row.kind,
      isExported: row.isExported === 1,
      isDefault: row.isDefault === 1,
      line: row.line,
      column: row.column,
      endLine: row.endLine,
      endColumn: row.endColumn,
      extendsName: row.extendsName,
      implementsNames: row.implementsNames ? JSON.parse(row.implementsNames) : null,
      extendsInterfaces: row.extendsInterfaces ? JSON.parse(row.extendsInterfaces) : null,
    };
  }

  /**
   * Get import dependency graph data for D3 visualization
   */
  getImportGraph(): {
    nodes: Array<{ id: number; name: string; kind: string }>;
    links: Array<{ source: number; target: number; type: string }>;
  } {
    // Get all files as nodes
    const nodesStmt = this.db.prepare(`
      SELECT id, path as name, 'file' as kind
      FROM files
    `);
    const nodes = nodesStmt.all() as Array<{ id: number; name: string; kind: string }>;

    // Get all internal imports as links
    const linksStmt = this.db.prepare(`
      SELECT DISTINCT from_file_id as source, to_file_id as target, type
      FROM imports
      WHERE to_file_id IS NOT NULL
    `);
    const links = linksStmt.all() as Array<{ source: number; target: number; type: string }>;

    return { nodes, links };
  }

  /**
   * Get class hierarchy graph data for D3 visualization
   */
  getClassHierarchy(): {
    nodes: Array<{ id: number; name: string; kind: string; extendsName: string | null }>;
    links: Array<{ source: number; target: number; type: string }>;
  } {
    // Get all classes and interfaces as nodes
    const nodesStmt = this.db.prepare(`
      SELECT id, name, kind, extends_name as extendsName
      FROM definitions
      WHERE kind IN ('class', 'interface')
    `);
    const nodes = nodesStmt.all() as Array<{ id: number; name: string; kind: string; extendsName: string | null }>;

    // Build a map of name -> id for linking
    const nameToId = new Map<string, number>();
    for (const node of nodes) {
      nameToId.set(node.name, node.id);
    }

    // Create links for extends relationships
    const links: Array<{ source: number; target: number; type: string }> = [];
    for (const node of nodes) {
      if (node.extendsName && nameToId.has(node.extendsName)) {
        links.push({
          source: node.id,
          target: nameToId.get(node.extendsName)!,
          type: 'extends',
        });
      }
    }

    // Also add implements relationships
    const implStmt = this.db.prepare(`
      SELECT id, implements_names
      FROM definitions
      WHERE implements_names IS NOT NULL
    `);
    const implRows = implStmt.all() as Array<{ id: number; implements_names: string }>;
    for (const row of implRows) {
      const implements_ = JSON.parse(row.implements_names) as string[];
      for (const iface of implements_) {
        if (nameToId.has(iface)) {
          links.push({
            source: row.id,
            target: nameToId.get(iface)!,
            type: 'implements',
          });
        }
      }
    }

    return { nodes, links };
  }

  /**
   * Get files that have no incoming imports (orphan files)
   */
  getOrphanFiles(options?: { includeIndex?: boolean; includeTests?: boolean }): Array<{ id: number; path: string }> {
    const conditions: string[] = ['i.to_file_id IS NULL'];

    // Filter out index files by default
    if (!options?.includeIndex) {
      conditions.push(`f.path NOT LIKE '%/index.ts'`);
      conditions.push(`f.path NOT LIKE '%/index.tsx'`);
      conditions.push(`f.path NOT LIKE '%/index.js'`);
      conditions.push(`f.path NOT LIKE '%/index.jsx'`);
      conditions.push(`f.path NOT LIKE '%/index.mjs'`);
      conditions.push(`f.path NOT LIKE '%/index.cjs'`);
    }

    // Filter out test files by default
    if (!options?.includeTests) {
      conditions.push(`f.path NOT LIKE '%.test.ts'`);
      conditions.push(`f.path NOT LIKE '%.test.tsx'`);
      conditions.push(`f.path NOT LIKE '%.test.js'`);
      conditions.push(`f.path NOT LIKE '%.test.jsx'`);
      conditions.push(`f.path NOT LIKE '%.spec.ts'`);
      conditions.push(`f.path NOT LIKE '%.spec.tsx'`);
      conditions.push(`f.path NOT LIKE '%.spec.js'`);
      conditions.push(`f.path NOT LIKE '%.spec.jsx'`);
      conditions.push(`f.path NOT LIKE '%/__tests__/%'`);
      conditions.push(`f.path NOT LIKE '%/test/%'`);
      conditions.push(`f.path NOT LIKE '%/tests/%'`);
    }

    const sql = `
      SELECT f.id, f.path
      FROM files f
      LEFT JOIN imports i ON f.id = i.to_file_id AND i.is_external = 0
      WHERE ${conditions.join(' AND ')}
      ORDER BY f.path
    `;

    const stmt = this.db.prepare(sql);
    return stmt.all() as Array<{ id: number; path: string }>;
  }

  /**
   * Get files in optimal reading order using topological sort (Kahn's algorithm).
   * Files with no internal imports (leaves) come first, then files that only depend on those, etc.
   * Cycles are detected and grouped together.
   */
  getFilesInReadingOrder(options?: { excludeTests?: boolean }): Array<{
    id: number;
    path: string;
    depth: number;
    cycleGroup?: number;
  }> {
    // Get all files
    const filesStmt = this.db.prepare('SELECT id, path FROM files');
    const allFiles = filesStmt.all() as Array<{ id: number; path: string }>;

    // Filter test files if requested
    let files = allFiles;
    if (options?.excludeTests) {
      files = allFiles.filter(f => {
        const p = f.path;
        return !p.includes('.test.') &&
               !p.includes('.spec.') &&
               !p.includes('/__tests__/') &&
               !p.includes('/test/') &&
               !p.includes('/tests/');
      });
    }

    const fileIds = new Set(files.map(f => f.id));
    const fileMap = new Map(files.map(f => [f.id, f.path]));

    // Build adjacency list: for each file, which files does it import (depend on)
    // A file "depends on" the files it imports
    const importsStmt = this.db.prepare(`
      SELECT DISTINCT from_file_id, to_file_id
      FROM imports
      WHERE to_file_id IS NOT NULL AND is_external = 0
    `);
    const importRows = importsStmt.all() as Array<{ from_file_id: number; to_file_id: number }>;

    // dependsOn[A] = set of files that A imports (A depends on these)
    const dependsOn = new Map<number, Set<number>>();
    // dependedBy[A] = set of files that import A (these depend on A)
    const dependedBy = new Map<number, Set<number>>();

    for (const fileId of fileIds) {
      dependsOn.set(fileId, new Set());
      dependedBy.set(fileId, new Set());
    }

    for (const row of importRows) {
      // Only consider imports between files in our filtered set
      if (fileIds.has(row.from_file_id) && fileIds.has(row.to_file_id)) {
        dependsOn.get(row.from_file_id)!.add(row.to_file_id);
        dependedBy.get(row.to_file_id)!.add(row.from_file_id);
      }
    }

    // Kahn's algorithm for topological sort
    // In-degree = number of internal imports (files this file depends on)
    const inDegree = new Map<number, number>();
    for (const fileId of fileIds) {
      inDegree.set(fileId, dependsOn.get(fileId)!.size);
    }

    // Queue starts with leaves (files with no internal imports)
    const queue: number[] = [];
    for (const fileId of fileIds) {
      if (inDegree.get(fileId) === 0) {
        queue.push(fileId);
      }
    }

    const result: Array<{ id: number; path: string; depth: number; cycleGroup?: number }> = [];
    const processed = new Set<number>();
    let currentDepth = 0;

    // Process level by level to track depth
    while (queue.length > 0) {
      const levelSize = queue.length;
      const nextLevel: number[] = [];

      for (let i = 0; i < levelSize; i++) {
        const fileId = queue[i];
        if (processed.has(fileId)) continue;

        processed.add(fileId);
        result.push({
          id: fileId,
          path: fileMap.get(fileId)!,
          depth: currentDepth,
        });

        // For each file that depends on this file, decrement its in-degree
        for (const dependentId of dependedBy.get(fileId)!) {
          const newDegree = inDegree.get(dependentId)! - 1;
          inDegree.set(dependentId, newDegree);
          if (newDegree === 0 && !processed.has(dependentId)) {
            nextLevel.push(dependentId);
          }
        }
      }

      queue.length = 0;
      queue.push(...nextLevel);
      if (nextLevel.length > 0) {
        currentDepth++;
      }
    }

    // Handle cycles: files remaining after queue is empty are in cycles
    const remaining = [...fileIds].filter(id => !processed.has(id));
    if (remaining.length > 0) {
      // Find connected components among remaining files (cycle groups)
      const visited = new Set<number>();
      let cycleGroupNum = 0;

      for (const startId of remaining) {
        if (visited.has(startId)) continue;

        // BFS to find all files in this cycle group
        const cycleQueue = [startId];
        const cycleGroup: number[] = [];

        while (cycleQueue.length > 0) {
          const fileId = cycleQueue.shift()!;
          if (visited.has(fileId)) continue;
          visited.add(fileId);
          cycleGroup.push(fileId);

          // Add connected files (both directions)
          for (const depId of dependsOn.get(fileId)!) {
            if (!visited.has(depId) && remaining.includes(depId)) {
              cycleQueue.push(depId);
            }
          }
          for (const depById of dependedBy.get(fileId)!) {
            if (!visited.has(depById) && remaining.includes(depById)) {
              cycleQueue.push(depById);
            }
          }
        }

        // Add all files in this cycle group
        for (const fileId of cycleGroup) {
          result.push({
            id: fileId,
            path: fileMap.get(fileId)!,
            depth: currentDepth,
            cycleGroup: cycleGroupNum,
          });
        }
        cycleGroupNum++;
      }
    }

    return result;
  }

  /**
   * Get all symbols (definitions) with optional filters
   */
  getSymbols(filters?: { kind?: string; fileId?: number }): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
  }> {
    let sql = `
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (filters?.kind) {
      sql += ' AND d.kind = ?';
      params.push(filters.kind);
    }
    if (filters?.fileId !== undefined) {
      sql += ' AND d.file_id = ?';
      params.push(filters.fileId);
    }

    sql += ' ORDER BY f.path, d.line';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
    }>;
  }

  close(): void {
    this.db.close();
  }
}
