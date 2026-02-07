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

export interface DependencyInfo {
  dependencyId: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface ReadySymbolInfo {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  dependencyCount: number;
}

export interface DependencyWithMetadata {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  hasAspect: boolean;
  aspectValue: string | null;
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

-- Symbols imported in each reference (or internal symbols within a file)
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  reference_id INTEGER,           -- NULL for internal symbols
  file_id INTEGER,                -- Set for internal symbols (same-file references)
  definition_id INTEGER,
  name TEXT NOT NULL,
  local_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  FOREIGN KEY (reference_id) REFERENCES imports(id),
  FOREIGN KEY (file_id) REFERENCES files(id),
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
CREATE INDEX idx_symbols_file ON symbols(file_id);
CREATE INDEX idx_usages_symbol ON usages(symbol_id);
CREATE INDEX idx_usages_context ON usages(context);

-- Key-value metadata for definitions
CREATE TABLE definition_metadata (
  id INTEGER PRIMARY KEY,
  definition_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  FOREIGN KEY (definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  UNIQUE(definition_id, key)
);

CREATE INDEX idx_definition_metadata_def ON definition_metadata(definition_id);
CREATE INDEX idx_definition_metadata_key ON definition_metadata(key);
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
  insertSymbol(refId: number | null, defId: number | null, sym: ImportedSymbol, fileId?: number): number;
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
      DROP TABLE IF EXISTS definition_metadata;
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
    refId: number | null,
    defId: number | null,
    sym: ImportedSymbol,
    fileId?: number
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO symbols (reference_id, file_id, definition_id, name, local_name, kind)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(refId, fileId ?? null, defId, sym.name, sym.localName, sym.kind);
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

  /**
   * Find all definitions with a given name (for symbol lookup)
   */
  getDefinitionsByName(name: string): Array<{
    id: number;
    filePath: string;
    name: string;
    kind: string;
    line: number;
    endLine: number;
    isExported: boolean;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        d.id,
        f.path as filePath,
        d.name,
        d.kind,
        d.line,
        d.end_line as endLine,
        d.is_exported as isExported
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.name = ?
      ORDER BY f.path
    `);
    const rows = stmt.all(name) as Array<{
      id: number;
      filePath: string;
      name: string;
      kind: string;
      line: number;
      endLine: number;
      isExported: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      filePath: row.filePath,
      name: row.name,
      kind: row.kind,
      line: row.line,
      endLine: row.endLine,
      isExported: row.isExported === 1,
    }));
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
    // Query for both imported and internal call sites using UNION
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
      UNION ALL
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
      JOIN files f ON s.file_id = f.id
      WHERE s.definition_id = ?
        AND s.reference_id IS NULL
        AND (u.context = 'call_expression' OR u.context = 'new_expression')
        AND u.argument_count IS NOT NULL
      ORDER BY file_path, line
    `);
    const rows = stmt.all(definitionId, definitionId) as Array<{
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

  // ============================================
  // Definition metadata methods
  // ============================================

  /**
   * Set metadata on a definition (insert or replace)
   */
  setDefinitionMetadata(definitionId: number, key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO definition_metadata (definition_id, key, value)
      VALUES (?, ?, ?)
    `);
    stmt.run(definitionId, key, value);
  }

  /**
   * Remove a metadata key from a definition
   */
  removeDefinitionMetadata(definitionId: number, key: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM definition_metadata
      WHERE definition_id = ? AND key = ?
    `);
    const result = stmt.run(definitionId, key);
    return result.changes > 0;
  }

  /**
   * Get all metadata for a definition
   */
  getDefinitionMetadata(definitionId: number): Record<string, string> {
    const stmt = this.db.prepare(`
      SELECT key, value FROM definition_metadata
      WHERE definition_id = ?
    `);
    const rows = stmt.all(definitionId) as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Get definition IDs that have a specific metadata key set
   */
  getDefinitionsWithMetadata(key: string): number[] {
    const stmt = this.db.prepare(`
      SELECT definition_id FROM definition_metadata
      WHERE key = ?
    `);
    const rows = stmt.all(key) as Array<{ definition_id: number }>;
    return rows.map(row => row.definition_id);
  }

  /**
   * Get definition IDs that do NOT have a specific metadata key set
   */
  getDefinitionsWithoutMetadata(key: string): number[] {
    const stmt = this.db.prepare(`
      SELECT d.id FROM definitions d
      WHERE NOT EXISTS (
        SELECT 1 FROM definition_metadata dm
        WHERE dm.definition_id = d.id AND dm.key = ?
      )
    `);
    const rows = stmt.all(key) as Array<{ id: number }>;
    return rows.map(row => row.id);
  }

  /**
   * Get all unique metadata keys (aspects) in use
   */
  getMetadataKeys(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT key FROM definition_metadata
      ORDER BY key
    `);
    const rows = stmt.all() as Array<{ key: string }>;
    return rows.map(row => row.key);
  }

  /**
   * Get count of definitions matching filters
   */
  getFilteredDefinitionCount(filters?: { kind?: string; filePattern?: string }): number {
    let sql = `
      SELECT COUNT(*) as count FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE 1=1
    `;
    const params: string[] = [];

    if (filters?.kind) {
      sql += ' AND d.kind = ?';
      params.push(filters.kind);
    }
    if (filters?.filePattern) {
      sql += ' AND f.path LIKE ?';
      params.push(`%${filters.filePattern}%`);
    }

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }

  /**
   * Get coverage stats for aspects (metadata keys).
   * Returns the number of definitions that have each aspect defined.
   */
  getAspectCoverage(filters?: { kind?: string; filePattern?: string }): Array<{
    aspect: string;
    covered: number;
    total: number;
    percentage: number;
  }> {
    // Build the base query for counting total definitions
    let totalSql = `
      SELECT COUNT(*) as count FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE 1=1
    `;
    const totalParams: string[] = [];

    if (filters?.kind) {
      totalSql += ' AND d.kind = ?';
      totalParams.push(filters.kind);
    }
    if (filters?.filePattern) {
      totalSql += ' AND f.path LIKE ?';
      totalParams.push(`%${filters.filePattern}%`);
    }

    const totalStmt = this.db.prepare(totalSql);
    const totalRow = totalStmt.get(...totalParams) as { count: number };
    const total = totalRow.count;

    if (total === 0) {
      return [];
    }

    // Get all unique metadata keys
    const keys = this.getMetadataKeys();

    // For each key, count how many of the filtered definitions have it set
    const results: Array<{
      aspect: string;
      covered: number;
      total: number;
      percentage: number;
    }> = [];

    for (const key of keys) {
      let coveredSql = `
        SELECT COUNT(DISTINCT d.id) as count
        FROM definitions d
        JOIN files f ON d.file_id = f.id
        JOIN definition_metadata dm ON dm.definition_id = d.id
        WHERE dm.key = ?
      `;
      const coveredParams: string[] = [key];

      if (filters?.kind) {
        coveredSql += ' AND d.kind = ?';
        coveredParams.push(filters.kind);
      }
      if (filters?.filePattern) {
        coveredSql += ' AND f.path LIKE ?';
        coveredParams.push(`%${filters.filePattern}%`);
      }

      const coveredStmt = this.db.prepare(coveredSql);
      const coveredRow = coveredStmt.get(...coveredParams) as { count: number };
      const covered = coveredRow.count;

      results.push({
        aspect: key,
        covered,
        total,
        percentage: Math.round((covered / total) * 1000) / 10, // One decimal place
      });
    }

    return results;
  }

  /**
   * Get all symbols that a definition depends on (uses within its line range).
   * This finds usages within the definition's code that reference other definitions.
   */
  getDefinitionDependencies(definitionId: number): DependencyInfo[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT
        dep_def.id as dependencyId,
        dep_def.name,
        dep_def.kind,
        dep_f.path as filePath,
        dep_def.line
      FROM definitions source
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files dep_f ON dep_def.file_id = dep_f.id
      JOIN files source_f ON source.file_id = source_f.id
      WHERE source.id = ?
        AND dep_def.id != source.id
        AND (
          -- Symbol is from an import in the same file
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          -- Or symbol is internal to the same file
          OR s.file_id = source.file_id
        )
      ORDER BY dep_f.path, dep_def.line
    `);
    return stmt.all(definitionId) as DependencyInfo[];
  }

  /**
   * Get dependencies with their metadata status for a specific aspect.
   * Combines dependency lookup with metadata check in a single efficient query.
   */
  getDependenciesWithMetadata(definitionId: number, aspect?: string): DependencyWithMetadata[] {
    const sql = `
      SELECT DISTINCT
        dep_def.id,
        dep_def.name,
        dep_def.kind,
        dep_f.path as filePath,
        dep_def.line,
        CASE WHEN dm.value IS NOT NULL THEN 1 ELSE 0 END as hasAspect,
        dm.value as aspectValue
      FROM definitions source
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files dep_f ON dep_def.file_id = dep_f.id
      LEFT JOIN definition_metadata dm ON dm.definition_id = dep_def.id AND dm.key = ?
      WHERE source.id = ?
        AND dep_def.id != source.id
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
      ORDER BY dep_f.path, dep_def.line
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(aspect ?? '', definitionId) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      hasAspect: number;
      aspectValue: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.filePath,
      line: row.line,
      hasAspect: row.hasAspect === 1,
      aspectValue: row.aspectValue,
    }));
  }

  /**
   * Get dependencies that don't have a specific aspect set.
   * Orders by dependency count (leaf nodes first) for topological processing.
   */
  getUnmetDependencies(definitionId: number, aspect: string): DependencyInfo[] {
    const sql = `
      WITH has_aspect AS (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      )
      SELECT DISTINCT
        dep_def.id as dependencyId,
        dep_def.name,
        dep_def.kind,
        dep_f.path as filePath,
        dep_def.line
      FROM definitions source
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files dep_f ON dep_def.file_id = dep_f.id
      WHERE source.id = ?
        AND dep_def.id != source.id
        AND dep_def.id NOT IN (SELECT definition_id FROM has_aspect)
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
      ORDER BY dep_f.path, dep_def.line
    `;
    const stmt = this.db.prepare(sql);
    return stmt.all(aspect, definitionId) as DependencyInfo[];
  }

  /**
   * Get the full prerequisite chain for understanding a symbol.
   * Returns unmet dependencies in topological order (leaves first).
   * Handles circular dependencies by tracking visited nodes.
   */
  getPrerequisiteChain(definitionId: number, aspect: string): Array<DependencyInfo & { unmetDepCount: number }> {
    const visited = new Set<number>();
    const result: Array<DependencyInfo & { unmetDepCount: number }> = [];

    const processNode = (id: number): void => {
      if (visited.has(id)) return;
      visited.add(id);

      const unmetDeps = this.getUnmetDependencies(id, aspect);

      // Process children first (depth-first)
      for (const dep of unmetDeps) {
        if (!visited.has(dep.dependencyId)) {
          processNode(dep.dependencyId);
        }
      }

      // Add this node after its dependencies (unless it's the root)
      if (id !== definitionId) {
        const nodeUnmetDeps = this.getUnmetDependencies(id, aspect);
        const def = this.getDefinitionById(id);
        if (def) {
          result.push({
            dependencyId: id,
            name: def.name,
            kind: def.kind,
            filePath: def.filePath,
            line: def.line,
            unmetDepCount: nodeUnmetDeps.length,
          });
        }
      }
    };

    // Start from the target definition
    const directUnmet = this.getUnmetDependencies(definitionId, aspect);
    for (const dep of directUnmet) {
      processNode(dep.dependencyId);
    }

    // Sort by unmet dependency count (leaves first)
    result.sort((a, b) => a.unmetDepCount - b.unmetDepCount);

    return result;
  }

  /**
   * Find symbols that are "ready to understand" for a given aspect.
   * A symbol is ready when all its dependencies already have the aspect set (or it has no dependencies).
   * Excludes symbols that already have the aspect set.
   */
  getReadyToUnderstandSymbols(
    aspect: string,
    options?: { limit?: number; kind?: string; filePattern?: string }
  ): { symbols: ReadySymbolInfo[]; totalReady: number; remaining: number } {
    const limit = options?.limit ?? 20;

    // Build filter conditions and collect filter params
    let filterConditions = '';
    const filterParams: (string | number)[] = [];

    if (options?.kind) {
      filterConditions += ' AND d.kind = ?';
      filterParams.push(options.kind);
    }
    if (options?.filePattern) {
      filterConditions += ' AND f.path LIKE ?';
      filterParams.push(`%${options.filePattern}%`);
    }

    // The main query uses CTEs:
    // 1. understood: definitions that already have the aspect set
    // 2. definition_deps: maps each definition to its dependencies
    // 3. unmet: definitions that have at least one dependency without the aspect
    const sql = `
      WITH understood AS (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      ),
      definition_deps AS (
        SELECT DISTINCT
          source.id as definition_id,
          dep_def.id as dependency_id
        FROM definitions source
        JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
        JOIN symbols s ON u.symbol_id = s.id
        JOIN definitions dep_def ON s.definition_id = dep_def.id
        JOIN files source_f ON source.file_id = source_f.id
        WHERE dep_def.id != source.id
          AND (
            s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
            OR s.file_id = source.file_id
          )
      ),
      unmet AS (
        SELECT DISTINCT definition_id
        FROM definition_deps
        WHERE dependency_id NOT IN (SELECT definition_id FROM understood)
      )
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        d.end_line as endLine,
        COALESCE(dep_count.cnt, 0) as dependencyCount
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      LEFT JOIN (
        SELECT definition_id, COUNT(*) as cnt
        FROM definition_deps
        GROUP BY definition_id
      ) dep_count ON dep_count.definition_id = d.id
      WHERE d.id NOT IN (SELECT definition_id FROM understood)
        AND d.id NOT IN (SELECT definition_id FROM unmet)
        ${filterConditions}
      ORDER BY dependencyCount ASC, f.path, d.line
      LIMIT ?
    `;

    const params: (string | number)[] = [aspect, ...filterParams, limit];
    const stmt = this.db.prepare(sql);
    const symbols = stmt.all(...params) as ReadySymbolInfo[];

    // Get counts for the summary
    // The count query has filter conditions in two places: subquery and main WHERE
    // So we need to provide filter params twice
    const countSql = `
      WITH understood AS (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      ),
      definition_deps AS (
        SELECT DISTINCT
          source.id as definition_id,
          dep_def.id as dependency_id
        FROM definitions source
        JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
        JOIN symbols s ON u.symbol_id = s.id
        JOIN definitions dep_def ON s.definition_id = dep_def.id
        JOIN files source_f ON source.file_id = source_f.id
        WHERE dep_def.id != source.id
          AND (
            s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
            OR s.file_id = source.file_id
          )
      ),
      unmet AS (
        SELECT DISTINCT definition_id
        FROM definition_deps
        WHERE dependency_id NOT IN (SELECT definition_id FROM understood)
      )
      SELECT
        COUNT(*) as totalReady,
        (SELECT COUNT(*) FROM definitions d2
         JOIN files f2 ON d2.file_id = f2.id
         WHERE d2.id NOT IN (SELECT definition_id FROM understood)
           ${filterConditions.replace(/d\./g, 'd2.').replace(/f\./g, 'f2.')}
        ) as totalRemaining
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.id NOT IN (SELECT definition_id FROM understood)
        AND d.id NOT IN (SELECT definition_id FROM unmet)
        ${filterConditions}
    `;

    // Params: aspect, then filterParams for subquery, then filterParams for main WHERE
    const countParams: (string | number)[] = [aspect, ...filterParams, ...filterParams];
    const countStmt = this.db.prepare(countSql);
    const countResult = countStmt.get(...countParams) as { totalReady: number; totalRemaining: number };

    return {
      symbols,
      totalReady: countResult.totalReady,
      remaining: countResult.totalRemaining - countResult.totalReady,
    };
  }

  close(): void {
    this.db.close();
  }
}
