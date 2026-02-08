import { createHash } from 'node:crypto';
import type { Definition } from '../parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../parser/reference-extractor.js';

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
  pattern: 'utility' | 'business' | null; // Classification based on call patterns
  symbols: string | null; // JSON array of symbol names
  semantic: string | null; // What happens in this interaction
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
  kind: string; // 'function', 'class', 'method', 'variable'
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
  edgePattern: 'utility' | 'business'; // Classification based on call patterns
  minUsageLine: number; // Earliest line where this call occurs (for ordering)
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
  createdAt: string;
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
// Legacy Types (for backward compatibility during migration)
// ============================================================

/**
 * @deprecated Use Interaction instead
 * Module call graph edge - kept for backward compatibility
 */
export interface FlowTreeNode {
  id: number;
  name: string;
  slug: string;
  fullPath: string;
  description: string | null;
  fromModuleId: number | null;
  toModuleId: number | null;
  semantic: string | null;
  depth: number;
  domain: string | null;
  parentId: number | null;
  stepOrder: number;
  createdAt: string;
  children: FlowTreeNode[];
  fromModuleName?: string;
  toModuleName?: string;
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

export const SCHEMA = `
-- Metadata about the indexing run
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Files indexed by this run
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at TEXT NOT NULL
);

-- All definitions (functions, classes, variables, types) in each file
CREATE TABLE definitions (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  is_exported INTEGER NOT NULL,
  is_default INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  extends_name TEXT,          -- Parent class name (for classes)
  implements_names TEXT,      -- JSON array of interface names (for classes)
  extends_interfaces TEXT,    -- JSON array of parent interfaces (for interfaces)
  FOREIGN KEY (file_id) REFERENCES files(id)
);

-- Import/export relationships between files
CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  from_file_id INTEGER NOT NULL,
  to_file_id INTEGER,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  is_external INTEGER NOT NULL,
  is_type_only INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column INTEGER NOT NULL,
  FOREIGN KEY (from_file_id) REFERENCES files(id),
  FOREIGN KEY (to_file_id) REFERENCES files(id)
);

-- Symbols imported in each reference (or internal symbols within a file)
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  reference_id INTEGER,           -- NULL for internal symbols
  file_id INTEGER,                -- Set for internal symbols (same-file references)
  definition_id INTEGER,
  name TEXT NOT NULL,
  local_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  FOREIGN KEY (reference_id) REFERENCES imports(id),
  FOREIGN KEY (file_id) REFERENCES files(id),
  FOREIGN KEY (definition_id) REFERENCES definitions(id)
);

-- Where each imported symbol is used in the file
CREATE TABLE usages (
  id INTEGER PRIMARY KEY,
  symbol_id INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column INTEGER NOT NULL,
  context TEXT NOT NULL,
  argument_count INTEGER,
  is_method_call INTEGER,
  is_constructor_call INTEGER,
  receiver_name TEXT,
  FOREIGN KEY (symbol_id) REFERENCES symbols(id)
);

-- Indexes for efficient queries
CREATE INDEX idx_files_path ON files(path);
CREATE INDEX idx_definitions_file ON definitions(file_id);
CREATE INDEX idx_definitions_name ON definitions(name);
CREATE INDEX idx_definitions_extends ON definitions(extends_name);
CREATE INDEX idx_imports_from_file ON imports(from_file_id);
CREATE INDEX idx_imports_to_file ON imports(to_file_id);
CREATE INDEX idx_symbols_reference ON symbols(reference_id);
CREATE INDEX idx_symbols_definition ON symbols(definition_id);
CREATE INDEX idx_symbols_file ON symbols(file_id);
CREATE INDEX idx_usages_symbol ON usages(symbol_id);
CREATE INDEX idx_usages_context ON usages(context);

-- Key-value metadata for definitions
CREATE TABLE definition_metadata (
  id INTEGER PRIMARY KEY,
  definition_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  FOREIGN KEY (definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  UNIQUE(definition_id, key)
);

CREATE INDEX idx_definition_metadata_def ON definition_metadata(definition_id);
CREATE INDEX idx_definition_metadata_key ON definition_metadata(key);

-- Semantic annotations for relationships between definitions
CREATE TABLE relationship_annotations (
  id INTEGER PRIMARY KEY,
  from_definition_id INTEGER NOT NULL,
  to_definition_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT 'uses',  -- 'uses' | 'extends' | 'implements'
  semantic TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (from_definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (to_definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  UNIQUE(from_definition_id, to_definition_id)
);

CREATE INDEX idx_relationship_annotations_from ON relationship_annotations(from_definition_id);
CREATE INDEX idx_relationship_annotations_to ON relationship_annotations(to_definition_id);
CREATE INDEX idx_relationship_annotations_type ON relationship_annotations(relationship_type);

-- Domain registry for managing business domains
CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_domains_name ON domains(name);

-- Module tree structure
CREATE TABLE modules (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                    -- e.g., "login" (leaf segment)
  full_path TEXT NOT NULL UNIQUE,        -- e.g., "project.packages.electron-app.screens.login"
  name TEXT NOT NULL,                    -- Human-readable: "Login Screen"
  description TEXT,                      -- Free text description
  depth INTEGER NOT NULL DEFAULT 0,      -- 0 for root, 1 for children, etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parent_id, slug)
);

CREATE INDEX idx_modules_parent ON modules(parent_id);
CREATE INDEX idx_modules_path ON modules(full_path);
CREATE INDEX idx_modules_depth ON modules(depth);

-- Symbol assignments (each symbol belongs to exactly one module)
CREATE TABLE module_members (
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (definition_id)
);

CREATE INDEX idx_module_members_module ON module_members(module_id);

-- Interactions: module-to-module edges (flat, not hierarchical)
CREATE TABLE interactions (
  id INTEGER PRIMARY KEY,
  from_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  to_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT 'uni',  -- 'uni' | 'bi'
  weight INTEGER NOT NULL DEFAULT 1,
  pattern TEXT,  -- 'utility' | 'business'
  symbols TEXT,  -- JSON array of symbol names
  semantic TEXT,  -- What happens in this interaction
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_module_id, to_module_id)
);

CREATE INDEX idx_interactions_from_module ON interactions(from_module_id);
CREATE INDEX idx_interactions_to_module ON interactions(to_module_id);
CREATE INDEX idx_interactions_pattern ON interactions(pattern);

-- Flows: user journeys with entry points
CREATE TABLE flows (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  entry_point_module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
  entry_point_id INTEGER REFERENCES definitions(id) ON DELETE SET NULL,
  entry_path TEXT,  -- e.g., "POST /api/auth/login"
  stakeholder TEXT,  -- 'user' | 'admin' | 'system' | 'developer' | 'external'
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_flows_slug ON flows(slug);
CREATE INDEX idx_flows_entry_point_module ON flows(entry_point_module_id);
CREATE INDEX idx_flows_entry_point ON flows(entry_point_id);
CREATE INDEX idx_flows_stakeholder ON flows(stakeholder);

-- Flow steps: ordered interactions within a flow (module-level)
CREATE TABLE flow_steps (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  PRIMARY KEY (flow_id, step_order)
);

CREATE INDEX idx_flow_steps_interaction ON flow_steps(interaction_id);

-- Flow definition steps: ordered definition-level call edges within a flow
CREATE TABLE flow_definition_steps (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  from_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  to_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  PRIMARY KEY (flow_id, step_order)
);

CREATE INDEX idx_flow_def_steps_from ON flow_definition_steps(from_definition_id);
CREATE INDEX idx_flow_def_steps_to ON flow_definition_steps(to_definition_id);
`;

// ============================================================
// Utility Functions
// ============================================================

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
