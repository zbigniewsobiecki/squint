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
// Flow Types (Hierarchical Tree Structure)
// ============================================================

/**
 * Flow: A hierarchical tree structure mirroring modules.
 *
 * Leaf flows: Single module-to-module transition with semantic description
 * Parent flows: Composition of child flows in ordered sequence
 * Root flows: User-story level flows (depth = 0)
 */
export interface Flow {
  id: number;
  parentId: number | null;
  stepOrder: number;  // Position within parent (1, 2, 3...)
  name: string;
  slug: string;
  fullPath: string;  // e.g., "user-journey.authentication.validate-credentials"
  description: string | null;

  // For leaf flows only: the module transition
  fromModuleId: number | null;
  toModuleId: number | null;
  semantic: string | null;  // What happens in this transition

  // Metadata
  depth: number;
  domain: string | null;
  createdAt: string;
}

/**
 * Flow tree node for hierarchical display
 */
export interface FlowTreeNode extends Flow {
  children: FlowTreeNode[];  // Ordered by stepOrder
  // Enriched for display
  fromModuleName?: string;
  toModuleName?: string;
}

/**
 * Module call graph edge for flow detection
 */
export interface ModuleCallEdge {
  fromModuleId: number;
  toModuleId: number;
  weight: number;  // Number of symbol-level calls
  fromModulePath: string;
  toModulePath: string;
}

/**
 * Expanded flow showing flattened leaf flows in order
 */
export interface ExpandedFlow {
  flow: Flow;
  leafFlows: Flow[];  // All leaf flows in order
}

/**
 * Flow coverage statistics
 */
export interface FlowCoverageStats {
  totalModuleEdges: number;
  coveredByFlows: number;
  percentage: number;
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

-- Flows: hierarchical tree structure mirroring modules, with ordering
-- Leaf flows: module-to-module transitions
-- Parent flows: compositions of child flows
CREATE TABLE flows (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 0,  -- Position within parent (1, 2, 3...)
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  full_path TEXT NOT NULL UNIQUE,  -- e.g., "user-journey.authentication.validate-credentials"
  description TEXT,

  -- For leaf flows only: the module transition
  from_module_id INTEGER REFERENCES modules(id),
  to_module_id INTEGER REFERENCES modules(id),
  semantic TEXT,  -- What happens in this transition

  -- Metadata
  depth INTEGER NOT NULL DEFAULT 0,
  domain TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(parent_id, slug)
  -- Note: step_order ordering is enforced by application logic, not DB constraint
  -- to allow flexible reparenting without constraint conflicts
);

CREATE INDEX idx_flows_parent ON flows(parent_id);
CREATE INDEX idx_flows_path ON flows(full_path);
CREATE INDEX idx_flows_depth ON flows(depth);
CREATE INDEX idx_flows_from_module ON flows(from_module_id);
CREATE INDEX idx_flows_to_module ON flows(to_module_id);
`;

// ============================================================
// Utility Functions
// ============================================================

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
