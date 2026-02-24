/**
 * This file re-exports from the refactored database modules for backward compatibility.
 * New code should import directly from the specific modules:
 * - src/db/connection.ts for connection management
 * - src/db/repositories/*.ts for specific repositories
 */

// Re-export the facade as IndexDatabase for backward compatibility
export { IndexDatabase } from './database-facade.js';

// Re-export types from schema
export {
  computeHash,
  type FileInsert,
  type CallsiteResult,
  type DependencyInfo,
  type ReadySymbolInfo,
  type DependencyWithMetadata,
  type IncomingDependency,
  type RelationshipType,
  type RelationshipAnnotation,
  type RelationshipWithDetails,
  type Domain,
  type DomainWithCount,
  type Module,
  type ModuleMember,
  type ModuleTreeNode,
  type ModuleWithMembers,
  type CallGraphEdge,
  type Interaction,
  type InteractionWithPaths,
  type Flow,
  type FlowStep,
  type FlowSubflowStep,
  type FlowWithSteps,
  type FlowStakeholder,
  type ModuleCallEdge,
  type EnrichedModuleCallEdge,
  type CalledSymbolInfo,
  type ExpandedFlow,
  type FlowCoverageStats,
  type AnnotatedSymbolInfo,
  type AnnotatedEdgeInfo,
  type EnhancedRelationshipContext,
  type IIndexWriter,
  SCHEMA,
} from './schema.js';
