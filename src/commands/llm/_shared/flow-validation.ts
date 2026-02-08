/**
 * Flow and interaction validation logic.
 */

import type { IndexDatabase } from '../../../db/database.js';
import type { Flow, Interaction, InteractionWithPaths } from '../../../db/schema.js';

// ============================================
// Validation Types
// ============================================

export interface ValidationOptions {
  maxSteps: number;  // Maximum steps per flow
}

export const DEFAULT_VALIDATION_OPTIONS: ValidationOptions = {
  maxSteps: 20,
};

export type FlowValidationErrorType =
  | 'invalid_entry_point'
  | 'invalid_interaction_id'
  | 'max_steps_exceeded'
  | 'duplicate_slug';

export interface FlowValidationError {
  type: FlowValidationErrorType;
  message: string;
  flowId?: number;
  flowName?: string;
}

export type FlowValidationWarningType =
  | 'no_steps'
  | 'missing_description';

export interface FlowValidationWarning {
  type: FlowValidationWarningType;
  message: string;
  severity: 'low' | 'medium' | 'high';
}

export interface FlowValidationResult {
  valid: boolean;
  errors: FlowValidationError[];
  warnings: FlowValidationWarning[];
}

// ============================================
// FlowValidator Class
// ============================================

export class FlowValidator {
  constructor(
    private db: IndexDatabase,
    private options: ValidationOptions = DEFAULT_VALIDATION_OPTIONS
  ) {}

  /**
   * Validate a single flow.
   */
  validateFlow(flow: Flow): FlowValidationResult {
    const errors: FlowValidationError[] = [];
    const warnings: FlowValidationWarning[] = [];

    // 1. Check if entry point is valid
    if (flow.entryPointId !== null) {
      const entryPoint = this.db.getDefinitionById(flow.entryPointId);
      if (!entryPoint) {
        errors.push({
          type: 'invalid_entry_point',
          message: `Entry point ID ${flow.entryPointId} does not exist`,
          flowId: flow.id,
          flowName: flow.name,
        });
      }
    }

    // 2. Check steps
    const steps = this.db.getFlowSteps(flow.id);

    if (steps.length === 0) {
      warnings.push({
        type: 'no_steps',
        message: `Flow "${flow.name}" has no interaction steps`,
        severity: 'medium',
      });
    }

    if (steps.length > this.options.maxSteps) {
      errors.push({
        type: 'max_steps_exceeded',
        message: `Flow has ${steps.length} steps, exceeds maximum ${this.options.maxSteps}`,
        flowId: flow.id,
        flowName: flow.name,
      });
    }

    // 3. Validate each step's interaction exists
    for (const step of steps) {
      const interaction = this.db.getInteractionById(step.interactionId);
      if (!interaction) {
        errors.push({
          type: 'invalid_interaction_id',
          message: `Step ${step.stepOrder} references non-existent interaction ${step.interactionId}`,
          flowId: flow.id,
          flowName: flow.name,
        });
      }
    }

    // 4. Check for missing description
    if (!flow.description) {
      warnings.push({
        type: 'missing_description',
        message: `Flow "${flow.name}" has no description`,
        severity: 'low',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate all flows in the database.
   */
  validateAllFlows(): Map<number, FlowValidationResult> {
    const flows = this.db.getAllFlows();
    const results = new Map<number, FlowValidationResult>();

    for (const flow of flows) {
      results.set(flow.id, this.validateFlow(flow));
    }

    return results;
  }

  /**
   * Find duplicate slugs.
   */
  findDuplicateSlugs(): Array<{ slug: string; flows: Flow[] }> {
    const flows = this.db.getAllFlows();
    const bySlug = new Map<string, Flow[]>();

    for (const flow of flows) {
      const list = bySlug.get(flow.slug) ?? [];
      list.push(flow);
      bySlug.set(flow.slug, list);
    }

    const duplicates: Array<{ slug: string; flows: Flow[] }> = [];
    for (const [slug, flowList] of bySlug) {
      if (flowList.length > 1) {
        duplicates.push({ slug, flows: flowList });
      }
    }

    return duplicates;
  }
}

// ============================================
// Interaction Validation
// ============================================

export interface InteractionValidationError {
  type: 'invalid_module_id';
  message: string;
  interactionId: number;
}

export function validateInteraction(
  db: IndexDatabase,
  interaction: Interaction
): InteractionValidationError[] {
  const errors: InteractionValidationError[] = [];

  const fromModule = db.getModuleById(interaction.fromModuleId);
  if (!fromModule) {
    errors.push({
      type: 'invalid_module_id',
      message: `From module ID ${interaction.fromModuleId} does not exist`,
      interactionId: interaction.id,
    });
  }

  const toModule = db.getModuleById(interaction.toModuleId);
  if (!toModule) {
    errors.push({
      type: 'invalid_module_id',
      message: `To module ID ${interaction.toModuleId} does not exist`,
      interactionId: interaction.id,
    });
  }

  return errors;
}

// ============================================
// Coverage Analysis
// ============================================

export interface CoverageGap {
  fromModuleId: number;
  toModuleId: number;
  fromModulePath: string;
  toModulePath: string;
  weight: number;
}

/**
 * Find interactions not covered by any flow.
 */
export function findUncoveredInteractions(db: IndexDatabase): InteractionWithPaths[] {
  return db.getUncoveredInteractions();
}

/**
 * Find module edges that don't have interactions.
 */
export function findMissingInteractions(db: IndexDatabase): CoverageGap[] {
  const moduleEdges = db.getModuleCallGraph();
  const interactions = db.getAllInteractions();

  // Build set of interaction edges
  const interactionEdges = new Set<string>();
  for (const interaction of interactions) {
    interactionEdges.add(`${interaction.fromModuleId}->${interaction.toModuleId}`);
  }

  // Find module edges without interactions
  const gaps: CoverageGap[] = [];
  for (const edge of moduleEdges) {
    const key = `${edge.fromModuleId}->${edge.toModuleId}`;
    if (!interactionEdges.has(key)) {
      gaps.push({
        fromModuleId: edge.fromModuleId,
        toModuleId: edge.toModuleId,
        fromModulePath: edge.fromModulePath,
        toModulePath: edge.toModulePath,
        weight: edge.weight,
      });
    }
  }

  // Sort by weight (most calls first)
  gaps.sort((a, b) => b.weight - a.weight);

  return gaps;
}
