import Database from 'better-sqlite3';
import type { Definition } from '../parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../parser/reference-extractor.js';

// Re-export all types and utilities from schema for backward compatibility
export {
  type FileInsert,
  type CallsiteResult,
  type DependencyInfo,
  type ReadySymbolInfo,
  type DependencyWithMetadata,
  type IncomingDependency,
  type RelationshipType,
  type RelationshipAnnotation,
  type RelationshipWithDetails,
  type Domain,
  type DomainWithCount,
  type EnhancedRelationshipContext,
  type ModuleLayer,
  type Module,
  type ModuleMember,
  type ModuleWithMembers,
  type CallGraphEdge,
  type Flow,
  type FlowStep,
  type FlowWithSteps,
  type IIndexWriter,
  SCHEMA,
  computeHash,
} from './schema.js';

// Import types for internal use
import {
  type FileInsert,
  type CallsiteResult,
  type DependencyInfo,
  type ReadySymbolInfo,
  type DependencyWithMetadata,
  type RelationshipType,
  type RelationshipAnnotation,
  type RelationshipWithDetails,
  type Domain,
  type DomainWithCount,
  type EnhancedRelationshipContext,
  type ModuleLayer,
  type Module,
  type ModuleWithMembers,
  type CallGraphEdge,
  type Flow,
  type FlowWithSteps,
  type IIndexWriter,
  SCHEMA,
} from './schema.js';

