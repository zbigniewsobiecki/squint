import type Database from 'better-sqlite3';
import { ensureFlowsTables, ensureInteractionsTables, ensureModulesTables } from '../schema-manager.js';
import type {
  ExpandedFlow,
  Flow,
  FlowCoverageStats,
  FlowDefinitionStep,
  FlowDefinitionStepWithDetails,
  FlowStakeholder,
  FlowStep,
  FlowSubflowStep,
  FlowWithDefinitionSteps,
  FlowWithSteps,
  InteractionWithPaths,
} from '../schema.js';

export interface FlowInsertOptions {
  entryPointModuleId?: number;
  entryPointId?: number;
  entryPath?: string;
  stakeholder?: FlowStakeholder;
  description?: string;
  actionType?: string;
  targetEntity?: string;
  tier?: number;
}

export interface FlowUpdateOptions {
  name?: string;
  entryPointModuleId?: number;
  entryPointId?: number;
  entryPath?: string;
  stakeholder?: FlowStakeholder;
  description?: string;
  actionType?: string;
  targetEntity?: string;
}

export interface FlowStats {
  flowCount: number;
  withEntryPointCount: number;
  byStakeholder: Record<string, number>;
  avgStepsPerFlow: number;
}

const FLOW_COLS = `
  id,
  name,
  slug,
  entry_point_module_id as entryPointModuleId,
  entry_point_id as entryPointId,
  entry_path as entryPath,
  stakeholder,
  description,
  action_type as actionType,
  target_entity as targetEntity,
  tier,
  created_at as createdAt`;

/**
 * Repository for flow (user journey) operations.
 */
