/**
 * FlowFacade - Focused facade for flow and interaction operations.
 * Used by commands that work with user journey flows and module interactions.
 */

import type { IndexDatabase } from '../database-facade.js';
import type { FlowInsertOptions } from '../repositories/flow-repository.js';
import type { InteractionInsertOptions } from '../repositories/interaction-repository.js';
import type {
  CallGraphEdge,
  EnrichedModuleCallEdge,
  ExpandedFlow,
  Flow,
  FlowCoverageStats,
  FlowDefinitionStep,
  FlowStakeholder,
  FlowStep,
  FlowWithDefinitionSteps,
  FlowWithSteps,
  Interaction,
  InteractionSource,
  InteractionWithPaths,
  ModuleCallEdge,
  RelationshipCoverageBreakdown,
  RelationshipInteractionCoverage,
} from '../schema.js';

/**
 * Interface for flow and interaction operations.
 * Commands can depend on this interface instead of the full IndexDatabase.
 */
export interface IFlowFacade {
  // Flow lifecycle
  insertFlow(name: string, slug: string, options?: FlowInsertOptions): number;
  updateFlow(
    flowId: number,
    updates: {
      name?: string;
      entryPointModuleId?: number;
      entryPointId?: number;
      entryPath?: string;
      stakeholder?: FlowStakeholder;
      description?: string;
    }
  ): boolean;
  deleteFlow(flowId: number): boolean;
  clearFlows(): number;

  // Flow queries
  getFlowById(flowId: number): Flow | null;
  getFlowBySlug(slug: string): Flow | null;
  getAllFlows(): Flow[];
  getFlowsByStakeholder(stakeholder: FlowStakeholder): Flow[];
  getFlowsByEntryPoint(entryPointId: number): Flow[];
  getFlowsByEntryPointModule(entryPointModuleId: number): Flow[];
  getFlowCount(): number;
  getFlowStats(): ReturnType<IndexDatabase['flows']['getStats']>;

  // Flow steps (module-level)
  addFlowStep(flowId: number, interactionId: number, stepOrder?: number): void;
  addFlowSteps(flowId: number, interactionIds: number[]): void;
  getFlowSteps(flowId: number): FlowStep[];
  getFlowWithSteps(flowId: number): FlowWithSteps | null;
  clearFlowSteps(flowId: number): number;

  // Flow definition steps (definition-level)
  addFlowDefinitionStep(flowId: number, fromDefinitionId: number, toDefinitionId: number, stepOrder?: number): void;
  addFlowDefinitionSteps(flowId: number, steps: Array<{ fromDefinitionId: number; toDefinitionId: number }>): void;
  getFlowDefinitionSteps(flowId: number): FlowDefinitionStep[];
  getFlowWithDefinitionSteps(flowId: number): FlowWithDefinitionSteps | null;
  clearFlowDefinitionSteps(flowId: number): number;

  // Flow coverage
  expandFlow(flowId: number): ExpandedFlow | null;
  getFlowCoverage(): FlowCoverageStats;
  getFlowsWithInteraction(interactionId: number): Flow[];
  getUncoveredInteractions(): InteractionWithPaths[];

  // Interaction lifecycle
  insertInteraction(fromModuleId: number, toModuleId: number, options?: InteractionInsertOptions): number;
  upsertInteraction(fromModuleId: number, toModuleId: number, options?: InteractionInsertOptions): number;
  updateInteraction(
    id: number,
    updates: {
      direction?: 'uni' | 'bi';
      pattern?: 'utility' | 'business';
      symbols?: string[];
      semantic?: string;
    }
  ): boolean;
  deleteInteraction(id: number): boolean;
  clearInteractions(): number;

