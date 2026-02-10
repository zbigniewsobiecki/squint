import type Database from 'better-sqlite3';
import type { Definition } from '../../parser/definition-extractor.js';

export interface DefinitionInfo {
  id: number;
  filePath: string;
  name: string;
  kind: string;
  line: number;
  endLine: number;
  isExported: boolean;
}

export interface DefinitionDetails {
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
}

export interface DefinitionListItem {
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
}

export interface FileDefinition {
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
}

export interface SymbolInfo {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface ClassHierarchyNode {
  id: number;
  name: string;
  kind: string;
  extendsName: string | null;
}

export interface ClassHierarchyLink {
  source: number;
  target: number;
  type: string;
}

export class DefinitionRepository {
  constructor(private db: Database.Database) {}

  getByName(fileId: number, name: string): number | null {
    const stmt = this.db.prepare('SELECT id FROM definitions WHERE file_id = ? AND name = ? AND is_exported = 1');
    const row = stmt.get(fileId, name) as { id: number } | undefined;
    return row?.id ?? null;
  }

  getAllByName(name: string): DefinitionInfo[] {
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

    return rows.map((row) => ({
      id: row.id,
      filePath: row.filePath,
      name: row.name,
      kind: row.kind,
      line: row.line,
      endLine: row.endLine,
      isExported: row.isExported === 1,
    }));
  }

  getById(id: number): DefinitionDetails | null {
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
    const row = stmt.get(id) as
      | {
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
        }
      | undefined;

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

  getCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM definitions');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  getForFile(fileId: number): FileDefinition[] {
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

    return rows.map((row) => ({
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

  getAll(filters?: { kind?: string; exported?: boolean }): DefinitionListItem[] {
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

    return rows.map((row) => ({
      ...row,
      isExported: row.isExported === 1,
      isDefault: row.isDefault === 1,
    }));
  }

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

  getClassHierarchy(): {
    nodes: ClassHierarchyNode[];
    links: ClassHierarchyLink[];
  } {
    // Get all classes and interfaces as nodes
    const nodesStmt = this.db.prepare(`
      SELECT id, name, kind, extends_name as extendsName
      FROM definitions
      WHERE kind IN ('class', 'interface')
    `);
    const nodes = nodesStmt.all() as ClassHierarchyNode[];

    // Build a map of name -> id for linking
    const nameToId = new Map<string, number>();
    for (const node of nodes) {
      nameToId.set(node.name, node.id);
    }

    // Create links for extends relationships
    const links: ClassHierarchyLink[] = [];
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

  getSymbols(filters?: { kind?: string; fileId?: number }): SymbolInfo[] {
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
    return stmt.all(...params) as SymbolInfo[];
  }

  getKindCounts(): Record<string, number> {
    const stmt = this.db.prepare('SELECT kind, COUNT(*) as count FROM definitions GROUP BY kind ORDER BY count DESC');
    const rows = stmt.all() as Array<{ kind: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.kind] = row.count;
    }
    return result;
  }

  getFilteredCount(filters?: { kind?: string; filePattern?: string }): number {
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
}
