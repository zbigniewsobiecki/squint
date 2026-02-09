import type Database from 'better-sqlite3';
import { ensureModulesTables } from '../schema-manager.js';
import type { AnnotatedSymbolInfo, CallGraphEdge, Module, ModuleTreeNode, ModuleWithMembers } from '../schema.js';
import { buildSingleRootTree } from '../utils/tree-builder.js';

export interface ModuleSymbol {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface ModuleMemberInfo {
  definitionId: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface ModuleStats {
  moduleCount: number;
  assigned: number;
  unassigned: number;
}

export interface IncomingEdge {
  callerId: number;
  callerName: string;
  callerModuleId: number | null;
  weight: number;
}

/**
 * Repository for module tree operations.
 */
export class ModuleRepository {
  constructor(private db: Database.Database) {}

  /**
   * Ensure the root "project" module exists and return its ID.
   */
  ensureRoot(): number {
    ensureModulesTables(this.db);

    const existing = this.db
      .prepare(`
      SELECT id FROM modules WHERE full_path = 'project'
    `)
      .get() as { id: number } | undefined;

    if (existing) return existing.id;

    const stmt = this.db.prepare(`
      INSERT INTO modules (parent_id, slug, full_path, name, description, depth)
      VALUES (NULL, 'project', 'project', 'Project', 'Root module for the project', 0)
    `);
    const result = stmt.run();
    return result.lastInsertRowid as number;
  }

  /**
   * Insert a new module in the tree.
   */
  insert(parentId: number | null, slug: string, name: string, description?: string): number {
    ensureModulesTables(this.db);

    // Calculate full_path and depth
    let fullPath: string;
    let depth: number;

    if (parentId === null) {
      fullPath = slug;
      depth = 0;
    } else {
      const parent = this.db
        .prepare(`
        SELECT full_path, depth FROM modules WHERE id = ?
      `)
        .get(parentId) as { full_path: string; depth: number } | undefined;

      if (!parent) {
        throw new Error(`Parent module ${parentId} not found`);
      }

      fullPath = `${parent.full_path}.${slug}`;
      depth = parent.depth + 1;
    }

    const stmt = this.db.prepare(`
      INSERT INTO modules (parent_id, slug, full_path, name, description, depth)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(parentId, slug, fullPath, name, description ?? null, depth);
    return result.lastInsertRowid as number;
  }

  /**
   * Get a module by its full path.
   */
  getByPath(fullPath: string): Module | null {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        slug,
        full_path as fullPath,
        name,
        description,
        depth,
        color_index as colorIndex,
        created_at as createdAt
      FROM modules
      WHERE full_path = ?
    `);
    return stmt.get(fullPath) as Module | null;
  }

  /**
   * Get a module by ID.
   */
  getById(id: number): Module | null {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        slug,
        full_path as fullPath,
        name,
        description,
        depth,
        color_index as colorIndex,
        created_at as createdAt
      FROM modules
      WHERE id = ?
    `);
    return stmt.get(id) as Module | null;
  }

  /**
   * Get direct children of a module.
   */
  getChildren(moduleId: number): Module[] {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        slug,
        full_path as fullPath,
        name,
        description,
        depth,
        color_index as colorIndex,
        created_at as createdAt
      FROM modules
      WHERE parent_id = ?
      ORDER BY slug
    `);
    return stmt.all(moduleId) as Module[];
  }

  /**
   * Get all modules as a flat list.
   */
  getAll(): Module[] {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        slug,
        full_path as fullPath,
        name,
        description,
        depth,
        color_index as colorIndex,
        created_at as createdAt
      FROM modules
      ORDER BY depth, full_path
    `);
    return stmt.all() as Module[];
  }

  /**
   * Get the module tree as a recursive structure.
   */
  getTree(): ModuleTreeNode | null {
    ensureModulesTables(this.db);
    const modules = this.getAll();
    if (modules.length === 0) return null;

    return buildSingleRootTree(modules, (m): ModuleTreeNode => ({ ...m, children: [] }));
  }

  /**
   * Delete all modules and their memberships.
   */
  clear(): void {
    ensureModulesTables(this.db);
    this.db.exec('DELETE FROM modules');
  }

  /**
   * Assign a symbol (definition) to a module.
   */
  assignSymbol(definitionId: number, moduleId: number): void {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO module_members (module_id, definition_id)
      VALUES (?, ?)
    `);
    stmt.run(moduleId, definitionId);
  }

