/**
 * Flow validation logic with hierarchy support.
 */

import type { IndexDatabase } from '../../../db/database.js';
import type { ParsedFlow, ParsedFlowStep } from './flow-csv.js';

// ============================================
// Validation Types
// ============================================

export interface ValidationOptions {
  strictEdges: boolean;        // Require call graph edge between consecutive steps
  allowLayerSkip: boolean;     // Allow flows that skip architectural layers
  maxCompositionDepth: number; // Maximum depth of sub-flow nesting
  minStepCount: number;        // Minimum steps for a valid flow
}

export const DEFAULT_VALIDATION_OPTIONS: ValidationOptions = {
  strictEdges: true,
  allowLayerSkip: true,
  maxCompositionDepth: 3,
  minStepCount: 2,
};

export type FlowValidationErrorType =
  | 'invalid_definition_id'
  | 'invalid_subflow_reference'
  | 'missing_edge'
  | 'circular_reference'
  | 'max_depth_exceeded'
  | 'insufficient_steps'
  | 'duplicate_step'
  | 'missing_entry_point';

export interface FlowValidationError {
  type: FlowValidationErrorType;
  message: string;
  stepIndex?: number;
  id?: number;
  flowId?: number;
  flowName?: string;
  fromStep?: number;
  toStep?: number;
}

export type FlowValidationWarningType =
  | 'domain_mismatch'
  | 'layer_skip'
  | 'weak_connectivity'
  | 'orphaned_subflow';

export interface FlowValidationWarning {
  type: FlowValidationWarningType;
  message: string;
  severity: 'low' | 'medium' | 'high';
  stepIndex?: number;
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
  private pendingFlows: Map<string, ParsedFlow>;  // name -> flow (for batch validation)
  private flowNameToId: Map<string, number>;       // Existing flow names -> IDs

  constructor(
    private db: IndexDatabase,
    private options: ValidationOptions = DEFAULT_VALIDATION_OPTIONS
  ) {
    this.pendingFlows = new Map();
    this.flowNameToId = new Map();

    // Build map of existing flow names to IDs
    const existingFlows = db.getFlows();
    for (const flow of existingFlows) {
      this.flowNameToId.set(flow.name, flow.id);
    }
  }

  /**
   * Register a pending flow for batch validation (allows sub-flow references
   * to flows that will be created in the same batch).
   */
  registerPendingFlow(flow: ParsedFlow): void {
    this.pendingFlows.set(flow.name, flow);
  }

  /**
   * Clear pending flows after batch is committed.
   */
  clearPendingFlows(): void {
    this.pendingFlows.clear();
  }

