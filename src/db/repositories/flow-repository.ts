import type Database from 'better-sqlite3';
import type {
  Flow,
  FlowTreeNode,
  Module,
  ModuleCallEdge,
  FlowCoverageStats,
  CallGraphEdge,
} from '../schema.js';
import { ensureFlowsTables, ensureModulesTables } from '../schema-manager.js';
import { buildTree } from '../utils/tree-builder.js';

export interface FlowInsertOptions {
  description?: string;
  fromModuleId?: number;
  toModuleId?: number;
  semantic?: string;
  domain?: string;
  stepOrder?: number;
}

export interface FlowUpdateOptions {
  name?: string;
  description?: string;
  semantic?: string;
  domain?: string;
}

export interface FlowStats {
  flowCount: number;
  leafFlowCount: number;
  rootFlowCount: number;
  maxDepth: number;
}

/**
 * Repository for flow tree operations.
 */
export class FlowRepository {
  constructor(private db: Database.Database) {}

  /**
   * Ensure a root flow exists with the given slug and return it.
   */
  ensureRoot(slug: string): Flow {
    ensureFlowsTables(this.db);

    // Convert slug to name (capitalize each word)
    const name = slug
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    // Check if a root flow with this slug already exists
    const existing = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows
      WHERE slug = ? AND parent_id IS NULL
    `).get(slug) as Flow | undefined;

    if (existing) return existing;

    // Create new root flow
    const stmt = this.db.prepare(`
      INSERT INTO flows (parent_id, step_order, slug, full_path, name, depth)
      VALUES (NULL, 0, ?, ?, ?, 0)
    `);
    const result = stmt.run(slug, slug, name);
    const flowId = result.lastInsertRowid as number;

    return this.getById(flowId)!;
  }

  /**
   * Insert a new flow in the tree.
   */
  insert(
    parentId: number | null,
    slug: string,
    name: string,
    options?: FlowInsertOptions
  ): number {
    ensureFlowsTables(this.db);

    // Calculate full_path and depth
    let fullPath: string;
    let depth: number;
    let stepOrder = options?.stepOrder ?? 0;

    if (parentId === null) {
      fullPath = slug;
      depth = 0;
    } else {
      const parent = this.db.prepare(`
        SELECT full_path, depth FROM flows WHERE id = ?
      `).get(parentId) as { full_path: string; depth: number } | undefined;

      if (!parent) {
        throw new Error(`Parent flow ${parentId} not found`);
      }

      fullPath = `${parent.full_path}.${slug}`;
      depth = parent.depth + 1;

      // Auto-calculate step_order if not provided
      if (stepOrder === 0) {
        const maxOrder = this.db.prepare(`
          SELECT COALESCE(MAX(step_order), 0) as max FROM flows WHERE parent_id = ?
        `).get(parentId) as { max: number };
        stepOrder = maxOrder.max + 1;
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO flows (parent_id, step_order, slug, full_path, name, description, from_module_id, to_module_id, semantic, depth, domain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      parentId,
      stepOrder,
      slug,
      fullPath,
      name,
      options?.description ?? null,
      options?.fromModuleId ?? null,
      options?.toModuleId ?? null,
      options?.semantic ?? null,
      depth,
      options?.domain ?? null
    );
    return result.lastInsertRowid as number;
  }

  /**
   * Get a flow by its full path.
   */
  getByPath(fullPath: string): Flow | null {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows
      WHERE full_path = ?
    `);
    const result = stmt.get(fullPath) as Flow | undefined;
    return result ?? null;
  }

  /**
   * Get a flow by ID.
   */
  getById(flowId: number): Flow | null {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows
      WHERE id = ?
    `);
    return stmt.get(flowId) as Flow | null;
  }

  /**
   * Get a flow by its slug.
   */
  getBySlug(slug: string): Flow | null {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows
      WHERE slug = ?
      LIMIT 1
    `);
    const result = stmt.get(slug) as Flow | undefined;
    return result ?? null;
  }

  /**
   * Get direct children of a flow.
   */
  getChildren(flowId: number): Flow[] {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows
      WHERE parent_id = ?
      ORDER BY step_order
    `);
    return stmt.all(flowId) as Flow[];
  }

  /**
   * Get all flows as a flat list.
   */
  getAll(): Flow[] {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows
      ORDER BY depth, full_path
    `);
    return stmt.all() as Flow[];
  }

  /**
   * Get all flow trees as an array of root nodes with their children.
   */
  getTree(): FlowTreeNode[] {
    ensureFlowsTables(this.db);
    ensureModulesTables(this.db);

    const flows = this.getAll();
    if (flows.length === 0) return [];

    // Get module names for enrichment
    const modules = this.getAllModules();
    const moduleNameMap = new Map(modules.map(m => [m.id, m.fullPath]));

    const roots = buildTree(
      flows,
      (f): FlowTreeNode => ({
        ...f,
        children: [],
        fromModuleName: f.fromModuleId ? moduleNameMap.get(f.fromModuleId) : undefined,
        toModuleName: f.toModuleId ? moduleNameMap.get(f.toModuleId) : undefined,
      })
    );

    // Sort children by stepOrder
    const sortChildren = (nodes: FlowTreeNode[]): void => {
      nodes.sort((a, b) => a.stepOrder - b.stepOrder);
      for (const node of nodes) {
        sortChildren(node.children);
      }
    };
    sortChildren(roots);

    return roots;
  }

  /**
   * Get all leaf flows (flows with module transitions).
   */
  getLeaves(): Flow[] {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows
      WHERE from_module_id IS NOT NULL AND to_module_id IS NOT NULL
      ORDER BY full_path
    `);
    return stmt.all() as Flow[];
  }

  /**
   * Get flows for a specific module transition.
   */
  getForModuleTransition(fromModuleId: number, toModuleId: number): Flow[] {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows
      WHERE from_module_id = ? AND to_module_id = ?
      ORDER BY full_path
    `);
    return stmt.all(fromModuleId, toModuleId) as Flow[];
  }

  /**
   * Expand a composite flow to its ordered list of descendant leaf flows.
   */
  expand(flowId: number): Flow[] {
    ensureFlowsTables(this.db);

    const flow = this.getById(flowId);
    if (!flow) return [];

    const children = this.getChildren(flowId);
    const result: Flow[] = [];

    for (const child of children) {
      if (child.fromModuleId !== null && child.toModuleId !== null) {
        result.push(child);
      } else {
        result.push(...this.expand(child.id));
      }
    }

    return result;
  }

  /**
   * Update a flow's metadata.
   */
  update(flowId: number, updates: FlowUpdateOptions): boolean {
    ensureFlowsTables(this.db);

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
    if (updates.semantic !== undefined) {
      sets.push('semantic = ?');
      params.push(updates.semantic);
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

  /**
   * Reparent a single flow under a new parent.
   */
  reparent(flowId: number, newParentId: number | null, stepOrder?: number): void {
    ensureFlowsTables(this.db);

    const flow = this.getById(flowId);
    if (!flow) {
      throw new Error(`Flow ${flowId} not found`);
    }

    // Calculate new values
    let newFullPath: string;
    let newDepth: number;

    if (newParentId === null) {
      newFullPath = flow.slug;
      newDepth = 0;
    } else {
      const parent = this.getById(newParentId);
      if (!parent) {
        throw new Error(`Parent flow ${newParentId} not found`);
      }
      newFullPath = `${parent.fullPath}.${flow.slug}`;
      newDepth = parent.depth + 1;
    }

    // Auto-assign step_order if not provided
    if (stepOrder === undefined) {
      const maxOrder = this.db.prepare(
        `SELECT COALESCE(MAX(step_order), 0) as max FROM flows WHERE parent_id ${newParentId === null ? 'IS NULL' : '= ?'}`
      ).get(...(newParentId === null ? [] : [newParentId])) as { max: number };
      stepOrder = maxOrder.max + 1;
    }

    // Update the flow
    this.db.prepare(`
      UPDATE flows
      SET parent_id = ?, full_path = ?, depth = ?, step_order = ?
      WHERE id = ?
    `).run(newParentId, newFullPath, newDepth, stepOrder, flowId);

    // Recursively update all descendants' full_path and depth
    this.updateDescendantPaths(flowId, newFullPath, newDepth);
  }

  /**
   * Reparent multiple flows under a new parent in the order provided.
   */
  reparentMany(flowIds: number[], newParentId: number): void {
    for (let i = 0; i < flowIds.length; i++) {
      this.reparent(flowIds[i], newParentId, i + 1);
    }
  }

  /**
   * Delete a flow and all its descendants.
   */
  delete(flowId: number): number {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM flows WHERE id = ?');
    const result = stmt.run(flowId);
    return result.changes;
  }

  /**
   * Delete all flows.
   */
  clear(): number {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM flows');
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Get count of flows.
   */
  getCount(): number {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM flows');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get flows at a specific depth that have no parent and no children (orphans).
   */
  getOrphans(depth: number): Flow[] {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        id,
        parent_id as parentId,
        step_order as stepOrder,
        name,
        slug,
        full_path as fullPath,
        description,
        from_module_id as fromModuleId,
        to_module_id as toModuleId,
        semantic,
        depth,
        domain,
        created_at as createdAt
      FROM flows f
      WHERE depth = ?
        AND parent_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM flows child WHERE child.parent_id = f.id
        )
    `);
    return stmt.all(depth) as Flow[];
  }

  /**
   * Get flow statistics.
   */
  getStats(): FlowStats {
    ensureFlowsTables(this.db);

    const flowCount = this.getCount();
    const leafFlowCount = this.getLeaves().length;

    const rootStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM flows WHERE parent_id IS NULL
    `);
    const rootFlowCount = (rootStmt.get() as { count: number }).count;

    const depthStmt = this.db.prepare(`
      SELECT COALESCE(MAX(depth), 0) as maxDepth FROM flows
    `);
    const maxDepth = (depthStmt.get() as { maxDepth: number }).maxDepth;

    return {
      flowCount,
      leafFlowCount,
      rootFlowCount,
      maxDepth,
    };
  }

  /**
   * Get the module-level call graph.
   */
  getModuleCallGraph(): ModuleCallEdge[] {
    ensureModulesTables(this.db);

    // Get symbol-level call graph
    const symbolEdges = this.getCallGraph();

    // Build module lookup for definitions
    const defModuleMap = new Map<number, { moduleId: number; modulePath: string }>();
    const moduleMembers = this.db.prepare(`
      SELECT mm.definition_id, mm.module_id, m.full_path
      FROM module_members mm
      JOIN modules m ON mm.module_id = m.id
    `).all() as Array<{ definition_id: number; module_id: number; full_path: string }>;

    for (const mm of moduleMembers) {
      defModuleMap.set(mm.definition_id, {
        moduleId: mm.module_id,
        modulePath: mm.full_path,
      });
    }

    // Aggregate to module-level edges
    const edgeMap = new Map<string, ModuleCallEdge>();

    for (const edge of symbolEdges) {
      const fromModule = defModuleMap.get(edge.fromId);
      const toModule = defModuleMap.get(edge.toId);

      if (!fromModule || !toModule) continue;
      if (fromModule.moduleId === toModule.moduleId) continue;

      const key = `${fromModule.moduleId}->${toModule.moduleId}`;
      const existing = edgeMap.get(key);

      if (existing) {
        existing.weight += edge.weight;
      } else {
        edgeMap.set(key, {
          fromModuleId: fromModule.moduleId,
          toModuleId: toModule.moduleId,
          weight: edge.weight,
          fromModulePath: fromModule.modulePath,
          toModulePath: toModule.modulePath,
        });
      }
    }

    return Array.from(edgeMap.values()).sort((a, b) => b.weight - a.weight);
  }

  /**
   * Get flow coverage statistics.
   */
  getCoverage(): FlowCoverageStats {
    ensureFlowsTables(this.db);
    ensureModulesTables(this.db);

    const moduleEdges = this.getModuleCallGraph();
    const totalModuleEdges = moduleEdges.length;

    const leafFlows = this.getLeaves();
    const coveredEdges = new Set<string>();

    for (const flow of leafFlows) {
      if (flow.fromModuleId && flow.toModuleId) {
        coveredEdges.add(`${flow.fromModuleId}->${flow.toModuleId}`);
      }
    }

    const coveredByFlows = coveredEdges.size;
    const percentage = totalModuleEdges > 0 ? (coveredByFlows / totalModuleEdges) * 100 : 0;

    return {
      totalModuleEdges,
      coveredByFlows,
      percentage,
    };
  }

  // Private helpers

  private updateDescendantPaths(parentId: number, parentPath: string, parentDepth: number): void {
    const children = this.getChildren(parentId);
    for (const child of children) {
      const newPath = `${parentPath}.${child.slug}`;
      const newDepth = parentDepth + 1;

      this.db.prepare(`
        UPDATE flows SET full_path = ?, depth = ? WHERE id = ?
      `).run(newPath, newDepth, child.id);

      this.updateDescendantPaths(child.id, newPath, newDepth);
    }
  }

  private getAllModules(): Module[] {
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
        created_at as createdAt
      FROM modules
      ORDER BY depth, full_path
    `);
    return stmt.all() as Module[];
  }

  private getCallGraph(): CallGraphEdge[] {
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
}
