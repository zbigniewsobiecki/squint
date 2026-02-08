import type Database from 'better-sqlite3';
import type { Definition } from '../../parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../../parser/reference-extractor.js';
import type { FileInsert } from '../schema.js';

export interface FileDetails {
  id: number;
  path: string;
  language: string;
  sizeBytes: number;
  modifiedAt: string;
  contentHash: string;
}

export interface FileInfo {
  id: number;
  path: string;
  language: string;
  sizeBytes: number;
}

export interface FileWithStats {
  id: number;
  path: string;
  importedByCount: number;
  importsCount: number;
}

export interface FileImportedBy {
  id: number;
  path: string;
  line: number;
  column: number;
}

export interface FileImport {
  id: number;
  toFileId: number | null;
  type: string;
  source: string;
  isExternal: boolean;
  isTypeOnly: boolean;
  line: number;
  column: number;
  toFilePath: string | null;
}

export class FileRepository {
  constructor(private db: Database.Database) {}

  insert(file: FileInsert): number {
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

  insertReference(fromFileId: number, toFileId: number | null, ref: FileReference): number {
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

  insertSymbol(refId: number | null, defId: number | null, sym: ImportedSymbol, fileId?: number): number {
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

  getById(id: number): FileDetails | null {
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
    const row = stmt.get(id) as FileDetails | undefined;
    return row ?? null;
  }

  getIdByPath(path: string): number | null {
    const stmt = this.db.prepare('SELECT id FROM files WHERE path = ?');
    const row = stmt.get(path) as { id: number } | undefined;
    return row?.id ?? null;
  }

  getAll(): FileInfo[] {
    const stmt = this.db.prepare(`
      SELECT id, path, language, size_bytes as sizeBytes
      FROM files
      ORDER BY path
    `);
    return stmt.all() as FileInfo[];
  }

  getAllWithStats(): FileWithStats[] {
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
    return stmt.all() as FileWithStats[];
  }

  getOrphans(options?: { includeIndex?: boolean; includeTests?: boolean }): Array<{ id: number; path: string }> {
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

  getImports(fileId: number): FileImport[] {
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

  getImportedBy(fileId: number): FileImportedBy[] {
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
    return stmt.all(fileId) as FileImportedBy[];
  }

  getCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM files');
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
}
