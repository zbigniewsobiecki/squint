/**
 * Flow validation logic for hierarchical module-level flows.
 */

import type { IndexDatabase } from '../../../db/database.js';
import type { Flow } from '../../../db/schema.js';

// ============================================
// Validation Types
// ============================================

export interface ValidationOptions {
  maxDepth: number;  // Maximum depth of flow hierarchy
}

export const DEFAULT_VALIDATION_OPTIONS: ValidationOptions = {
  maxDepth: 5,
};

export type FlowValidationErrorType =
  | 'invalid_module_id'
  | 'circular_reference'
  | 'max_depth_exceeded'
  | 'duplicate_slug';

export interface FlowValidationError {
  type: FlowValidationErrorType;
  message: string;
  flowId?: number;
  flowName?: string;
}

export type FlowValidationWarningType =
  | 'orphaned_flow'
  | 'uncovered_edge';

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

    // 1. Check if module IDs are valid for leaf flows
    if (flow.fromModuleId !== null && flow.toModuleId !== null) {
      const fromModule = this.db.getModuleById(flow.fromModuleId);
      const toModule = this.db.getModuleById(flow.toModuleId);

      if (!fromModule) {
        errors.push({
          type: 'invalid_module_id',
          message: `From module ID ${flow.fromModuleId} does not exist`,
          flowId: flow.id,
          flowName: flow.name,
        });
      }

      if (!toModule) {
        errors.push({
          type: 'invalid_module_id',
          message: `To module ID ${flow.toModuleId} does not exist`,
          flowId: flow.id,
          flowName: flow.name,
        });
      }
    }

    // 2. Check depth limit
    if (flow.depth > this.options.maxDepth) {
      errors.push({
        type: 'max_depth_exceeded',
        message: `Flow depth ${flow.depth} exceeds maximum ${this.options.maxDepth}`,
        flowId: flow.id,
        flowName: flow.name,
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
   * Check for orphaned flows (flows with no parent that aren't root).
   */
  findOrphanedFlows(): Flow[] {
    const flows = this.db.getAllFlows();
    const flowIds = new Set(flows.map(f => f.id));

    return flows.filter(f =>
      f.parentId !== null && !flowIds.has(f.parentId)
    );
  }
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
 * Find module edges not covered by any flow.
 */
export function findUncoveredEdges(db: IndexDatabase): CoverageGap[] {
  const moduleEdges = db.getModuleCallGraph();
  const leafFlows = db.getLeafFlows();

  // Build set of covered edges
  const coveredEdges = new Set<string>();
  for (const flow of leafFlows) {
    if (flow.fromModuleId && flow.toModuleId) {
      coveredEdges.add(`${flow.fromModuleId}->${flow.toModuleId}`);
    }
  }

  // Find uncovered edges
  const gaps: CoverageGap[] = [];
  for (const edge of moduleEdges) {
    const key = `${edge.fromModuleId}->${edge.toModuleId}`;
    if (!coveredEdges.has(key)) {
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