  /**
   * Validate a single flow.
   */
  validateFlow(flow: ParsedFlow): FlowValidationResult {
    const errors: FlowValidationError[] = [];
    const warnings: FlowValidationWarning[] = [];

    // 1. Check minimum step count
    if (flow.steps.length < this.options.minStepCount) {
      errors.push({
        type: 'insufficient_steps',
        message: `Flow has ${flow.steps.length} steps, minimum is ${this.options.minStepCount}`,
      });
    }

    // 2. Check all definition IDs exist and track for duplicates
    const seenDefinitions = new Set<number>();
    for (const step of flow.steps) {
      if (step.type === 'definition') {
        if (step.id === undefined) {
          errors.push({
            type: 'invalid_definition_id',
            message: `Step ${step.order} is missing definition ID`,
            stepIndex: step.order,
          });
          continue;
        }

        const def = this.db.getDefinitionById(step.id);
        if (!def) {
          errors.push({
            type: 'invalid_definition_id',
            message: `Step ${step.order}: Definition ID ${step.id} does not exist`,
            stepIndex: step.order,
            id: step.id,
          });
        }

        if (seenDefinitions.has(step.id)) {
          errors.push({
            type: 'duplicate_step',
            message: `Step ${step.order}: Definition ID ${step.id} appears multiple times`,
            stepIndex: step.order,
            id: step.id,
          });
        }
        seenDefinitions.add(step.id);
      } else if (step.type === 'subflow') {
        // Check if subflow exists or is pending
        const flowName = step.flowName!;
        const existingId = this.flowNameToId.get(flowName);
        const isPending = this.pendingFlows.has(flowName);

        if (!existingId && !isPending) {
          errors.push({
            type: 'invalid_subflow_reference',
            message: `Step ${step.order}: Referenced sub-flow "${flowName}" does not exist`,
            stepIndex: step.order,
            flowName,
          });
        }
      }
    }

    // 3. Check edges between consecutive definition steps
    if (this.options.strictEdges && errors.length === 0) {
      for (let i = 0; i < flow.steps.length - 1; i++) {
        const fromDef = this.resolveToDefinitionId(flow.steps[i]);
        const toDef = this.resolveToDefinitionId(flow.steps[i + 1]);

        if (fromDef !== null && toDef !== null) {
          if (!this.db.edgeExists(fromDef, toDef)) {
            errors.push({
              type: 'missing_edge',
              message: `No call graph edge from step ${i + 1} to step ${i + 2}`,
              fromStep: i + 1,
              toStep: i + 2,
            });
          }
        }
      }
    }

    // 4. Check for circular flow references
    if (flow.isComposite) {
      const circularRef = this.detectCircularReference(flow);
      if (circularRef) {
        errors.push({
          type: 'circular_reference',
          message: `Circular reference detected: ${circularRef}`,
        });
      }
    }

    // 5. Check composition depth limit
    const depth = this.getCompositionDepth(flow);
    if (depth > this.options.maxCompositionDepth) {
      errors.push({
        type: 'max_depth_exceeded',
        message: `Composition depth ${depth} exceeds maximum ${this.options.maxCompositionDepth}`,
      });
    }

    // 6. Semantic warnings
    const domainWarning = this.checkDomainCoherence(flow);
    if (domainWarning) {
      warnings.push(domainWarning);
    }

    if (!this.options.allowLayerSkip) {
      const layerWarning = this.detectLayerSkip(flow);
      if (layerWarning) {
        warnings.push(layerWarning);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a batch of flows together.
   */
  validateBatch(flows: ParsedFlow[]): Map<number, FlowValidationResult> {
    // Register all flows as pending
    for (const flow of flows) {
      this.registerPendingFlow(flow);
    }

    const results = new Map<number, FlowValidationResult>();
    for (const flow of flows) {
      results.set(flow.id, this.validateFlow(flow));
    }

    this.clearPendingFlows();
    return results;
  }

  /**
   * Resolve a flow step to its entry definition ID.
   */
  private resolveToDefinitionId(step: ParsedFlowStep): number | null {
    if (step.type === 'definition') {
      return step.id ?? null;
    }

    if (step.type === 'subflow' && step.flowName) {
      // Check pending flows first
      const pendingFlow = this.pendingFlows.get(step.flowName);
      if (pendingFlow && pendingFlow.steps.length > 0) {
        const firstStep = pendingFlow.steps[0];
        if (firstStep.type === 'definition') {
          return firstStep.id ?? null;
        }
      }

      // Check existing flows
      const flowId = this.flowNameToId.get(step.flowName);
      if (flowId) {
        const flow = this.db.getFlowById(flowId);
        return flow?.entryPointId ?? null;
      }
    }

    return null;
  }

  /**
   * Detect circular references in flow compositions.
   */
  private detectCircularReference(flow: ParsedFlow, visited: Set<string> = new Set()): string | null {
    if (visited.has(flow.name)) {
      return flow.name;
    }

    visited.add(flow.name);

    for (const step of flow.steps) {
      if (step.type === 'subflow' && step.flowName) {
        // Check pending flows
        const pendingFlow = this.pendingFlows.get(step.flowName);
        if (pendingFlow) {
          const circular = this.detectCircularReference(pendingFlow, new Set(visited));
          if (circular) {
            return `${flow.name} -> ${circular}`;
          }
        }

        // Check existing flows
        const flowId = this.flowNameToId.get(step.flowName);
        if (flowId && this.db.isCircularReference(flow.id, flowId)) {
          return `${flow.name} -> ${step.flowName}`;
        }
      }
    }

    return null;
  }

  /**
   * Get the maximum composition depth of a flow.
   */
  private getCompositionDepth(flow: ParsedFlow, visited: Set<string> = new Set()): number {
    if (!flow.isComposite || visited.has(flow.name)) {
      return 0;
    }

    visited.add(flow.name);
    let maxDepth = 0;

    for (const step of flow.steps) {
      if (step.type === 'subflow' && step.flowName) {
        let childDepth = 0;

        // Check pending flows first
        const pendingFlow = this.pendingFlows.get(step.flowName);
        if (pendingFlow) {
          childDepth = this.getCompositionDepth(pendingFlow, new Set(visited));
        } else {
          // Check existing flows
          const flowId = this.flowNameToId.get(step.flowName);
          if (flowId) {
            childDepth = this.db.getFlowCompositionDepth(flowId);
          }
        }

        maxDepth = Math.max(maxDepth, childDepth);
      }
    }

    return 1 + maxDepth;
  }

  /**
   * Check domain coherence across flow steps.
   */
  private checkDomainCoherence(flow: ParsedFlow): FlowValidationWarning | null {
    const domainCounts = new Map<string, number>();
    let stepsWithDomains = 0;

    for (const step of flow.steps) {
      if (step.type !== 'definition' || !step.id) continue;

      const metadata = this.db.getDefinitionMetadata(step.id);
      if (metadata['domain']) {
        try {
          const domains = JSON.parse(metadata['domain']) as string[];
          for (const domain of domains) {
            domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
          }
          stepsWithDomains++;
        } catch { /* ignore */ }
      }
    }

    if (stepsWithDomains < 2) return null;

    // Check if there's significant domain fragmentation
    const totalDomains = domainCounts.size;
    const avgDomainCoverage = stepsWithDomains / totalDomains;

    if (totalDomains > 3 && avgDomainCoverage < 0.5) {
      return {
        type: 'domain_mismatch',
        message: `Flow spans ${totalDomains} different domains, may lack coherence`,
        severity: 'medium',
      };
    }

    return null;
  }

  /**
   * Detect layer skips in the flow.
   */
  private detectLayerSkip(_flow: ParsedFlow): FlowValidationWarning | null {
    // Layer skip detection is no longer applicable since modules
    // no longer have layer information in the tree structure
    return null;
  }
}

// ============================================
// Overlap Detection
// ============================================

export interface OverlapResult {
  type: 'unique' | 'duplicate' | 'partial_overlap';
  overlapRatio: number;
  sharedSteps: number[];
  suggestion: 'persist' | 'skip' | 'extract_subflow';
  existingFlowId?: number;
  existingFlowName?: string;
}

/**
 * Calculate overlap between a new flow and existing flows.
 */
export function calculateOverlap(
  newSteps: ParsedFlowStep[],
  existingSteps: Array<{ definitionId: number; stepOrder: number }>
): { ratio: number; sharedSteps: number[] } {
  const newDefIds = new Set(
    newSteps
      .filter(s => s.type === 'definition' && s.id !== undefined)
      .map(s => s.id!)
  );

  const existingDefIds = new Set(existingSteps.map(s => s.definitionId));

  const shared: number[] = [];
  for (const id of newDefIds) {
    if (existingDefIds.has(id)) {
      shared.push(id);
    }
  }

  const ratio = newDefIds.size > 0
    ? shared.length / newDefIds.size
    : 0;

  return { ratio, sharedSteps: shared };
}

/**
 * Detect overlap with existing flows and suggest action.
 */
export function detectAndSuggestOverlapAction(
  newFlow: ParsedFlow,
  db: IndexDatabase
): OverlapResult {
  const existingFlows = db.getAllFlowsWithSteps();

  for (const existing of existingFlows) {
    const { ratio, sharedSteps } = calculateOverlap(newFlow.steps, existing.steps);

    if (ratio > 0.8) {
      return {
        type: 'duplicate',
        overlapRatio: ratio,
        sharedSteps,
        suggestion: 'skip',
        existingFlowId: existing.id,
        existingFlowName: existing.name,
      };
    }

    if (ratio > 0.5 && sharedSteps.length >= 3) {
      return {
        type: 'partial_overlap',
        overlapRatio: ratio,
        sharedSteps,
        suggestion: 'extract_subflow',
        existingFlowId: existing.id,
        existingFlowName: existing.name,
      };
    }
  }

  return {
    type: 'unique',
    overlapRatio: 0,
    sharedSteps: [],
    suggestion: 'persist',
  };
}