  /**
   * Get all symbols not yet assigned to any module.
   */
  getUnassigned(): AnnotatedSymbolInfo[] {
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        d.end_line as endLine,
        d.is_exported as isExported,
        MAX(CASE WHEN dm.key = 'purpose' THEN dm.value END) as purpose,
        MAX(CASE WHEN dm.key = 'domain' THEN dm.value END) as domain,
        MAX(CASE WHEN dm.key = 'role' THEN dm.value END) as role
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      LEFT JOIN definition_metadata dm ON dm.definition_id = d.id
      WHERE d.id NOT IN (SELECT definition_id FROM module_members)
      GROUP BY d.id
      ORDER BY f.path, d.line
    `);

    const rows = stmt.all() as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      endLine: number;
      isExported: number;
      purpose: string | null;
      domain: string | null;
      role: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.filePath,
      line: row.line,
      endLine: row.endLine,
      isExported: row.isExported === 1,
      purpose: row.purpose,
      domain: row.domain ? (JSON.parse(row.domain) as string[]) : null,
      role: row.role,
    }));
  }

  /**
   * Get symbols assigned to a specific module.
   */
  getSymbols(moduleId: number): ModuleSymbol[] {
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line
      FROM module_members mm
      JOIN definitions d ON mm.definition_id = d.id
      JOIN files f ON d.file_id = f.id
      WHERE mm.module_id = ?
      ORDER BY f.path, d.line
    `);