export class FlowRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert a new flow.
   */
  insert(name: string, slug: string, options?: FlowInsertOptions): number {
    ensureFlowsTables(this.db);

    const stmt = this.db.prepare(`
      INSERT INTO flows (name, slug, entry_point_module_id, entry_point_id, entry_path, stakeholder, description, action_type, target_entity, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name,
      slug,
      options?.entryPointModuleId ?? null,
      options?.entryPointId ?? null,
      options?.entryPath ?? null,
      options?.stakeholder ?? null,
      options?.description ?? null,
      options?.actionType ?? null,
      options?.targetEntity ?? null,
      options?.tier ?? 0
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get flow by ID.
   */
  getById(id: number): Flow | null {
    ensureFlowsTables(this.db);
    const row = this.db.prepare(`SELECT ${FLOW_COLS} FROM flows WHERE id = ?`).get(id) as Flow | undefined;
    return row ?? null;
  }

  /**
   * Get flow by slug.
   */
  getBySlug(slug: string): Flow | null {
    ensureFlowsTables(this.db);
    const row = this.db.prepare(`SELECT ${FLOW_COLS} FROM flows WHERE slug = ?`).get(slug) as Flow | undefined;
    return row ?? null;
  }

  /**
   * Get all flows.
   */
  getAll(): Flow[] {
    ensureFlowsTables(this.db);
    return this.db.prepare(`SELECT ${FLOW_COLS} FROM flows ORDER BY name`).all() as Flow[];
  }

  /**
   * Get flows by stakeholder.
   */
  getByStakeholder(stakeholder: FlowStakeholder): Flow[] {
    ensureFlowsTables(this.db);
    return this.db
      .prepare(`SELECT ${FLOW_COLS} FROM flows WHERE stakeholder = ? ORDER BY name`)
      .all(stakeholder) as Flow[];
  }

  /**
   * Get flows by entry point definition ID.
   */
  getByEntryPoint(entryPointId: number): Flow[] {
    ensureFlowsTables(this.db);
    return this.db
      .prepare(`SELECT ${FLOW_COLS} FROM flows WHERE entry_point_id = ? ORDER BY name`)
      .all(entryPointId) as Flow[];
  }

  /**
   * Get flows by entry point module ID.
   */
  getByEntryPointModule(entryPointModuleId: number): Flow[] {
    ensureFlowsTables(this.db);
    return this.db
      .prepare(`SELECT ${FLOW_COLS} FROM flows WHERE entry_point_module_id = ? ORDER BY name`)
      .all(entryPointModuleId) as Flow[];
  }

  /**
   * Get flow with all its steps and interaction details.
   */
  getWithSteps(flowId: number): FlowWithSteps | null {
    ensureFlowsTables(this.db);
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const flow = this.getById(flowId);
    if (!flow) return null;

    const stepsStmt = this.db.prepare(`
      SELECT
        fs.flow_id as flowId,
        fs.step_order as stepOrder,
        fs.interaction_id as interactionId,
        i.id,
        i.from_module_id as fromModuleId,
        i.to_module_id as toModuleId,
        i.direction,
        i.weight,
        i.pattern,
        i.symbols,
        i.semantic,
        i.created_at as createdAt,
        from_m.full_path as fromModulePath,
        to_m.full_path as toModulePath
      FROM flow_steps fs
      JOIN interactions i ON fs.interaction_id = i.id
      JOIN modules from_m ON i.from_module_id = from_m.id
      JOIN modules to_m ON i.to_module_id = to_m.id
      WHERE fs.flow_id = ?
      ORDER BY fs.step_order
    `);

    const stepsRaw = stepsStmt.all(flowId) as Array<FlowStep & InteractionWithPaths>;

    const steps = stepsRaw.map((row) => ({
      flowId: row.flowId,
      stepOrder: row.stepOrder,
      interactionId: row.interactionId,
      interaction: {
        id: row.id,
        fromModuleId: row.fromModuleId,
        toModuleId: row.toModuleId,
        direction: row.direction,
        weight: row.weight,
        pattern: row.pattern,
        symbols: row.symbols,
        semantic: row.semantic,
        createdAt: row.createdAt,
        fromModulePath: row.fromModulePath,
        toModulePath: row.toModulePath,
      } as InteractionWithPaths,
    }));

    return {
      ...flow,
      steps,
    };
  }

  /**
   * Update a flow.
   */
  update(flowId: number, updates: FlowUpdateOptions): boolean {
    ensureFlowsTables(this.db);

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      params.push(updates.name);
    }
    if (updates.entryPointModuleId !== undefined) {
      sets.push('entry_point_module_id = ?');
      params.push(updates.entryPointModuleId);
    }
    if (updates.entryPointId !== undefined) {
      sets.push('entry_point_id = ?');
      params.push(updates.entryPointId);
    }
    if (updates.entryPath !== undefined) {
      sets.push('entry_path = ?');
      params.push(updates.entryPath);
    }
    if (updates.stakeholder !== undefined) {
      sets.push('stakeholder = ?');
      params.push(updates.stakeholder);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description);
    }
    if (updates.actionType !== undefined) {
      sets.push('action_type = ?');
      params.push(updates.actionType);
    }
    if (updates.targetEntity !== undefined) {
      sets.push('target_entity = ?');
      params.push(updates.targetEntity);
    }

    if (sets.length === 0) return false;

    params.push(flowId);
    const stmt = this.db.prepare(`UPDATE flows SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Delete a flow (cascade deletes steps).
   */
  delete(flowId: number): boolean {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM flows WHERE id = ?');
    const result = stmt.run(flowId);
    return result.changes > 0;
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

  // ============================================================
  // Flow Steps Operations
  // ============================================================

  /**
   * Add a step to a flow.
   */
  addStep(flowId: number, interactionId: number, stepOrder?: number): void {
    ensureFlowsTables(this.db);

    // Auto-calculate step_order if not provided
    let order = stepOrder;
    if (order === undefined) {
      const maxOrder = this.db
        .prepare(`
        SELECT COALESCE(MAX(step_order), 0) as max FROM flow_steps WHERE flow_id = ?
      `)
        .get(flowId) as { max: number };
      order = maxOrder.max + 1;
    }

    const stmt = this.db.prepare(`
      INSERT INTO flow_steps (flow_id, step_order, interaction_id)
      VALUES (?, ?, ?)
    `);
    stmt.run(flowId, order, interactionId);
  }

  /**
   * Add multiple steps to a flow in order.
   */
  addSteps(flowId: number, interactionIds: number[]): void {
    ensureFlowsTables(this.db);

    const stmt = this.db.prepare(`
      INSERT INTO flow_steps (flow_id, step_order, interaction_id)
      VALUES (?, ?, ?)
    `);

    for (let i = 0; i < interactionIds.length; i++) {
      stmt.run(flowId, i + 1, interactionIds[i]);
    }
  }

  /**
   * Remove a step from a flow.
   */
  removeStep(flowId: number, stepOrder: number): boolean {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM flow_steps WHERE flow_id = ? AND step_order = ?');
    const result = stmt.run(flowId, stepOrder);
    return result.changes > 0;
  }

  /**
   * Clear all steps from a flow.
   */
  clearSteps(flowId: number): number {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM flow_steps WHERE flow_id = ?');
    const result = stmt.run(flowId);
    return result.changes;
  }

  /**
   * Get steps for a flow.
   */
  getSteps(flowId: number): FlowStep[] {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        flow_id as flowId,
        step_order as stepOrder,
        interaction_id as interactionId
      FROM flow_steps
      WHERE flow_id = ?
      ORDER BY step_order
    `);
    return stmt.all(flowId) as FlowStep[];
  }

  /**
   * Reorder steps in a flow.
   */
  reorderSteps(flowId: number, interactionIds: number[]): void {
    ensureFlowsTables(this.db);

    // Clear existing steps
    this.clearSteps(flowId);

    // Add new steps in order
    this.addSteps(flowId, interactionIds);
  }

  // ============================================================
  // Flow Definition Steps Operations (definition-level tracing)
  // ============================================================

  /**
   * Add a definition-level step to a flow.
   */
  addDefinitionStep(flowId: number, fromDefinitionId: number, toDefinitionId: number, stepOrder?: number): void {
    ensureFlowsTables(this.db);

    // Auto-calculate step_order if not provided
    let order = stepOrder;
    if (order === undefined) {
      const maxOrder = this.db
        .prepare(`
        SELECT COALESCE(MAX(step_order), 0) as max FROM flow_definition_steps WHERE flow_id = ?
      `)
        .get(flowId) as { max: number };
      order = maxOrder.max + 1;
    }

    const stmt = this.db.prepare(`
      INSERT INTO flow_definition_steps (flow_id, step_order, from_definition_id, to_definition_id)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(flowId, order, fromDefinitionId, toDefinitionId);
  }

  /**
   * Add multiple definition-level steps to a flow in order.
   */
  addDefinitionSteps(flowId: number, steps: Array<{ fromDefinitionId: number; toDefinitionId: number }>): void {
    ensureFlowsTables(this.db);

    const stmt = this.db.prepare(`
      INSERT INTO flow_definition_steps (flow_id, step_order, from_definition_id, to_definition_id)
      VALUES (?, ?, ?, ?)
    `);

    for (let i = 0; i < steps.length; i++) {
      stmt.run(flowId, i + 1, steps[i].fromDefinitionId, steps[i].toDefinitionId);
    }
  }

  /**
   * Clear all definition-level steps from a flow.
   */
  clearDefinitionSteps(flowId: number): number {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM flow_definition_steps WHERE flow_id = ?');
    const result = stmt.run(flowId);
    return result.changes;
  }

  /**
   * Get definition-level steps for a flow.
   */
  getDefinitionSteps(flowId: number): FlowDefinitionStep[] {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        flow_id as flowId,
        step_order as stepOrder,
        from_definition_id as fromDefinitionId,
        to_definition_id as toDefinitionId
      FROM flow_definition_steps
      WHERE flow_id = ?
      ORDER BY step_order
    `);
    return stmt.all(flowId) as FlowDefinitionStep[];
  }

  /**
   * Get flow with all its definition-level steps and details.
   */
  getWithDefinitionSteps(flowId: number): FlowWithDefinitionSteps | null {
    ensureFlowsTables(this.db);

    const flow = this.getById(flowId);
    if (!flow) return null;

    const stepsStmt = this.db.prepare(`
      SELECT
        fds.flow_id as flowId,
        fds.step_order as stepOrder,
        fds.from_definition_id as fromDefinitionId,
        fds.to_definition_id as toDefinitionId,
        from_d.name as fromDefinitionName,
        from_d.kind as fromDefinitionKind,
        from_f.path as fromFilePath,
        from_d.line as fromLine,
        from_mm.module_id as fromModuleId,
        from_m.full_path as fromModulePath,
        to_d.name as toDefinitionName,
        to_d.kind as toDefinitionKind,
        to_f.path as toFilePath,
        to_d.line as toLine,
        to_mm.module_id as toModuleId,
        to_m.full_path as toModulePath,
        ra.semantic as semantic
      FROM flow_definition_steps fds
      JOIN definitions from_d ON fds.from_definition_id = from_d.id
      JOIN files from_f ON from_d.file_id = from_f.id
      JOIN definitions to_d ON fds.to_definition_id = to_d.id
      JOIN files to_f ON to_d.file_id = to_f.id
      LEFT JOIN module_members from_mm ON from_d.id = from_mm.definition_id
      LEFT JOIN modules from_m ON from_mm.module_id = from_m.id
      LEFT JOIN module_members to_mm ON to_d.id = to_mm.definition_id
      LEFT JOIN modules to_m ON to_mm.module_id = to_m.id
      LEFT JOIN relationship_annotations ra ON ra.from_definition_id = fds.from_definition_id AND ra.to_definition_id = fds.to_definition_id
      WHERE fds.flow_id = ?
      ORDER BY fds.step_order
    `);

    const definitionSteps = stepsStmt.all(flowId) as FlowDefinitionStepWithDetails[];

    return {
      ...flow,
      definitionSteps,
    };
  }

  /**
   * Get count of definition-level steps for a flow.
   */
  getDefinitionStepCount(flowId: number): number {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM flow_definition_steps WHERE flow_id = ?');
    const row = stmt.get(flowId) as { count: number };
    return row.count;
  }

  // ============================================================
  // Flow Subflow Steps Operations (composite flow references)
  // ============================================================

  /**
   * Add subflow step references to a composite flow.
   */
  addSubflowSteps(flowId: number, subflowIds: number[]): void {
    ensureFlowsTables(this.db);

    const stmt = this.db.prepare(`
      INSERT INTO flow_subflow_steps (flow_id, step_order, subflow_id)
      VALUES (?, ?, ?)
    `);

    for (let i = 0; i < subflowIds.length; i++) {
      stmt.run(flowId, i + 1, subflowIds[i]);
    }
  }

  /**
   * Get subflow steps for a composite flow.
   */
  getSubflowSteps(flowId: number): FlowSubflowStep[] {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare(`
      SELECT
        flow_id as flowId,
        step_order as stepOrder,
        subflow_id as subflowId
      FROM flow_subflow_steps
      WHERE flow_id = ?
      ORDER BY step_order
    `);
    return stmt.all(flowId) as FlowSubflowStep[];
  }

  /**
   * Clear all subflow steps from a flow.
   */
  clearSubflowSteps(flowId: number): number {
    ensureFlowsTables(this.db);
    const stmt = this.db.prepare('DELETE FROM flow_subflow_steps WHERE flow_id = ?');
    const result = stmt.run(flowId);
    return result.changes;
  }

  /**
   * Get flows by tier.
   */
  getByTier(tier: number): Flow[] {
    ensureFlowsTables(this.db);
    return this.db.prepare(`SELECT ${FLOW_COLS} FROM flows WHERE tier = ? ORDER BY name`).all(tier) as Flow[];
  }

  // ============================================================
  // Expansion and Statistics
  // ============================================================

  /**
   * Expand a flow to its ordered list of interactions.
   */
  expand(flowId: number): ExpandedFlow | null {
    const flowWithSteps = this.getWithSteps(flowId);
    if (!flowWithSteps) return null;

    return {
      flow: {
        id: flowWithSteps.id,
        name: flowWithSteps.name,
        slug: flowWithSteps.slug,
        entryPointModuleId: flowWithSteps.entryPointModuleId,
        entryPointId: flowWithSteps.entryPointId,
        entryPath: flowWithSteps.entryPath,
        stakeholder: flowWithSteps.stakeholder,
        description: flowWithSteps.description,
        actionType: flowWithSteps.actionType,
        targetEntity: flowWithSteps.targetEntity,
        tier: flowWithSteps.tier,
        createdAt: flowWithSteps.createdAt,
      },
      interactions: flowWithSteps.steps.map((s) => s.interaction),
    };
  }

  /**
   * Get flow statistics.
   */
  getStats(): FlowStats {
    ensureFlowsTables(this.db);

    const flowCount = this.getCount();

    const withEntryStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM flows WHERE entry_point_module_id IS NOT NULL
    `);
    const withEntryPointCount = (withEntryStmt.get() as { count: number }).count;

    const stakeholderStmt = this.db.prepare(`
      SELECT stakeholder, COUNT(*) as count FROM flows
      WHERE stakeholder IS NOT NULL
      GROUP BY stakeholder
    `);
    const stakeholderRows = stakeholderStmt.all() as Array<{ stakeholder: string; count: number }>;
    const byStakeholder: Record<string, number> = {};
    for (const row of stakeholderRows) {
      byStakeholder[row.stakeholder] = row.count;
    }

    const avgStepsStmt = this.db.prepare(`
      SELECT AVG(step_count) as avg FROM (
        SELECT COUNT(*) as step_count FROM flow_steps GROUP BY flow_id
      )
    `);
    const avgRow = avgStepsStmt.get() as { avg: number | null };
    const avgStepsPerFlow = avgRow.avg ?? 0;

    return {
      flowCount,
      withEntryPointCount,
      byStakeholder,
      avgStepsPerFlow,
    };
  }

  /**
   * Get flow coverage statistics.
   * Shows how many interactions are covered by flows.
   */
  getCoverage(): FlowCoverageStats {
    ensureFlowsTables(this.db);
    ensureInteractionsTables(this.db);

    // Exclude test-internal interactions from the total
    const totalStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM interactions WHERE pattern IS NULL OR pattern != 'test-internal'"
    );
    const totalInteractions = (totalStmt.get() as { count: number }).count;

    const coveredStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT fs.interaction_id) as count
      FROM flow_steps fs
      JOIN interactions i ON fs.interaction_id = i.id
      WHERE i.pattern IS NULL OR i.pattern != 'test-internal'
    `);
    const coveredByFlows = (coveredStmt.get() as { count: number }).count;

    const percentage = totalInteractions > 0 ? (coveredByFlows / totalInteractions) * 100 : 0;

    return {
      totalInteractions,
      coveredByFlows,
      percentage,
    };
  }

  /**
   * Get flows that include a specific interaction.
   */
  getFlowsWithInteraction(interactionId: number): Flow[] {
    ensureFlowsTables(this.db);
    return this.db
      .prepare(
        `SELECT DISTINCT
          f.id, f.name, f.slug,
          f.entry_point_module_id as entryPointModuleId,
          f.entry_point_id as entryPointId,
          f.entry_path as entryPath,
          f.stakeholder, f.description,
          f.action_type as actionType,
          f.target_entity as targetEntity,
          f.tier,
          f.created_at as createdAt
        FROM flows f
        JOIN flow_steps fs ON f.id = fs.flow_id
        WHERE fs.interaction_id = ?
        ORDER BY f.name`
      )
      .all(interactionId) as Flow[];
  }

  /**
   * Get flows that involve a specific definition (as from or to in definition steps).
   */
  getFlowsWithDefinition(definitionId: number): Flow[] {
    ensureFlowsTables(this.db);
    return this.db
      .prepare(
        `SELECT DISTINCT
          f.id, f.name, f.slug,
          f.entry_point_module_id as entryPointModuleId,
          f.entry_point_id as entryPointId,
          f.entry_path as entryPath,
          f.stakeholder, f.description,
          f.action_type as actionType,
          f.target_entity as targetEntity,
          f.tier,
          f.created_at as createdAt
        FROM flows f
        JOIN flow_definition_steps fds ON f.id = fds.flow_id
        WHERE fds.from_definition_id = ? OR fds.to_definition_id = ?
        ORDER BY f.name`
      )
      .all(definitionId, definitionId) as Flow[];
  }

  /**
   * Get uncovered interactions (not part of any flow).
   */
  getUncoveredInteractions(): InteractionWithPaths[] {
    ensureFlowsTables(this.db);
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        i.id,
        i.from_module_id as fromModuleId,
        i.to_module_id as toModuleId,
        i.direction,
        i.weight,
        i.pattern,
        i.symbols,
        i.semantic,
        i.created_at as createdAt,
        from_m.full_path as fromModulePath,
        to_m.full_path as toModulePath
      FROM interactions i
      JOIN modules from_m ON i.from_module_id = from_m.id
      JOIN modules to_m ON i.to_module_id = to_m.id
      WHERE i.id NOT IN (SELECT DISTINCT interaction_id FROM flow_steps)
      ORDER BY i.weight DESC
    `);

    return stmt.all() as InteractionWithPaths[];
  }
}