  // Interaction queries
  getInteractionById(id: number): Interaction | null;
  getInteractionByModules(fromModuleId: number, toModuleId: number): Interaction | null;
  getAllInteractions(): InteractionWithPaths[];
  getInteractionsByPattern(pattern: 'utility' | 'business'): InteractionWithPaths[];
  getInteractionsFromModule(moduleId: number): InteractionWithPaths[];
  getInteractionsToModule(moduleId: number): InteractionWithPaths[];
  getInteractionsBySource(source: InteractionSource): InteractionWithPaths[];
  getInteractionCount(): number;
  getInteractionStats(): ReturnType<IndexDatabase['interactions']['getStats']>;

  // Call graph operations
  getModuleCallGraph(): ModuleCallEdge[];
  getEnrichedModuleCallGraph(): EnrichedModuleCallEdge[];
  getDefinitionCallGraph(): CallGraphEdge[];
  getDefinitionCallGraphMap(): Map<number, number[]>;

  // Sync operations
  syncInteractionsFromCallGraph(): { created: number; updated: number };
  syncInheritanceInteractions(): { created: number };

  // Coverage
  getRelationshipCoverage(): RelationshipInteractionCoverage;
  getRelationshipCoverageBreakdown(): RelationshipCoverageBreakdown;
}

/**
 * FlowFacade implementation that wraps IndexDatabase.
 */
export class FlowFacade implements IFlowFacade {
  constructor(private readonly db: IndexDatabase) {}

  // Flow lifecycle
  insertFlow(name: string, slug: string, options?: FlowInsertOptions): number {
    return this.db.insertFlow(name, slug, options);
  }

  updateFlow(
    flowId: number,
    updates: {
      name?: string;
      entryPointModuleId?: number;
      entryPointId?: number;
      entryPath?: string;
      stakeholder?: FlowStakeholder;
      description?: string;
    }
  ): boolean {
    return this.db.updateFlow(flowId, updates);
  }

  deleteFlow(flowId: number): boolean {
    return this.db.deleteFlow(flowId);
  }

  clearFlows(): number {
    return this.db.clearFlows();
  }

  // Flow queries
  getFlowById(flowId: number): Flow | null {
    return this.db.getFlowById(flowId);
  }

  getFlowBySlug(slug: string): Flow | null {
    return this.db.getFlowBySlug(slug);
  }

  getAllFlows(): Flow[] {
    return this.db.getAllFlows();
  }

  getFlowsByStakeholder(stakeholder: FlowStakeholder): Flow[] {
    return this.db.getFlowsByStakeholder(stakeholder);
  }

  getFlowsByEntryPoint(entryPointId: number): Flow[] {
    return this.db.getFlowsByEntryPoint(entryPointId);
  }

  getFlowsByEntryPointModule(entryPointModuleId: number): Flow[] {
    return this.db.getFlowsByEntryPointModule(entryPointModuleId);
  }

  getFlowCount(): number {
    return this.db.getFlowCount();
  }

  getFlowStats() {
    return this.db.getFlowStats();
  }

  // Flow steps (module-level)
  addFlowStep(flowId: number, interactionId: number, stepOrder?: number): void {
    this.db.addFlowStep(flowId, interactionId, stepOrder);
  }

  addFlowSteps(flowId: number, interactionIds: number[]): void {
    this.db.addFlowSteps(flowId, interactionIds);
  }

  getFlowSteps(flowId: number): FlowStep[] {
    return this.db.getFlowSteps(flowId);
  }

  getFlowWithSteps(flowId: number): FlowWithSteps | null {
    return this.db.getFlowWithSteps(flowId);
  }

  clearFlowSteps(flowId: number): number {
    return this.db.clearFlowSteps(flowId);
  }

  // Flow definition steps (definition-level)
  addFlowDefinitionStep(flowId: number, fromDefinitionId: number, toDefinitionId: number, stepOrder?: number): void {
    this.db.addFlowDefinitionStep(flowId, fromDefinitionId, toDefinitionId, stepOrder);
  }

  addFlowDefinitionSteps(flowId: number, steps: Array<{ fromDefinitionId: number; toDefinitionId: number }>): void {
    this.db.addFlowDefinitionSteps(flowId, steps);
  }

