import type Database from 'better-sqlite3';
import { ensureModulesTables } from '../schema-manager.js';
import type { AnnotatedSymbolInfo, CallGraphEdge, Module, ModuleTreeNode, ModuleWithMembers } from '../schema.js';
import { buildSingleRootTree } from '../utils/tree-builder.js';
import { queryCallGraphEdges } from './_shared/call-graph-query.js';

export interface ModuleSymbol {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  isExported: boolean;
}

export interface ModuleMemberInfo {
  definitionId: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  isExported: boolean;
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

const MODULE_COLS = `
  id,
  parent_id as parentId,
  slug,
  full_path as fullPath,
  name,
  description,
  depth,
  color_index as colorIndex,
  is_test as isTest,
  created_at as createdAt`;

const MODULE_COLS_M = `
  m.id,
  m.parent_id as parentId,
  m.slug,
  m.full_path as fullPath,
  m.name,
  m.description,
  m.depth,
  m.color_index as colorIndex,
  m.is_test as isTest,
  m.created_at as createdAt`;

type RawModule = Omit<Module, 'isTest'> & { isTest: number };

function toModule(row: RawModule): Module {
  return { ...row, isTest: row.isTest === 1 };
}

function toModuleWithMembers(
  m: Module & { memberCount?: number },
  getMemberInfo: (id: number) => ModuleMemberInfo[]
): ModuleWithMembers {
  const members = getMemberInfo(m.id);
  return { ...m, members };
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
  insert(parentId: number | null, slug: string, name: string, description?: string, isTest?: boolean): number {
    ensureModulesTables(this.db);

    // Calculate full_path and depth
    let fullPath: string;
    let depth: number;
    let effectiveIsTest = isTest;

    if (parentId === null) {
      fullPath = slug;
      depth = 0;
    } else {
      const parent = this.db
        .prepare(`
        SELECT full_path, depth, is_test FROM modules WHERE id = ?
      `)
        .get(parentId) as { full_path: string; depth: number; is_test: number } | undefined;

      if (!parent) {
        throw new Error(`Parent module ${parentId} not found`);
      }

      fullPath = `${parent.full_path}.${slug}`;
      depth = parent.depth + 1;

      // Inherit test status from parent if parent is test
      if (parent.is_test === 1) {
        effectiveIsTest = true;
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO modules (parent_id, slug, full_path, name, description, depth, is_test)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(parentId, slug, fullPath, name, description ?? null, depth, effectiveIsTest ? 1 : 0);
    return result.lastInsertRowid as number;
  }

  /**
   * Get a module by its full path.
   */
  getByPath(fullPath: string): Module | null {
    ensureModulesTables(this.db);
    const row = this.db
      .prepare(`SELECT ${MODULE_COLS} FROM modules WHERE full_path = ?`)
      .get(fullPath) as RawModule | null;
    if (!row) return null;
    return toModule(row);
  }

  /**
   * Get a module by ID.
   */
  getById(id: number): Module | null {
    ensureModulesTables(this.db);
    const row = this.db.prepare(`SELECT ${MODULE_COLS} FROM modules WHERE id = ?`).get(id) as RawModule | null;
    if (!row) return null;
    return toModule(row);
  }

  /**
   * Get direct children of a module.
   */
  getChildren(moduleId: number): Module[] {
    ensureModulesTables(this.db);
    const rows = this.db
      .prepare(`SELECT ${MODULE_COLS} FROM modules WHERE parent_id = ? ORDER BY slug`)
      .all(moduleId) as RawModule[];
    return rows.map(toModule);
  }

  /**
   * Get all modules as a flat list.
   */
  getAll(): Module[] {
    ensureModulesTables(this.db);
    const rows = this.db.prepare(`SELECT ${MODULE_COLS} FROM modules ORDER BY depth, full_path`).all() as RawModule[];
    return rows.map(toModule);
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
        d.extends_name as extendsName,
        (SELECT COUNT(*) FROM definitions d2 WHERE d2.extends_name = d.name) as extendedByCount,
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
      extendsName: string | null;
      extendedByCount: number;
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
      extendsName: row.extendsName ?? null,
      extendedByCount: row.extendedByCount ?? 0,
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
        d.line,
        d.is_exported as isExported
      FROM module_members mm
      JOIN definitions d ON mm.definition_id = d.id
      JOIN files f ON d.file_id = f.id
      WHERE mm.module_id = ?
      ORDER BY f.path, d.line
    `);

    const rows = stmt.all(moduleId) as Array<Omit<ModuleSymbol, 'isExported'> & { isExported: number }>;
    return rows.map((row) => ({ ...row, isExported: row.isExported === 1 }));
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
    const row = this.db
      .prepare(
        `SELECT ${MODULE_COLS_M} FROM module_members mm JOIN modules m ON mm.module_id = m.id WHERE mm.definition_id = ?`
      )
      .get(definitionId) as RawModule | undefined;
    if (!row) return null;
    return { module: toModule(row) };
  }

  /**
   * Get the symbol-level call graph.
   * This is needed by getModuleCallGraph and getIncomingEdgesFor.
   */
  getCallGraph(): CallGraphEdge[] {
    return queryCallGraphEdges(this.db);
  }

  /**
   * Get modules that exceed a member threshold.
   * Returns modules with member_count > threshold, including their member details.
   */
  getModulesExceedingThreshold(threshold: number): ModuleWithMembers[] {
    ensureModulesTables(this.db);

    const rawModules = this.db
      .prepare(`
      SELECT ${MODULE_COLS_M}, COUNT(mm.definition_id) as memberCount
      FROM modules m
      JOIN module_members mm ON mm.module_id = m.id
      GROUP BY m.id
      HAVING COUNT(mm.definition_id) > ?
      ORDER BY m.depth, m.full_path
    `)
      .all(threshold) as Array<RawModule & { memberCount: number }>;

    return rawModules.map((m) => toModuleWithMembers(toModule(m), (id) => this.getMemberInfo(id)));
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
        d.line,
        d.is_exported as isExported
      FROM module_members mm
      JOIN definitions d ON mm.definition_id = d.id
      JOIN files f ON d.file_id = f.id
      WHERE mm.module_id = ?
      ORDER BY f.path, d.line
    `);

    const rows = stmt.all(moduleId) as Array<Omit<ModuleMemberInfo, 'isExported'> & { isExported: number }>;
    return rows.map((row) => ({ ...row, isExported: row.isExported === 1 }));
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
   * Get IDs of all test modules (is_test = 1).
   */
  getTestModuleIds(): Set<number> {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare('SELECT id FROM modules WHERE is_test = 1');
    const rows = stmt.all() as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Prune empty leaf modules iteratively.
   * A leaf is a module with no children and no members.
   * Deleting a leaf may turn its parent into a new empty leaf, so we loop.
   */
  pruneEmptyLeaves(): number {
    let totalPruned = 0;
    // foreign_keys pragma is OFF, so no CASCADE — but empty leaves
    // have no members and no children by definition, so plain DELETE works.
    const stmt = this.db.prepare(`
      DELETE FROM modules WHERE full_path != 'project'
        AND id NOT IN (SELECT DISTINCT parent_id FROM modules WHERE parent_id IS NOT NULL)
        AND id NOT IN (SELECT DISTINCT module_id FROM module_members)
    `);
    while (true) {
      const result = stmt.run();
      if (result.changes === 0) break;
      totalPruned += result.changes;
    }
    return totalPruned;
  }

  /**
   * Update a module's name and/or description.
   */
  update(id: number, updates: { name?: string; description?: string }): boolean {
    ensureModulesTables(this.db);

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

    if (sets.length === 0) return false;

    params.push(String(id));
    const stmt = this.db.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Delete a module.
   * Throws an error if the module has members unless the caller handles that externally.
   */
  delete(id: number): boolean {
    ensureModulesTables(this.db);

    // Check for members
    const memberCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM module_members WHERE module_id = ?').get(id) as { count: number }
    ).count;

    if (memberCount > 0) {
      throw new Error(`Module ${id} has ${memberCount} member(s). Remove members first or use --force.`);
    }

    const stmt = this.db.prepare('DELETE FROM modules WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Remove a symbol from its module assignment.
   */
  unassignSymbol(definitionId: number): boolean {
    ensureModulesTables(this.db);
    const stmt = this.db.prepare('DELETE FROM module_members WHERE definition_id = ?');
    const result = stmt.run(definitionId);
    return result.changes > 0;
  }

  /**
   * Get leaf modules exceeding a member threshold.
   * Leaf = not a parent of any other module. Ordered by member count DESC (largest first).
   */
  getLeafModulesExceedingThreshold(threshold: number): ModuleWithMembers[] {
    ensureModulesTables(this.db);

    const rawModules = this.db
      .prepare(`
      SELECT ${MODULE_COLS_M}, COUNT(mm.definition_id) as memberCount
      FROM modules m
      JOIN module_members mm ON mm.module_id = m.id
      WHERE m.id NOT IN (SELECT DISTINCT parent_id FROM modules WHERE parent_id IS NOT NULL)
      GROUP BY m.id
      HAVING COUNT(mm.definition_id) > ?
      ORDER BY COUNT(mm.definition_id) DESC
    `)
      .all(threshold) as Array<RawModule & { memberCount: number }>;

    return rawModules.map((m) => toModuleWithMembers(toModule(m), (id) => this.getMemberInfo(id)));
  }

  /**
   * Get branch modules (has children) with direct members exceeding a threshold.
   * These need rebalancing, not splitting.
   */
  getBranchModulesWithDirectMembers(threshold: number): ModuleWithMembers[] {
    ensureModulesTables(this.db);

    const rawModules = this.db
      .prepare(`
      SELECT ${MODULE_COLS_M}, COUNT(mm.definition_id) as memberCount
      FROM modules m
      JOIN module_members mm ON mm.module_id = m.id
      WHERE m.id IN (SELECT DISTINCT parent_id FROM modules WHERE parent_id IS NOT NULL)
      GROUP BY m.id
      HAVING COUNT(mm.definition_id) > ?
      ORDER BY COUNT(mm.definition_id) DESC
    `)
      .all(threshold) as Array<RawModule & { memberCount: number }>;

    return rawModules.map((m) => toModuleWithMembers(toModule(m), (id) => this.getMemberInfo(id)));
  }

  /**
   * Get all assigned symbols grouped by file path.
   * Returns definition_id, module_id, and file path for every module member.
   */
  getAssignedSymbolsByFile(): Array<{ definitionId: number; moduleId: number; filePath: string }> {
    ensureModulesTables(this.db);
    return this.db
      .prepare(
        `SELECT mm.definition_id as definitionId, mm.module_id as moduleId, f.path as filePath
         FROM module_members mm
         JOIN definitions d ON d.id = mm.definition_id
         JOIN files f ON d.file_id = f.id`
      )
      .all() as Array<{ definitionId: number; moduleId: number; filePath: string }>;
  }

  /**
   * Get definitions that are base classes (extended by 2+ subclasses) with their current module assignment.
   *
   * Note: matches by simple class name (extends_name column). If two unrelated
   * classes share the same name, they will be conflated. This is an inherent
   * limitation of the extends_name schema.
   */
  getBaseClassCandidates(): Array<{ definitionId: number; name: string; moduleId: number; extendedByCount: number }> {
    ensureModulesTables(this.db);
    return this.db
      .prepare(`
        SELECT d.id as definitionId, d.name, mm.module_id as moduleId, cnt.extendedByCount
        FROM definitions d
        JOIN module_members mm ON mm.definition_id = d.id
        JOIN (
            SELECT extends_name, COUNT(*) as extendedByCount
            FROM definitions
            WHERE extends_name IS NOT NULL
            GROUP BY extends_name
            HAVING COUNT(*) >= 2
        ) cnt ON cnt.extends_name = d.name
      `)
      .all() as Array<{ definitionId: number; name: string; moduleId: number; extendedByCount: number }>;
  }

  /**
   * Get definitions that extend a given class name, with their module assignments.
   *
   * Note: matches by simple class name (extends_name column). If two unrelated
   * classes share the same name, they will be conflated. This is an inherent
   * limitation of the extends_name schema.
   */
  getExtenderModules(className: string): Array<{ definitionId: number; moduleId: number }> {
    ensureModulesTables(this.db);
    return this.db
      .prepare(`
        SELECT d.id as definitionId, mm.module_id as moduleId
        FROM definitions d
        JOIN module_members mm ON mm.definition_id = d.id
        WHERE d.extends_name = ?
      `)
      .all(className) as Array<{ definitionId: number; moduleId: number }>;
  }

  /**
   * Get all extender definitions grouped by class name, in a single query.
   * Used to avoid N+1 queries when processing multiple base class candidates.
   */
  getAllExtenderModulesByClass(): Map<string, Array<{ definitionId: number; moduleId: number }>> {
    ensureModulesTables(this.db);
    const rows = this.db
      .prepare(`
        SELECT d.extends_name as className, d.id as definitionId, mm.module_id as moduleId
        FROM definitions d
        JOIN module_members mm ON mm.definition_id = d.id
        WHERE d.extends_name IS NOT NULL
      `)
      .all() as Array<{ className: string; definitionId: number; moduleId: number }>;

    const result = new Map<string, Array<{ definitionId: number; moduleId: number }>>();
    for (const row of rows) {
      const existing = result.get(row.className) ?? [];
      existing.push({ definitionId: row.definitionId, moduleId: row.moduleId });
      result.set(row.className, existing);
    }
    return result;
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