    return stmt.all(moduleId) as ModuleSymbol[];
  }

  /**
   * Get a module with all its members.
   */
  getWithMembers(moduleId: number): ModuleWithMembers | null {
    ensureModulesTables(this.db);

    const module = this.getById(moduleId);
    if (!module) return null;

    const members = this.getSymbols(moduleId);
    return {
      ...module,
      members: members.map((m) => ({ ...m, definitionId: m.id })),
    };
  }

  /**
   * Get all modules with their members.
   */
  getAllWithMembers(): ModuleWithMembers[] {
    ensureModulesTables(this.db);
    const modules = this.getAll();
    return modules.map((m) => {
      const members = this.getSymbols(m.id);
      return {
        ...m,
        members: members.map((mem) => ({ ...mem, definitionId: mem.id })),
      };
    });
  }

  /**
   * Get module statistics.
   */
  getStats(): ModuleStats {
    ensureModulesTables(this.db);

    const moduleCount = (this.db.prepare('SELECT COUNT(*) as count FROM modules').get() as { count: number }).count;
    const assigned = (this.db.prepare('SELECT COUNT(*) as count FROM module_members').get() as { count: number }).count;
    const totalDefs = (this.db.prepare('SELECT COUNT(*) as count FROM definitions').get() as { count: number }).count;

    return {
      moduleCount,
      assigned,
      unassigned: totalDefs - assigned,
    };
  }

  /**
   * Get count of modules.
   */
  getCount(): number {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM modules');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get module membership for a definition.
   */
  getDefinitionModule(definitionId: number): { module: Module } | null {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        m.id,
        m.parent_id as parentId,
        m.slug,
        m.full_path as fullPath,
        m.name,
        m.description,
        m.depth,
        m.color_index as colorIndex,
        m.created_at as createdAt
      FROM module_members mm
      JOIN modules m ON mm.module_id = m.id
      WHERE mm.definition_id = ?
    `);
    const module = stmt.get(definitionId) as Module | undefined;
    if (!module) return null;
    return { module };
  }

  /**
   * Get the symbol-level call graph.
   * This is needed by getModuleCallGraph and getIncomingEdgesFor.
   */
  getCallGraph(): CallGraphEdge[] {
    // Query for both internal and imported calls
    const stmt = this.db.prepare(`
      SELECT
        caller.id as from_id,
        s.definition_id as to_id,
        COUNT(*) as weight,
        MIN(u.line) as min_usage_line
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
        COUNT(*) as weight,
        MIN(u.line) as min_usage_line
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

    const rows = stmt.all() as Array<{
      from_id: number;
      to_id: number;
      weight: number;
      min_usage_line: number;
    }>;

    // Aggregate duplicate edges (from the UNION), keeping minimum usage line
    const edgeMap = new Map<string, CallGraphEdge>();
    for (const row of rows) {
      const key = `${row.from_id}-${row.to_id}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += row.weight;
        existing.minUsageLine = Math.min(existing.minUsageLine, row.min_usage_line);
      } else {
        edgeMap.set(key, {
          fromId: row.from_id,
          toId: row.to_id,
          weight: row.weight,
          minUsageLine: row.min_usage_line,
        });
      }
    }

    return Array.from(edgeMap.values());
  }

  /**
   * Get modules that exceed a member threshold.
   * Returns modules with member_count > threshold, including their member details.
   */
  getModulesExceedingThreshold(threshold: number): ModuleWithMembers[] {
    ensureModulesTables(this.db);

    // First find modules that exceed the threshold
    const modulesStmt = this.db.prepare(`
      SELECT
        m.id,
        m.parent_id as parentId,
        m.slug,
        m.full_path as fullPath,
        m.name,
        m.description,
        m.depth,
        m.color_index as colorIndex,
        m.created_at as createdAt,
        COUNT(mm.definition_id) as memberCount
      FROM modules m
      JOIN module_members mm ON mm.module_id = m.id
      GROUP BY m.id
      HAVING COUNT(mm.definition_id) > ?
      ORDER BY m.depth, m.full_path
    `);

    const modules = modulesStmt.all(threshold) as Array<Module & { memberCount: number }>;

    // For each module, get its members with details
    return modules.map((m) => {
      const members = this.getMemberInfo(m.id);
      return {
        id: m.id,
        parentId: m.parentId,
        slug: m.slug,
        fullPath: m.fullPath,
        name: m.name,
        description: m.description,
        depth: m.depth,
        colorIndex: m.colorIndex,
        createdAt: m.createdAt,
        members,
      };
    });
  }

  /**
   * Get detailed member info for a module (used by deepen phase).
   */
  getMemberInfo(moduleId: number): ModuleMemberInfo[] {
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        mm.definition_id as definitionId,
        d.name,
        d.kind,
        f.path as filePath,
        d.line
      FROM module_members mm
      JOIN definitions d ON mm.definition_id = d.id
      JOIN files f ON d.file_id = f.id
      WHERE mm.module_id = ?
      ORDER BY f.path, d.line
    `);

    return stmt.all(moduleId) as ModuleMemberInfo[];
  }

  /**
   * Assign color indices based on branch identity.
   * Each depth-1 module gets a sequential index; descendants inherit their ancestor's index.
   */
  assignColorIndices(): void {
    ensureModulesTables(this.db);

    const depth1Modules = this.db
      .prepare('SELECT id, full_path FROM modules WHERE depth = 1 ORDER BY id')
      .all() as Array<{ id: number; full_path: string }>;

    const updateStmt = this.db.prepare(
      'UPDATE modules SET color_index = ? WHERE id = ? OR (full_path LIKE ? AND depth > 1)'
    );

    const transaction = this.db.transaction(() => {
      for (let i = 0; i < depth1Modules.length; i++) {
        const mod = depth1Modules[i];
        updateStmt.run(i, mod.id, `${mod.full_path}.%`);
      }
    });

    transaction();
  }

  /**
   * Get all callers of a definition with their module assignments.
   */
  getIncomingEdgesFor(definitionId: number): IncomingEdge[] {
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        caller.id as callerId,
        caller.name as callerName,
        mm.module_id as callerModuleId,
        COUNT(*) as weight
      FROM definitions caller
      JOIN files f ON caller.file_id = f.id
      JOIN symbols s ON s.file_id = f.id AND s.definition_id = ?
      JOIN usages u ON u.symbol_id = s.id
      LEFT JOIN module_members mm ON mm.definition_id = caller.id
      WHERE u.context IN ('call_expression', 'new_expression')
        AND caller.line <= u.line AND u.line <= caller.end_line
        AND caller.id != ?
      GROUP BY caller.id, mm.module_id
      UNION ALL
      SELECT
        caller.id as callerId,
        caller.name as callerName,
        mm.module_id as callerModuleId,
        COUNT(*) as weight
      FROM definitions caller
      JOIN files f ON caller.file_id = f.id
      JOIN imports i ON i.from_file_id = f.id
      JOIN symbols s ON s.reference_id = i.id AND s.definition_id = ?
      JOIN usages u ON u.symbol_id = s.id
      LEFT JOIN module_members mm ON mm.definition_id = caller.id
      WHERE u.context IN ('call_expression', 'new_expression')
        AND caller.line <= u.line AND u.line <= caller.end_line
        AND caller.id != ?
      GROUP BY caller.id, mm.module_id
    `);

    const rows = stmt.all(definitionId, definitionId, definitionId, definitionId) as IncomingEdge[];

    // Aggregate duplicate callers (from the UNION)
    const callerMap = new Map<number, IncomingEdge>();

    for (const row of rows) {
      const existing = callerMap.get(row.callerId);
      if (existing) {
        existing.weight += row.weight;
      } else {
        callerMap.set(row.callerId, { ...row });
      }
    }

    return Array.from(callerMap.values());
  }
}