export class IndexDatabase implements IIndexWriter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  initialize(): void {
    // Drop all tables if they exist and recreate
    this.db.exec(`
      DROP TABLE IF EXISTS domains;
      DROP TABLE IF EXISTS relationship_annotations;
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
    endLine: number;
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
        end_line as endLine,
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
      endLine: number;
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
   * Get incoming dependencies - symbols that use this definition.
   * This finds all definitions that have usages pointing to this definition.
   */
  getIncomingDependencies(definitionId: number, limit: number = 5): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT
        caller.id,
        caller.name,
        caller.kind,
        f.path as filePath,
        caller.line
      FROM definitions caller
      JOIN files f ON caller.file_id = f.id
      JOIN usages u ON u.line >= caller.line AND u.line <= caller.end_line
      JOIN symbols s ON u.symbol_id = s.id
      WHERE s.definition_id = ?
        AND caller.id != ?
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = caller.file_id)
          OR s.file_id = caller.file_id
        )
      ORDER BY f.path, caller.line
      LIMIT ?
    `);
    return stmt.all(definitionId, definitionId, limit) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
    }>;
  }

  /**
   * Get count of incoming dependencies - how many symbols use this definition.
   */
  getIncomingDependencyCount(definitionId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(DISTINCT caller.id) as count
      FROM definitions caller
      JOIN usages u ON u.line >= caller.line AND u.line <= caller.end_line
      JOIN symbols s ON u.symbol_id = s.id
      WHERE s.definition_id = ?
        AND caller.id != ?
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = caller.file_id)
          OR s.file_id = caller.file_id
        )
    `);
    const row = stmt.get(definitionId, definitionId) as { count: number };
    return row.count;
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

  // ============================================
  // Relationship annotation methods
  // ============================================

  /**
   * Ensure the relationship_type column exists (for existing databases).
   * Called automatically by relationship methods to support legacy databases.
   */
  private ensureRelationshipTypeColumn(): void {
    try {
      // Check if column exists by trying to select it
      this.db.prepare('SELECT relationship_type FROM relationship_annotations LIMIT 1').get();
    } catch {
      // Column doesn't exist, add it
      this.db.exec(`ALTER TABLE relationship_annotations ADD COLUMN relationship_type TEXT NOT NULL DEFAULT 'uses'`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationship_annotations_type ON relationship_annotations(relationship_type)`);
    }
  }

  /**
   * Set (insert or update) a semantic annotation for a relationship between two definitions.
   */
  setRelationshipAnnotation(
    fromDefinitionId: number,
    toDefinitionId: number,
    semantic: string,
    relationshipType: RelationshipType = 'uses'
  ): void {
    this.ensureRelationshipTypeColumn();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO relationship_annotations (from_definition_id, to_definition_id, relationship_type, semantic, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(fromDefinitionId, toDefinitionId, relationshipType, semantic);
  }

  /**
   * Get a relationship annotation between two definitions.
   */
  getRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number): RelationshipAnnotation | null {
    this.ensureRelationshipTypeColumn();
    const stmt = this.db.prepare(`
      SELECT id, from_definition_id as fromDefinitionId, to_definition_id as toDefinitionId,
             relationship_type as relationshipType, semantic, created_at as createdAt
      FROM relationship_annotations
      WHERE from_definition_id = ? AND to_definition_id = ?
    `);
    const row = stmt.get(fromDefinitionId, toDefinitionId) as RelationshipAnnotation | undefined;
    return row ?? null;
  }

  /**
   * Remove a relationship annotation.
   */
  removeRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM relationship_annotations
      WHERE from_definition_id = ? AND to_definition_id = ?
    `);
    const result = stmt.run(fromDefinitionId, toDefinitionId);
    return result.changes > 0;
  }

  /**
   * Get all relationship annotations from a specific definition.
   */
  getRelationshipsFrom(fromDefinitionId: number): RelationshipWithDetails[] {
    this.ensureRelationshipTypeColumn();
    const stmt = this.db.prepare(`
      SELECT
        ra.id,
        ra.from_definition_id as fromDefinitionId,
        fd.name as fromName,
        fd.kind as fromKind,
        ff.path as fromFilePath,
        fd.line as fromLine,
        ra.to_definition_id as toDefinitionId,
        td.name as toName,
        td.kind as toKind,
        tf.path as toFilePath,
        td.line as toLine,
        ra.relationship_type as relationshipType,
        ra.semantic
      FROM relationship_annotations ra
      JOIN definitions fd ON ra.from_definition_id = fd.id
      JOIN files ff ON fd.file_id = ff.id
      JOIN definitions td ON ra.to_definition_id = td.id
      JOIN files tf ON td.file_id = tf.id
      WHERE ra.from_definition_id = ?
      ORDER BY td.name
    `);
    return stmt.all(fromDefinitionId) as RelationshipWithDetails[];
  }

  /**
   * Get all relationship annotations to a specific definition.
   */
  getRelationshipsTo(toDefinitionId: number): RelationshipWithDetails[] {
    this.ensureRelationshipTypeColumn();
    const stmt = this.db.prepare(`
      SELECT
        ra.id,
        ra.from_definition_id as fromDefinitionId,
        fd.name as fromName,
        fd.kind as fromKind,
        ff.path as fromFilePath,
        fd.line as fromLine,
        ra.to_definition_id as toDefinitionId,
        td.name as toName,
        td.kind as toKind,
        tf.path as toFilePath,
        td.line as toLine,
        ra.relationship_type as relationshipType,
        ra.semantic
      FROM relationship_annotations ra
      JOIN definitions fd ON ra.from_definition_id = fd.id
      JOIN files ff ON fd.file_id = ff.id
      JOIN definitions td ON ra.to_definition_id = td.id
      JOIN files tf ON td.file_id = tf.id
      WHERE ra.to_definition_id = ?
      ORDER BY fd.name
    `);
    return stmt.all(toDefinitionId) as RelationshipWithDetails[];
  }

  /**
   * Get all relationship annotations.
   */
  getAllRelationshipAnnotations(options?: { limit?: number }): RelationshipWithDetails[] {
    this.ensureRelationshipTypeColumn();
    const limit = options?.limit ?? 100;
    const stmt = this.db.prepare(`
      SELECT
        ra.id,
        ra.from_definition_id as fromDefinitionId,
        fd.name as fromName,
        fd.kind as fromKind,
        ff.path as fromFilePath,
        fd.line as fromLine,
        ra.to_definition_id as toDefinitionId,
        td.name as toName,
        td.kind as toKind,
        tf.path as toFilePath,
        td.line as toLine,
        ra.relationship_type as relationshipType,
        ra.semantic
      FROM relationship_annotations ra
      JOIN definitions fd ON ra.from_definition_id = fd.id
      JOIN files ff ON fd.file_id = ff.id
      JOIN definitions td ON ra.to_definition_id = td.id
      JOIN files tf ON td.file_id = tf.id
      ORDER BY ff.path, fd.line
      LIMIT ?
    `);
    return stmt.all(limit) as RelationshipWithDetails[];
  }

  /**
   * Get count of relationship annotations.
   */
  getRelationshipAnnotationCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM relationship_annotations');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get unannotated inheritance relationships (extends/implements with placeholder semantic).
   * These are relationships created by createInheritanceRelationships() that need LLM annotation.
   */
  getUnannotatedInheritanceRelationships(limit: number = 50): Array<{
    id: number;
    fromId: number;
    fromName: string;
    fromKind: string;
    fromFilePath: string;
    toId: number;
    toName: string;
    toKind: string;
    toFilePath: string;
    relationshipType: 'extends' | 'implements';
  }> {
    this.ensureRelationshipTypeColumn();
    const stmt = this.db.prepare(`
      SELECT
        ra.id,
        ra.from_definition_id as fromId,
        fd.name as fromName,
        fd.kind as fromKind,
        ff.path as fromFilePath,
        ra.to_definition_id as toId,
        td.name as toName,
        td.kind as toKind,
        tf.path as toFilePath,
        ra.relationship_type as relationshipType
      FROM relationship_annotations ra
      JOIN definitions fd ON ra.from_definition_id = fd.id
      JOIN files ff ON fd.file_id = ff.id
      JOIN definitions td ON ra.to_definition_id = td.id
      JOIN files tf ON td.file_id = tf.id
      WHERE ra.semantic = 'PENDING_LLM_ANNOTATION'
        AND ra.relationship_type IN ('extends', 'implements')
      ORDER BY ff.path, fd.line
      LIMIT ?
    `);
    return stmt.all(limit) as Array<{
      id: number;
      fromId: number;
      fromName: string;
      fromKind: string;
      fromFilePath: string;
      toId: number;
      toName: string;
      toKind: string;
      toFilePath: string;
      relationshipType: 'extends' | 'implements';
    }>;
  }

  /**
   * Get count of unannotated inheritance relationships.
   */
  getUnannotatedInheritanceRelationshipCount(): number {
    this.ensureRelationshipTypeColumn();
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM relationship_annotations
      WHERE semantic = 'PENDING_LLM_ANNOTATION'
        AND relationship_type IN ('extends', 'implements')
    `);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get definitions that have calls to other definitions but no annotation.
   * Finds "call" edges without semantic annotations.
   */
  getUnannotatedRelationships(options?: { limit?: number; fromDefinitionId?: number }): Array<{
    fromDefinitionId: number;
    fromName: string;
    fromKind: string;
    fromFilePath: string;
    fromLine: number;
    toDefinitionId: number;
    toName: string;
    toKind: string;
    toFilePath: string;
    toLine: number;
  }> {
    const limit = options?.limit ?? 20;

    let whereClause = '';
    const params: (string | number)[] = [];

    if (options?.fromDefinitionId !== undefined) {
      whereClause = 'WHERE source.id = ?';
      params.push(options.fromDefinitionId);
    }

    const sql = `
      SELECT DISTINCT
        source.id as fromDefinitionId,
        source.name as fromName,
        source.kind as fromKind,
        sf.path as fromFilePath,
        source.line as fromLine,
        dep_def.id as toDefinitionId,
        dep_def.name as toName,
        dep_def.kind as toKind,
        df.path as toFilePath,
        dep_def.line as toLine
      FROM definitions source
      JOIN files sf ON source.file_id = sf.id
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files df ON dep_def.file_id = df.id
      LEFT JOIN relationship_annotations ra
        ON ra.from_definition_id = source.id AND ra.to_definition_id = dep_def.id
      ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} dep_def.id != source.id
        AND ra.id IS NULL
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
      ORDER BY sf.path, source.line
      LIMIT ?
    `;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Array<{
      fromDefinitionId: number;
      fromName: string;
      fromKind: string;
      fromFilePath: string;
      fromLine: number;
      toDefinitionId: number;
      toName: string;
      toKind: string;
      toFilePath: string;
      toLine: number;
    }>;
  }

  /**
   * Get symbols that have a specific domain tag.
   * Domain is stored as a JSON array in the 'domain' metadata key.
   */
  getSymbolsByDomain(domain: string): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    domains: string[];
    purpose: string | null;
  }> {
    // Use LIKE with JSON pattern to find domain in the array
    const pattern = `%"${domain}"%`;
    const stmt = this.db.prepare(`
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        dm_domain.value as domains,
        dm_purpose.value as purpose
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      JOIN definition_metadata dm_domain ON dm_domain.definition_id = d.id AND dm_domain.key = 'domain'
      LEFT JOIN definition_metadata dm_purpose ON dm_purpose.definition_id = d.id AND dm_purpose.key = 'purpose'
      WHERE dm_domain.value LIKE ?
      ORDER BY f.path, d.line
    `);
    const rows = stmt.all(pattern) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      domains: string;
      purpose: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.filePath,
      line: row.line,
      domains: JSON.parse(row.domains) as string[],
      purpose: row.purpose,
    }));
  }

  /**
   * Get all unique domains used across all symbols.
   */
  getAllDomains(): string[] {
    const stmt = this.db.prepare(`
      SELECT value FROM definition_metadata WHERE key = 'domain'
    `);
    const rows = stmt.all() as Array<{ value: string }>;

    const domains = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as string[];
        for (const d of parsed) {
          domains.add(d);
        }
      } catch {
        // Skip invalid JSON
      }
    }
    return Array.from(domains).sort();
  }

  /**
   * Get symbols filtered by purity (pure = no side effects).
   * Returns symbols where 'pure' metadata matches the specified value.
   */
  getSymbolsByPurity(isPure: boolean): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    purpose: string | null;
  }> {
    const pureValue = isPure ? 'true' : 'false';
    const stmt = this.db.prepare(`
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        dm_purpose.value as purpose
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      JOIN definition_metadata dm_pure ON dm_pure.definition_id = d.id AND dm_pure.key = 'pure'
      LEFT JOIN definition_metadata dm_purpose ON dm_purpose.definition_id = d.id AND dm_purpose.key = 'purpose'
      WHERE dm_pure.value = ?
      ORDER BY f.path, d.line
    `);
    return stmt.all(pureValue) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      purpose: string | null;
    }>;
  }

  // ============================================
  // Domain registry methods
  // ============================================

  /**
   * Ensure the domains table exists (for existing databases).
   * Called automatically by domain methods to support legacy databases.
   */
  private ensureDomainsTable(): void {
    const tableExists = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='domains'
    `).get();

    if (!tableExists) {
      this.db.exec(`
        CREATE TABLE domains (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_domains_name ON domains(name);
      `);
    }
  }

  /**
   * Add a new domain to the registry.
   * @returns The domain ID if created, or null if already exists.
   */
  addDomain(name: string, description?: string): number | null {
    this.ensureDomainsTable();
    try {
      const stmt = this.db.prepare(`
        INSERT INTO domains (name, description) VALUES (?, ?)
      `);
      const result = stmt.run(name, description ?? null);
      return result.lastInsertRowid as number;
    } catch (error) {
      // Domain already exists (UNIQUE constraint)
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get a domain by name.
   */
  getDomain(name: string): Domain | null {
    this.ensureDomainsTable();
    const stmt = this.db.prepare(`
      SELECT id, name, description, created_at as createdAt
      FROM domains WHERE name = ?
    `);
    const row = stmt.get(name) as Domain | undefined;
    return row ?? null;
  }

  /**
   * Get all domains from the registry.
   */
  getDomainsFromRegistry(): Domain[] {
    this.ensureDomainsTable();
    const stmt = this.db.prepare(`
      SELECT id, name, description, created_at as createdAt
      FROM domains ORDER BY name
    `);
    return stmt.all() as Domain[];
  }

  /**
   * Get all domains with their symbol counts.
   */
  getDomainsWithCounts(): DomainWithCount[] {
    this.ensureDomainsTable();

    // Get all registered domains
    const domains = this.getDomainsFromRegistry();

    // Get all domain values from metadata
    const metadataStmt = this.db.prepare(`
      SELECT value FROM definition_metadata WHERE key = 'domain'
    `);
    const rows = metadataStmt.all() as Array<{ value: string }>;

    // Count symbols per domain
    const domainCounts = new Map<string, number>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as string[];
        for (const d of parsed) {
          domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
        }
      } catch {
        // Skip invalid JSON
      }
    }

    return domains.map(domain => ({
      ...domain,
      symbolCount: domainCounts.get(domain.name) || 0,
    }));
  }

  /**
   * Update a domain's description.
   */
  updateDomainDescription(name: string, description: string): boolean {
    this.ensureDomainsTable();
    const stmt = this.db.prepare(`
      UPDATE domains SET description = ? WHERE name = ?
    `);
    const result = stmt.run(description, name);
    return result.changes > 0;
  }

  /**
   * Rename a domain in both the registry and all symbol metadata.
   * @returns Number of symbols updated.
   */
  renameDomain(oldName: string, newName: string): { updated: boolean; symbolsUpdated: number } {
    this.ensureDomainsTable();

    // Update registry
    const updateRegistry = this.db.prepare(`
      UPDATE domains SET name = ? WHERE name = ?
    `);
    const registryResult = updateRegistry.run(newName, oldName);

    // Update all symbol metadata
    const getMetadata = this.db.prepare(`
      SELECT id, definition_id, value FROM definition_metadata WHERE key = 'domain'
    `);
    const rows = getMetadata.all() as Array<{ id: number; definition_id: number; value: string }>;

    let symbolsUpdated = 0;
    const updateMetadata = this.db.prepare(`
      UPDATE definition_metadata SET value = ? WHERE id = ?
    `);

    for (const row of rows) {
      try {
        const domains = JSON.parse(row.value) as string[];
        const idx = domains.indexOf(oldName);
        if (idx !== -1) {
          domains[idx] = newName;
          updateMetadata.run(JSON.stringify(domains), row.id);
          symbolsUpdated++;
        }
      } catch {
        // Skip invalid JSON
      }
    }

    return {
      updated: registryResult.changes > 0,
      symbolsUpdated,
    };
  }

  /**
   * Merge one domain into another. The source domain is removed from all symbols
   * and replaced with the target domain.
   * @returns Number of symbols updated.
   */
  mergeDomains(fromName: string, intoName: string): { symbolsUpdated: number; registryRemoved: boolean } {
    this.ensureDomainsTable();

    // Update all symbol metadata
    const getMetadata = this.db.prepare(`
      SELECT id, definition_id, value FROM definition_metadata WHERE key = 'domain'
    `);
    const rows = getMetadata.all() as Array<{ id: number; definition_id: number; value: string }>;

    let symbolsUpdated = 0;
    const updateMetadata = this.db.prepare(`
      UPDATE definition_metadata SET value = ? WHERE id = ?
    `);

    for (const row of rows) {
      try {
        const domains = JSON.parse(row.value) as string[];
        const fromIdx = domains.indexOf(fromName);
        if (fromIdx !== -1) {
          // Remove the old domain
          domains.splice(fromIdx, 1);
          // Add the new domain if not already present
          if (!domains.includes(intoName)) {
            domains.push(intoName);
          }
          updateMetadata.run(JSON.stringify(domains.sort()), row.id);
          symbolsUpdated++;
        }
      } catch {
        // Skip invalid JSON
      }
    }

    // Remove the source domain from registry
    const removeRegistry = this.db.prepare(`
      DELETE FROM domains WHERE name = ?
    `);
    const registryResult = removeRegistry.run(fromName);

    return {
      symbolsUpdated,
      registryRemoved: registryResult.changes > 0,
    };
  }

  /**
   * Remove a domain from the registry.
   * @param force If true, removes even if symbols still use this domain.
   * @returns Object with removed status and count of symbols still using the domain.
   */
  removeDomain(name: string, force = false): { removed: boolean; symbolsUsingDomain: number } {
    this.ensureDomainsTable();

    // Count symbols using this domain
    const symbolsUsingDomain = this.getSymbolsByDomain(name).length;

    if (symbolsUsingDomain > 0 && !force) {
      return { removed: false, symbolsUsingDomain };
    }

    // Remove from registry
    const stmt = this.db.prepare(`
      DELETE FROM domains WHERE name = ?
    `);
    const result = stmt.run(name);

    return {
      removed: result.changes > 0,
      symbolsUsingDomain,
    };
  }

  /**
   * Sync all domains currently in use to the registry.
   * Registers any domain found in symbol metadata that isn't already registered.
   * @returns Array of newly registered domain names.
   */
  syncDomainsFromMetadata(): string[] {
    this.ensureDomainsTable();

    // Get all unique domains from metadata
    const domainsInUse = this.getAllDomains();

    // Get registered domains
    const registeredDomains = new Set(this.getDomainsFromRegistry().map(d => d.name));

    // Register any missing domains
    const newlyRegistered: string[] = [];
    for (const domain of domainsInUse) {
      if (!registeredDomains.has(domain)) {
        const id = this.addDomain(domain);
        if (id !== null) {
          newlyRegistered.push(domain);
        }
      }
    }

    return newlyRegistered;
  }

  /**
   * Get all unregistered domains currently in use.
   */
  getUnregisteredDomains(): string[] {
    this.ensureDomainsTable();
    const domainsInUse = this.getAllDomains();
    const registeredDomains = new Set(this.getDomainsFromRegistry().map(d => d.name));
    return domainsInUse.filter(d => !registeredDomains.has(d));
  }

  /**
   * Check if a domain is registered.
   */
  isDomainRegistered(name: string): boolean {
    this.ensureDomainsTable();
    const stmt = this.db.prepare(`
      SELECT 1 FROM domains WHERE name = ?
    `);
    return stmt.get(name) !== undefined;
  }

  // ============================================
  // Enhanced relationship methods
  // ============================================

  /**
   * Get the next relationship(s) that need annotation with rich context.
   * Returns relationships ordered by: symbols with most dependencies first,
   * then by file path and line number.
   */
  getNextRelationshipToAnnotate(options?: {
    limit?: number;
    fromDefinitionId?: number;
  }): EnhancedRelationshipContext[] {
    const limit = options?.limit ?? 1;

    let whereClause = '';
    const params: (string | number)[] = [];

    if (options?.fromDefinitionId !== undefined) {
      whereClause = 'WHERE source.id = ?';
      params.push(options.fromDefinitionId);
    }

    // Get unannotated relationships with basic info
    const sql = `
      SELECT DISTINCT
        source.id as fromDefinitionId,
        source.name as fromName,
        source.kind as fromKind,
        sf.path as fromFilePath,
        source.line as fromLine,
        source.end_line as fromEndLine,
        dep_def.id as toDefinitionId,
        dep_def.name as toName,
        dep_def.kind as toKind,
        df.path as toFilePath,
        dep_def.line as toLine,
        dep_def.end_line as toEndLine,
        u.line as usageLine
      FROM definitions source
      JOIN files sf ON source.file_id = sf.id
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files df ON dep_def.file_id = df.id
      LEFT JOIN relationship_annotations ra
        ON ra.from_definition_id = source.id AND ra.to_definition_id = dep_def.id
      ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} dep_def.id != source.id
        AND ra.id IS NULL
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
      ORDER BY sf.path, source.line
      LIMIT ?
    `;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      fromDefinitionId: number;
      fromName: string;
      fromKind: string;
      fromFilePath: string;
      fromLine: number;
      fromEndLine: number;
      toDefinitionId: number;
      toName: string;
      toKind: string;
      toFilePath: string;
      toLine: number;
      toEndLine: number;
      usageLine: number;
    }>;

    // Enhance each relationship with metadata and context
    const results: EnhancedRelationshipContext[] = [];

    for (const row of rows) {
      // Get metadata for both symbols
      const fromMeta = this.getDefinitionMetadata(row.fromDefinitionId);
      const toMeta = this.getDefinitionMetadata(row.toDefinitionId);

      // Parse domains
      let fromDomains: string[] | null = null;
      let toDomains: string[] | null = null;
      try {
        if (fromMeta['domain']) {
          fromDomains = JSON.parse(fromMeta['domain']) as string[];
        }
      } catch { /* ignore */ }
      try {
        if (toMeta['domain']) {
          toDomains = JSON.parse(toMeta['domain']) as string[];
        }
      } catch { /* ignore */ }

      // Calculate shared domains
      const sharedDomains: string[] = [];
      if (fromDomains && toDomains) {
        for (const d of fromDomains) {
          if (toDomains.includes(d)) {
            sharedDomains.push(d);
          }
        }
      }

      // Get other relationships from source (what else does source call?)
      const otherFromRels = this.getDefinitionDependencies(row.fromDefinitionId)
        .filter(d => d.dependencyId !== row.toDefinitionId)
        .map(d => d.name);

      // Get other relationships to target (what else calls target?)
      const otherToRelsStmt = this.db.prepare(`
        SELECT DISTINCT source.name
        FROM definitions source
        JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
        JOIN symbols s ON u.symbol_id = s.id
        WHERE s.definition_id = ?
          AND source.id != ?
          AND (
            s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
            OR s.file_id = source.file_id
          )
        ORDER BY source.name
        LIMIT 10
      `);
      const otherToRels = otherToRelsStmt.all(row.toDefinitionId, row.fromDefinitionId) as Array<{ name: string }>;

      results.push({
        fromDefinitionId: row.fromDefinitionId,
        fromName: row.fromName,
        fromKind: row.fromKind,
        fromFilePath: row.fromFilePath,
        fromLine: row.fromLine,
        fromEndLine: row.fromEndLine,
        toDefinitionId: row.toDefinitionId,
        toName: row.toName,
        toKind: row.toKind,
        toFilePath: row.toFilePath,
        toLine: row.toLine,
        toEndLine: row.toEndLine,
        fromPurpose: fromMeta['purpose'] ?? null,
        fromDomains,
        fromRole: fromMeta['role'] ?? null,
        fromPure: fromMeta['pure'] ? fromMeta['pure'] === 'true' : null,
        toPurpose: toMeta['purpose'] ?? null,
        toDomains,
        toRole: toMeta['role'] ?? null,
        toPure: toMeta['pure'] ? toMeta['pure'] === 'true' : null,
        relationshipType: 'call', // Default to call for now
        usageLine: row.usageLine,
        otherFromRelationships: otherFromRels.slice(0, 10),
        otherToRelationships: otherToRels.map(r => r.name),
        sharedDomains,
      });
    }

    return results;
  }

  /**
   * Get count of unannotated relationships.
   */
  getUnannotatedRelationshipCount(fromDefinitionId?: number): number {
    let whereClause = '';
    const params: (string | number)[] = [];

    if (fromDefinitionId !== undefined) {
      whereClause = 'WHERE source.id = ?';
      params.push(fromDefinitionId);
    }

    const sql = `
      SELECT COUNT(DISTINCT source.id || '-' || dep_def.id) as count
      FROM definitions source
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      LEFT JOIN relationship_annotations ra
        ON ra.from_definition_id = source.id AND ra.to_definition_id = dep_def.id
      ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} dep_def.id != source.id
        AND ra.id IS NULL
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
    `;

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }

  /**
   * Create relationship annotations for inheritance (extends/implements).
   * Called after all definitions are inserted during indexing.
   * Creates automatic "extends" and "implements" relationships.
   * @returns Statistics about created relationships.
   */
  createInheritanceRelationships(): {
    extendsCreated: number;
    implementsCreated: number;
    notFound: number;
  } {
    let extendsCreated = 0;
    let implementsCreated = 0;
    let notFound = 0;

    // Get all definitions that have extends or implements
    const defsWithInheritance = this.db.prepare(`
      SELECT id, name, extends_name, implements_names, extends_interfaces
      FROM definitions
      WHERE extends_name IS NOT NULL
         OR implements_names IS NOT NULL
         OR extends_interfaces IS NOT NULL
    `).all() as Array<{
      id: number;
      name: string;
      extends_name: string | null;
      implements_names: string | null;
      extends_interfaces: string | null;
    }>;

    // Build a map of name -> definition IDs for lookup
    // Note: Multiple definitions can have the same name (in different files)
    const nameToIds = new Map<string, number[]>();
    const allDefs = this.db.prepare('SELECT id, name FROM definitions').all() as Array<{
      id: number;
      name: string;
    }>;
    for (const def of allDefs) {
      const existing = nameToIds.get(def.name) || [];
      existing.push(def.id);
      nameToIds.set(def.name, existing);
    }

    // Helper to find best matching definition for a type name
    const findTargetDefinition = (typeName: string): number | null => {
      // Handle generic type syntax: Partial<Foo> -> Foo, Omit<User, 'x'> -> User
      let baseName = typeName;
      const genericMatch = typeName.match(/^(\w+)<.*>$/);
      if (genericMatch) {
        baseName = genericMatch[1];
      }

      const ids = nameToIds.get(baseName);
      if (!ids || ids.length === 0) return null;
      // If multiple matches, take the first one (could be improved with file context)
      return ids[0];
    };

    // Process each definition with inheritance
    for (const def of defsWithInheritance) {
      // Handle class extends
      if (def.extends_name) {
        const targetId = findTargetDefinition(def.extends_name);
        if (targetId !== null) {
          // Use placeholder semantic for LLM to annotate later
          this.setRelationshipAnnotation(def.id, targetId, 'PENDING_LLM_ANNOTATION', 'extends');
          extendsCreated++;
        } else {
          notFound++;
        }
      }

      // Handle class implements
      if (def.implements_names) {
        try {
          const interfaces = JSON.parse(def.implements_names) as string[];
          for (const iface of interfaces) {
            const targetId = findTargetDefinition(iface);
            if (targetId !== null) {
              // Use placeholder semantic for LLM to annotate later
              this.setRelationshipAnnotation(def.id, targetId, 'PENDING_LLM_ANNOTATION', 'implements');
              implementsCreated++;
            } else {
              notFound++;
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }

      // Handle interface extends
      if (def.extends_interfaces) {
        try {
          const parents = JSON.parse(def.extends_interfaces) as string[];
          for (const parent of parents) {
            const targetId = findTargetDefinition(parent);
            if (targetId !== null) {
              // Use placeholder semantic for LLM to annotate later
              this.setRelationshipAnnotation(def.id, targetId, 'PENDING_LLM_ANNOTATION', 'extends');
              extendsCreated++;
            } else {
              notFound++;
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    return { extendsCreated, implementsCreated, notFound };
  }

  /**
   * Get all symbols that don't have a specific aspect set, regardless of dependency status.
   * Used with --force flag to annotate all remaining symbols.
   */
  getAllUnannotatedSymbols(
    aspect: string,
    options?: { limit?: number; kind?: string; filePattern?: string; excludePattern?: string }
  ): { symbols: ReadySymbolInfo[]; total: number } {
    const limit = options?.limit ?? 20;

    // Build filter conditions
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
    if (options?.excludePattern) {
      filterConditions += ' AND f.path NOT GLOB ?';
      filterParams.push(options.excludePattern);
    }

    // Get unannotated symbols (no dependency check)
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
        ${filterConditions}
      ORDER BY dependencyCount ASC, f.path, d.line
      LIMIT ?
    `;

    const params: (string | number)[] = [aspect, ...filterParams, limit];
    const stmt = this.db.prepare(sql);
    const symbols = stmt.all(...params) as ReadySymbolInfo[];

    // Get total count
    const countSql = `
      WITH understood AS (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      )
      SELECT COUNT(*) as total
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.id NOT IN (SELECT definition_id FROM understood)
        ${filterConditions}
    `;
    const countParams: (string | number)[] = [aspect, ...filterParams];
    const countStmt = this.db.prepare(countSql);
    const countResult = countStmt.get(...countParams) as { total: number };

    return {
      symbols,
      total: countResult.total,
    };
  }

  // ============================================
  // Module detection methods
  // ============================================

  /**
   * Ensure the modules and module_members tables exist (for existing databases).
   * Called automatically by module methods to support legacy databases.
   */
  private ensureModulesTables(): void {
    const tableExists = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='modules'
    `).get();

    if (!tableExists) {
      this.db.exec(`
        CREATE TABLE modules (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          layer TEXT,
          subsystem TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE module_members (
          module_id INTEGER NOT NULL,
          definition_id INTEGER NOT NULL,
          cohesion REAL,
          PRIMARY KEY (module_id, definition_id),
          FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
          FOREIGN KEY (definition_id) REFERENCES definitions(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_module_members_def ON module_members(definition_id);
      `);
    }
  }

  /**
   * Extract the call graph from the database.
   * Returns edges weighted by number of call sites between definitions.
   */
  getCallGraph(): CallGraphEdge[] {
    const stmt = this.db.prepare(`
      SELECT
        caller.id as from_id,
        s.definition_id as to_id,
        COUNT(*) as weight
      FROM definitions caller
      JOIN files f ON caller.file_id = f.id
      JOIN symbols s ON s.file_id = f.id AND s.definition_id IS NOT NULL
      JOIN usages u ON u.symbol_id = s.id
      WHERE u.context IN ('call_expression', 'new_expression')
        AND caller.line <= u.line AND u.line <= caller.end_line
        AND s.definition_id != caller.id
      GROUP BY caller.id, s.definition_id
      UNION ALL
      SELECT
        caller.id as from_id,
        s.definition_id as to_id,
        COUNT(*) as weight
      FROM definitions caller
      JOIN files f ON caller.file_id = f.id
      JOIN imports i ON i.from_file_id = f.id
      JOIN symbols s ON s.reference_id = i.id AND s.definition_id IS NOT NULL
      JOIN usages u ON u.symbol_id = s.id
      WHERE u.context IN ('call_expression', 'new_expression')
        AND caller.line <= u.line AND u.line <= caller.end_line
        AND s.definition_id != caller.id
      GROUP BY caller.id, s.definition_id
    `);

    const rows = stmt.all() as Array<{ from_id: number; to_id: number; weight: number }>;

    // Aggregate duplicate edges (from the UNION)
    const edgeMap = new Map<string, CallGraphEdge>();
    for (const row of rows) {
      const key = `${row.from_id}-${row.to_id}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += row.weight;
      } else {
        edgeMap.set(key, { fromId: row.from_id, toId: row.to_id, weight: row.weight });
      }
    }

    return Array.from(edgeMap.values());
  }

  /**
   * Insert a new module.
   */
  insertModule(
    name: string,
    options?: {
      description?: string;
      layer?: ModuleLayer;
      subsystem?: string;
    }
  ): number {
    this.ensureModulesTables();
    const stmt = this.db.prepare(`
      INSERT INTO modules (name, description, layer, subsystem)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(
      name,
      options?.description ?? null,
      options?.layer ?? null,
      options?.subsystem ?? null
    );
    return result.lastInsertRowid as number;
  }

  /**
   * Add a member to a module.
   */
  addModuleMember(moduleId: number, definitionId: number, cohesion?: number): void {
    this.ensureModulesTables();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO module_members (module_id, definition_id, cohesion)
      VALUES (?, ?, ?)
    `);
    stmt.run(moduleId, definitionId, cohesion ?? null);
  }

  /**
   * Get all modules.
   */
  getModules(): Module[] {
    this.ensureModulesTables();
    const stmt = this.db.prepare(`
      SELECT
        id,
        name,
        description,
        layer,
        subsystem,
        created_at as createdAt
      FROM modules
      ORDER BY name
    `);
    return stmt.all() as Module[];
  }

  /**
   * Get a module by ID with all its members.
   */
  getModuleWithMembers(moduleId: number): ModuleWithMembers | null {
    this.ensureModulesTables();

    const moduleStmt = this.db.prepare(`
      SELECT
        id,
        name,
        description,
        layer,
        subsystem,
        created_at as createdAt
      FROM modules
      WHERE id = ?
    `);
    const module = moduleStmt.get(moduleId) as Module | undefined;
    if (!module) return null;

    const membersStmt = this.db.prepare(`
      SELECT
        mm.definition_id as definitionId,
        d.name,
        d.kind,
        f.path as filePath,
        mm.cohesion
      FROM module_members mm
      JOIN definitions d ON mm.definition_id = d.id
      JOIN files f ON d.file_id = f.id
      WHERE mm.module_id = ?
      ORDER BY f.path, d.line
    `);
    const members = membersStmt.all(moduleId) as Array<{
      definitionId: number;
      name: string;
      kind: string;
      filePath: string;
      cohesion: number | null;
    }>;

    return { ...module, members };
  }

  /**
   * Get all modules with their members.
   */
  getAllModulesWithMembers(): ModuleWithMembers[] {
    this.ensureModulesTables();

    const modules = this.getModules();
    return modules.map(m => {
      const withMembers = this.getModuleWithMembers(m.id);
      return withMembers!;
    });
  }

  /**
   * Get module membership for a definition.
   */
  getDefinitionModule(definitionId: number): { module: Module; cohesion: number | null } | null {
    this.ensureModulesTables();
    const stmt = this.db.prepare(`
      SELECT
        m.id,
        m.name,
        m.description,
        m.layer,
        m.subsystem,
        m.created_at as createdAt,
        mm.cohesion
      FROM module_members mm
      JOIN modules m ON mm.module_id = m.id
      WHERE mm.definition_id = ?
    `);
    const row = stmt.get(definitionId) as (Module & { cohesion: number | null }) | undefined;
    if (!row) return null;

    return {
      module: {
        id: row.id,
        name: row.name,
        description: row.description,
        layer: row.layer,
        subsystem: row.subsystem,
        createdAt: row.createdAt,
      },
      cohesion: row.cohesion,
    };
  }

  /**
   * Get count of modules.
   */
  getModuleCount(): number {
    this.ensureModulesTables();
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM modules');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Update a module's metadata.
   */
  updateModule(
    moduleId: number,
    updates: {
      name?: string;
      description?: string;
      layer?: ModuleLayer;
      subsystem?: string;
    }
  ): boolean {
    this.ensureModulesTables();

    const sets: string[] = [];
    const params: (string | null)[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      params.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description);
    }
    if (updates.layer !== undefined) {
      sets.push('layer = ?');
      params.push(updates.layer);
    }
    if (updates.subsystem !== undefined) {
      sets.push('subsystem = ?');
      params.push(updates.subsystem);
    }

    if (sets.length === 0) return false;

    params.push(String(moduleId));
    const stmt = this.db.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Delete all modules and their memberships.
   */
  clearModules(): number {
    this.ensureModulesTables();
    const stmt = this.db.prepare('DELETE FROM modules');
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Get module statistics.
   */
  getModuleStats(): {
    moduleCount: number;
    memberCount: number;
    avgMembersPerModule: number;
    unassignedDefinitions: number;
  } {
    this.ensureModulesTables();

    const moduleCount = this.getModuleCount();
    const memberCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM module_members');
    const memberCount = (memberCountStmt.get() as { count: number }).count;

    const defCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM definitions');
    const totalDefinitions = (defCountStmt.get() as { count: number }).count;

    return {
      moduleCount,
      memberCount,
      avgMembersPerModule: moduleCount > 0 ? memberCount / moduleCount : 0,
      unassignedDefinitions: totalDefinitions - memberCount,
    };
  }

  // ============================================
  // Flow detection methods
  // ============================================

  /**
   * Ensure the flows tables exist (for existing databases).
   */
  private ensureFlowsTables(): void {
    const tableExists = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='flows'
    `).get();

    if (!tableExists) {
      this.db.exec(`
        CREATE TABLE flows (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          entry_point_id INTEGER NOT NULL REFERENCES definitions(id),
          domain TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE flow_steps (
          flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
          step_order INTEGER NOT NULL,
          definition_id INTEGER NOT NULL REFERENCES definitions(id),
          module_id INTEGER REFERENCES modules(id),
          layer TEXT,
          PRIMARY KEY (flow_id, step_order)
        );

        CREATE INDEX idx_flow_steps_def ON flow_steps(definition_id);
        CREATE INDEX idx_flows_entry ON flows(entry_point_id);
      `);
    }
  }

  /**
   * Find entry points (controllers, routes, handlers).
   * Identifies symbols that are likely entry points based on their role metadata or naming patterns.
   */
  getEntryPoints(): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    domain: string | null;
  }> {
    this.ensureFlowsTables();
    this.ensureModulesTables();

    // Look for symbols with role=controller, or with 'Controller' in name,
    // or exported functions in route files
    const stmt = this.db.prepare(`
      SELECT DISTINCT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        dm_domain.value as domain
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      LEFT JOIN definition_metadata dm_role ON dm_role.definition_id = d.id AND dm_role.key = 'role'
      LEFT JOIN definition_metadata dm_domain ON dm_domain.definition_id = d.id AND dm_domain.key = 'domain'
      WHERE
        -- Explicit controller role
        dm_role.value = 'controller'
        -- Or Controller/Handler in name (case-sensitive)
        OR d.name LIKE '%Controller%'
        OR d.name LIKE '%Handler%'
        -- Or exported methods in files with route/controller/handler in path
        OR (
          d.is_exported = 1
          AND d.kind IN ('function', 'method', 'class')
          AND (
            f.path LIKE '%/routes/%'
            OR f.path LIKE '%/controllers/%'
            OR f.path LIKE '%/handlers/%'
            OR f.path LIKE '%.routes.%'
            OR f.path LIKE '%.controller.%'
            OR f.path LIKE '%.handler.%'
          )
        )
      ORDER BY f.path, d.line
    `);

    const rows = stmt.all() as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      domain: string | null;
    }>;

    // Parse domain JSON array and return first domain
    return rows.map(row => {
      let domain: string | null = null;
      if (row.domain) {
        try {
          const domains = JSON.parse(row.domain) as string[];
          domain = domains[0] ?? null;
        } catch {
          domain = row.domain;
        }
      }
      return { ...row, domain };
    });
  }

  /**
   * Trace reachable symbols from an entry point using call graph.
   * Returns definitions reachable via BFS with their depth.
   */
  traceFlowFromEntry(
    entryId: number,
    maxDepth: number = 15
  ): Array<{
    definitionId: number;
    depth: number;
    moduleId: number | null;
    layer: string | null;
  }> {
    this.ensureFlowsTables();
    this.ensureModulesTables();

    // Build call graph adjacency list
    const edges = this.getCallGraph();
    const adjacency = new Map<number, number[]>();
    for (const edge of edges) {
      if (!adjacency.has(edge.fromId)) {
        adjacency.set(edge.fromId, []);
      }
      adjacency.get(edge.fromId)!.push(edge.toId);
    }

    // BFS traversal
    const visited = new Map<number, number>(); // definitionId -> depth
    const queue: Array<{ id: number; depth: number }> = [{ id: entryId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;

      if (visited.has(id)) continue;
      if (depth > maxDepth) continue;

      visited.set(id, depth);

      const neighbors = adjacency.get(id) ?? [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          queue.push({ id: neighbor, depth: depth + 1 });
        }
      }
    }

    // Get module and layer info for each visited definition
    const result: Array<{
      definitionId: number;
      depth: number;
      moduleId: number | null;
      layer: string | null;
    }> = [];

    for (const [definitionId, depth] of visited) {
      // Get module membership
      const moduleInfo = this.getDefinitionModule(definitionId);
      result.push({
        definitionId,
        depth,
        moduleId: moduleInfo?.module.id ?? null,
        layer: moduleInfo?.module.layer ?? null,
      });
    }

    // Sort by depth
    result.sort((a, b) => a.depth - b.depth);

    return result;
  }

  /**
   * Insert a new flow.
   */
  insertFlow(
    name: string,
    entryPointId: number,
    description?: string,
    domain?: string
  ): number {
    this.ensureFlowsTables();
    const stmt = this.db.prepare(`
      INSERT INTO flows (name, entry_point_id, description, domain)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(name, entryPointId, description ?? null, domain ?? null);
    return result.lastInsertRowid as number;
  }

  /**
   * Add a step to a flow.
   */
  addFlowStep(
    flowId: number,
    stepOrder: number,
    definitionId: number,
    moduleId?: number,
    layer?: string
  ): void {
    this.ensureFlowsTables();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO flow_steps (flow_id, step_order, definition_id, module_id, layer)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(flowId, stepOrder, definitionId, moduleId ?? null, layer ?? null);
  }

  /**
   * Get all flows.
   */
  getFlows(): Flow[] {
    this.ensureFlowsTables();
    const stmt = this.db.prepare(`
      SELECT
        id,
        name,
        description,
        entry_point_id as entryPointId,
        domain,
        created_at as createdAt
      FROM flows
      ORDER BY name
    `);
    return stmt.all() as Flow[];
  }

  /**
   * Get a flow with all its steps.
   */
  getFlowWithSteps(flowId: number): FlowWithSteps | null {
    this.ensureFlowsTables();

    // Get flow
    const flowStmt = this.db.prepare(`
      SELECT
        f.id,
        f.name,
        f.description,
        f.entry_point_id as entryPointId,
        f.domain,
        f.created_at as createdAt,
        d.name as entryPointName,
        d.kind as entryPointKind,
        files.path as entryPointFilePath
      FROM flows f
      JOIN definitions d ON f.entry_point_id = d.id
      JOIN files ON d.file_id = files.id
      WHERE f.id = ?
    `);
    const flow = flowStmt.get(flowId) as (Flow & {
      entryPointName: string;
      entryPointKind: string;
      entryPointFilePath: string;
    }) | undefined;

    if (!flow) return null;

    // Get steps
    const stepsStmt = this.db.prepare(`
      SELECT
        fs.step_order as stepOrder,
        fs.definition_id as definitionId,
        d.name,
        d.kind,
        f.path as filePath,
        fs.module_id as moduleId,
        m.name as moduleName,
        fs.layer
      FROM flow_steps fs
      JOIN definitions d ON fs.definition_id = d.id
      JOIN files f ON d.file_id = f.id
      LEFT JOIN modules m ON fs.module_id = m.id
      WHERE fs.flow_id = ?
      ORDER BY fs.step_order
    `);
    const steps = stepsStmt.all(flowId) as Array<{
      stepOrder: number;
      definitionId: number;
      name: string;
      kind: string;
      filePath: string;
      moduleId: number | null;
      moduleName: string | null;
      layer: string | null;
    }>;

    return { ...flow, steps };
  }

  /**
   * Get all flows with their steps.
   */
  getAllFlowsWithSteps(): FlowWithSteps[] {
    this.ensureFlowsTables();
    const flows = this.getFlows();
    return flows.map(f => this.getFlowWithSteps(f.id)!).filter(f => f !== null);
  }

  /**
   * Get count of flows.
   */
  getFlowCount(): number {
    this.ensureFlowsTables();
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM flows');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Delete all flows.
   */
  clearFlows(): number {
    this.ensureFlowsTables();
    const stmt = this.db.prepare('DELETE FROM flows');
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Get flow statistics.
   */
  getFlowStats(): {
    flowCount: number;
    totalSteps: number;
    avgStepsPerFlow: number;
    modulesCovered: number;
  } {
    this.ensureFlowsTables();

    const flowCount = this.getFlowCount();
    const stepsStmt = this.db.prepare('SELECT COUNT(*) as count FROM flow_steps');
    const totalSteps = (stepsStmt.get() as { count: number }).count;

    const modulesStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT module_id) as count
      FROM flow_steps
      WHERE module_id IS NOT NULL
    `);
    const modulesCovered = (modulesStmt.get() as { count: number }).count;

    return {
      flowCount,
      totalSteps,
      avgStepsPerFlow: flowCount > 0 ? totalSteps / flowCount : 0,
      modulesCovered,
    };
  }

  /**
   * Update a flow's metadata.
   */
  updateFlow(
    flowId: number,
    updates: {
      name?: string;
      description?: string;
      domain?: string;
    }
  ): boolean {
    this.ensureFlowsTables();

    const sets: string[] = [];
    const params: (string | null)[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      params.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description);
    }
    if (updates.domain !== undefined) {
      sets.push('domain = ?');
      params.push(updates.domain);
    }

    if (sets.length === 0) return false;

    params.push(String(flowId));
    const stmt = this.db.prepare(`UPDATE flows SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