  getFlowDefinitionSteps(flowId: number): FlowDefinitionStep[] {
    return this.db.getFlowDefinitionSteps(flowId);
  }

  getFlowWithDefinitionSteps(flowId: number): FlowWithDefinitionSteps | null {
    return this.db.getFlowWithDefinitionSteps(flowId);
  }

  clearFlowDefinitionSteps(flowId: number): number {
    return this.db.clearFlowDefinitionSteps(flowId);
  }

  // Flow coverage
  expandFlow(flowId: number): ExpandedFlow | null {
    return this.db.expandFlow(flowId);
  }

  getFlowCoverage(): FlowCoverageStats {
    return this.db.getFlowCoverage();
  }

  getFlowsWithInteraction(interactionId: number): Flow[] {
    return this.db.getFlowsWithInteraction(interactionId);
  }

  getUncoveredInteractions(): InteractionWithPaths[] {
    return this.db.getUncoveredInteractions();
  }

  // Interaction lifecycle
  insertInteraction(fromModuleId: number, toModuleId: number, options?: InteractionInsertOptions): number {
    return this.db.insertInteraction(fromModuleId, toModuleId, options);
  }

  upsertInteraction(fromModuleId: number, toModuleId: number, options?: InteractionInsertOptions): number {
    return this.db.upsertInteraction(fromModuleId, toModuleId, options);
  }

  updateInteraction(
    id: number,
    updates: {
      direction?: 'uni' | 'bi';
      pattern?: 'utility' | 'business';
      symbols?: string[];
      semantic?: string;
    }
  ): boolean {
    return this.db.updateInteraction(id, updates);
  }

  deleteInteraction(id: number): boolean {
    return this.db.deleteInteraction(id);
  }

  clearInteractions(): number {
    return this.db.clearInteractions();
  }

  // Interaction queries
  getInteractionById(id: number): Interaction | null {
    return this.db.getInteractionById(id);
  }

  getInteractionByModules(fromModuleId: number, toModuleId: number): Interaction | null {
    return this.db.getInteractionByModules(fromModuleId, toModuleId);
  }

  getAllInteractions(): InteractionWithPaths[] {
    return this.db.getAllInteractions();
  }

  getInteractionsByPattern(pattern: 'utility' | 'business'): InteractionWithPaths[] {
    return this.db.getInteractionsByPattern(pattern);
  }

  getInteractionsFromModule(moduleId: number): InteractionWithPaths[] {
    return this.db.getInteractionsFromModule(moduleId);
  }

  getInteractionsToModule(moduleId: number): InteractionWithPaths[] {
    return this.db.getInteractionsToModule(moduleId);
  }

  getInteractionsBySource(source: InteractionSource): InteractionWithPaths[] {
    return this.db.getInteractionsBySource(source);
  }

  getInteractionCount(): number {
    return this.db.getInteractionCount();
  }

  getInteractionStats() {
    return this.db.getInteractionStats();
  }

  // Call graph operations
  getModuleCallGraph(): ModuleCallEdge[] {
    return this.db.getModuleCallGraph();
  }

  getEnrichedModuleCallGraph(): EnrichedModuleCallEdge[] {
    return this.db.getEnrichedModuleCallGraph();
  }

  getDefinitionCallGraph(): CallGraphEdge[] {
    return this.db.getDefinitionCallGraph();
  }

  getDefinitionCallGraphMap(): Map<number, number[]> {
    return this.db.getDefinitionCallGraphMap();
  }

  // Sync operations
  syncInteractionsFromCallGraph(): { created: number; updated: number } {
    return this.db.syncInteractionsFromCallGraph();
  }

  syncInheritanceInteractions(): { created: number } {
    return this.db.syncInheritanceInteractions();
  }

  // Coverage
  getRelationshipCoverage(): RelationshipInteractionCoverage {
    return this.db.getRelationshipCoverage();
  }

  getRelationshipCoverageBreakdown(): RelationshipCoverageBreakdown {
    return this.db.getRelationshipCoverageBreakdown();
  }
}
