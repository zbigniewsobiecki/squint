import { createHash } from 'node:crypto';
import type { Definition } from '../parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../parser/reference-extractor.js';
import { generateSchemaDDL } from './schema-registry.js';

// ============================================================
// Interfaces for database operations
// ============================================================

export interface FileInsert {
  path: string;
  language: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface CallsiteResult {
  usageId: number;
  symbolId: number;
  definitionId: number | null;
  filePath: string;
  line: number;
  column: number;
  symbolName: string;
  localName: string;
  argumentCount: number;
  isMethodCall: boolean;
  isConstructorCall: boolean;
  receiverName: string | null;
}

export interface DependencyInfo {
  dependencyId: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface ReadySymbolInfo {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  dependencyCount: number;
}

export interface DependencyWithMetadata {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  hasAspect: boolean;
  aspectValue: string | null;
}

export interface IncomingDependency {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

export type RelationshipType = 'uses' | 'extends' | 'implements';

export interface RelationshipAnnotation {
  id: number;
  fromDefinitionId: number;
  toDefinitionId: number;
  relationshipType: RelationshipType;
  semantic: string;
  createdAt: string;
}

export interface RelationshipWithDetails {
  id: number;
  fromDefinitionId: number;
  fromName: string;
  fromKind: string;
  fromFilePath: string;
  fromLine: number;
  toDefinitionId: number;
  toName: string;
  toKind: string;
  toFilePath: string;
  toLine: number;
  relationshipType: RelationshipType;
  semantic: string;
}

export interface Domain {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface DomainWithCount extends Domain {
  symbolCount: number;
}

// ============================================================
// Contract Types (Cross-Process Communication Channels)
// ============================================================

export interface Contract {
  id: number;
  protocol: string;
  key: string;
  normalizedKey: string;
  description: string | null;
  createdAt: string;
}

export interface ContractParticipant {
  id: number;
  contractId: number;
  definitionId: number;
  moduleId: number | null;
  role: string;
}

export interface ContractWithParticipants extends Contract {
  participants: ContractParticipant[];
}

export interface InteractionDefinitionLink {
  interactionId: number;
  fromDefinitionId: number;
  toDefinitionId: number;
  contractId: number;
}

// ============================================================
// Module Tree Types
// ============================================================

export interface Module {
  id: number;
  parentId: number | null;
  slug: string;
  fullPath: string;
  name: string;
  description: string | null;
  depth: number;
  colorIndex: number;
  isTest: boolean;
  createdAt: string;
}

export interface ModuleMember {
  moduleId: number;
  definitionId: number;
  assignedAt: string;
}

export interface ModuleTreeNode extends Module {
  children: ModuleTreeNode[];
}

export interface ModuleWithMembers extends Module {
  members: Array<{
    definitionId: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    isExported: boolean;
  }>;
}

export interface CallGraphEdge {
  fromId: number;
  toId: number;
  weight: number;
  minUsageLine: number; // Earliest line where this call occurs
}

// ============================================================
// Interaction Types (Module-to-Module Edges)
// ============================================================

/**
 * Interaction source type: how the interaction was detected.
 */
export type InteractionSource = 'ast' | 'ast-import' | 'llm-inferred' | 'contract-matched';

/**
 * Interaction: Point-to-point module connection.
 *
 * Represents a uni- or bi-directional relationship between two modules,
 * with details about which symbols are called and the pattern of usage.
 */
export interface Interaction {
  id: number;
  fromModuleId: number;
  toModuleId: number;
  direction: 'uni' | 'bi'; // uni-directional or bi-directional
  weight: number; // Number of symbol-level calls
  pattern: 'utility' | 'business' | 'test-internal' | null; // Classification based on call patterns
  symbols: string | null; // JSON array of symbol names
  semantic: string | null; // What happens in this interaction
  source: InteractionSource; // How this interaction was detected
  confidence: 'high' | 'medium' | null; // Confidence level for llm-inferred interactions
  createdAt: string;
}

/**
 * Enriched interaction with module path information for display
 */
export interface InteractionWithPaths extends Interaction {
  fromModulePath: string;
  toModulePath: string;
}

/**
 * Symbol detail within a module call edge
 */
export interface CalledSymbolInfo {
  name: string;
  kind: string; // 'function', 'class', 'method', 'variable', 'module'
  callCount: number;
}

/**
 * Module call graph edge for interaction detection
 */
export interface ModuleCallEdge {
  fromModuleId: number;
  toModuleId: number;
  weight: number; // Number of symbol-level calls
  fromModulePath: string;
  toModulePath: string;
}

/**
 * Enriched module call edge with symbol-level details for better interaction detection
 */
export interface EnrichedModuleCallEdge extends ModuleCallEdge {
  calledSymbols: CalledSymbolInfo[];
  avgCallsPerSymbol: number;
  distinctCallers: number; // Number of unique callers from source module
  isHighFrequency: boolean; // > 10 calls = likely utility
  edgePattern: 'utility' | 'business' | 'test-internal'; // Classification based on call patterns
  minUsageLine: number; // Earliest line where this call occurs (for ordering)
}

// ============================================================
// Sync Dirty Tracking Types
// ============================================================

export type DirtyLayer = 'metadata' | 'relationships' | 'modules' | 'contracts' | 'interactions' | 'flows' | 'features';
export type DirtyReason = 'added' | 'modified' | 'removed' | 'dependency_changed' | 'parent_dirty';

export interface SyncDirtyEntry {
  layer: DirtyLayer;
  entityId: number;
  reason: DirtyReason;
}

// ============================================================
// Flow Types (User Journeys)
// ============================================================

/**
 * Stakeholder types for flows
 */
export type FlowStakeholder = 'user' | 'admin' | 'system' | 'developer' | 'external';

/**
 * Flow: A user journey - sequence of interactions triggered by an entry point.
 *
 * Represents a complete path from trigger to outcome, documenting how
 * a feature works end-to-end.
 */
export interface Flow {
  id: number;
  name: string;
  slug: string;
  entryPointModuleId: number | null; // FK to modules (the entry point module)
  entryPointId: number | null; // FK to definitions (specific definition within module)
  entryPath: string | null; // e.g., "POST /api/auth/login"
  stakeholder: FlowStakeholder | null; // user, admin, system, developer, external
  description: string | null;
  actionType: string | null;
  targetEntity: string | null;
  tier: number; // 0 = atomic, 1 = operation, 2 = journey
  createdAt: string;
}

/**
 * Subflow step: references a child flow within a composite flow
 */
export interface FlowSubflowStep {
  flowId: number;
  stepOrder: number;
  subflowId: number;
}

/**
 * Flow step: An ordered interaction within a flow (module-level)
 */
export interface FlowStep {
  flowId: number;
  stepOrder: number; // 1, 2, 3...
  interactionId: number;
}

/**
 * Flow definition step: An ordered definition-level call edge within a flow
 */
export interface FlowDefinitionStep {
  flowId: number;
  stepOrder: number; // 1, 2, 3...
  fromDefinitionId: number;
  toDefinitionId: number;
}

/**
 * Flow definition step with full details for display
 */
export interface FlowDefinitionStepWithDetails extends FlowDefinitionStep {
  fromDefinitionName: string;
  fromDefinitionKind: string;
  fromFilePath: string;
  fromLine: number;
  fromModuleId: number | null;
  fromModulePath: string | null;
  toDefinitionName: string;
  toDefinitionKind: string;
  toFilePath: string;
  toLine: number;
  toModuleId: number | null;
  toModulePath: string | null;
  semantic: string | null;
}

/**
 * Flow with its steps and interaction details for display (module-level)
 */
export interface FlowWithSteps extends Flow {
  steps: Array<
    FlowStep & {
      interaction: InteractionWithPaths;
    }
  >;
}

/**
 * Flow with its definition-level steps for display
 */
export interface FlowWithDefinitionSteps extends Flow {
  definitionSteps: FlowDefinitionStepWithDetails[];
}

/**
 * Expanded flow showing flattened interactions in order
 */
export interface ExpandedFlow {
  flow: Flow;
  interactions: InteractionWithPaths[]; // All interactions in order
}

/**
 * Flow coverage statistics
 */
export interface FlowCoverageStats {
  totalInteractions: number;
  coveredByFlows: number;
  percentage: number;
}

/**
 * Relationship to interaction coverage statistics
 */
export interface RelationshipInteractionCoverage {
  totalRelationships: number;
  crossModuleRelationships: number; // Both symbols assigned to different modules
  relationshipsContributingToInteractions: number;
  sameModuleCount: number; // Relationships within the same module (excluded from coverage)
  orphanedCount: number;
  coveragePercent: number; // Now based on cross-module only
}

/**
 * Detailed breakdown of relationship coverage for diagnostics
 */
export interface RelationshipCoverageBreakdown {
  covered: number; // Cross-module with matching interaction edge
  sameModule: number; // Both symbols in the same module (internal cohesion)
  noCallEdge: number; // Cross-module but no matching interaction edge
  orphaned: number; // Missing module assignment for one or both symbols
  byType: {
    uses: number;
    extends: number;
    implements: number;
  };
}

// ============================================================
// Feature Types (Product-level groupings of flows)
// ============================================================

export interface Feature {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
}

export interface FeatureWithFlows extends Feature {
  flows: Flow[];
}

// ============================================================
// Annotated Symbol/Edge Types for LLM Context
// ============================================================

export interface AnnotatedSymbolInfo {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  isExported: boolean;
  purpose: string | null;
  domain: string[] | null;
  role: string | null;
  extendsName: string | null;
  extendedByCount: number;
}

export interface AnnotatedEdgeInfo {
  fromId: number;
  toId: number;
  weight: number;
  semantic: string | null;
}

export interface EnhancedRelationshipContext {
  // Base relationship info
  fromDefinitionId: number;
  fromName: string;
  fromKind: string;
  fromFilePath: string;
  fromLine: number;
  fromEndLine: number;
  toDefinitionId: number;
  toName: string;
  toKind: string;
  toFilePath: string;
  toLine: number;
  toEndLine: number;
  // Metadata for from symbol
  fromPurpose: string | null;
  fromDomains: string[] | null;
  fromRole: string | null;
  fromPure: boolean | null;
  // Metadata for to symbol
  toPurpose: string | null;
  toDomains: string[] | null;
  toRole: string | null;
  toPure: boolean | null;
  // Relationship context
  relationshipType: 'call' | 'import' | 'extends' | 'implements';
  usageLine: number;
  // Other relationships context
  otherFromRelationships: string[];
  otherToRelationships: string[];
  // Domain overlap
  sharedDomains: string[];
}

/**
 * Interface for database operations, enabling mocking in tests.
 */
export interface IIndexWriter {
  initialize(): void;
  setMetadata(key: string, value: string): void;
  insertFile(file: FileInsert): number;
  insertDefinition(fileId: number, def: Definition): number;
  insertReference(fromFileId: number, toFileId: number | null, ref: FileReference): number;
  insertSymbol(refId: number | null, defId: number | null, sym: ImportedSymbol, fileId?: number): number;
  insertUsage(symbolId: number, usage: SymbolUsage): void;
  getDefinitionByName(fileId: number, name: string): number | null;
  getDefinitionCount(): number;
  getReferenceCount(): number;
  getUsageCount(): number;
  getCallsites(definitionId: number): CallsiteResult[];
  getCallsitesForFile(fileId: number): CallsiteResult[];
  getCallsiteCount(): number;
  close(): void;
}

// ============================================================
// SQL Schema Definition
// ============================================================

/**
 * Full database schema DDL, auto-generated from the TABLES registry in dependency order.
 * The registry is the single source of truth — do not edit this constant directly.
 * See src/db/schema-registry.ts to add, modify, or annotate table definitions.
 */
export const SCHEMA = generateSchemaDDL();

// ============================================================
// Utility Functions
// ============================================================

/**
 * Predicate that identifies runtime interactions (as opposed to static import edges).
 * Keeps 'ast', 'llm-inferred', and 'contract-matched' sources; excludes 'ast-import' source and 'test-internal' pattern.
 * This is the single source of truth for "meaningful interaction" across the entire pipeline.
 */
export function isRuntimeInteraction(i: Pick<Interaction, 'source' | 'pattern'>): boolean {
  if (i.pattern === 'test-internal') return false;
  if (i.source === 'ast-import') return false;
  return true;
}

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
