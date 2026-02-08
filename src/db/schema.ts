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

export type ModuleLayer = 'controller' | 'service' | 'repository' | 'adapter' | 'utility';

export interface Module {
  id: number;
  name: string;
  description: string | null;
  layer: ModuleLayer | null;
  subsystem: string | null;
  createdAt: string;
}

export interface ModuleMember {
  moduleId: number;
  definitionId: number;
  cohesion: number | null;
}

export interface ModuleWithMembers extends Module {
  members: Array<{
    definitionId: number;
    name: string;
    kind: string;
    filePath: string;
    cohesion: number | null;
  }>;
}

export interface CallGraphEdge {
  fromId: number;
  toId: number;
  weight: number;
}

// ============================================================
// Flow Types
// ============================================================

export interface Flow {
  id: number;
  name: string;
  description: string | null;
  entryPointId: number;
  domain: string | null;
  createdAt: string;
}

export interface FlowStep {
  flowId: number;
  stepOrder: number;
  definitionId: number;
  moduleId: number | null;
  layer: string | null;
}

export interface FlowWithSteps extends Flow {
  entryPointName: string;
  entryPointKind: string;
  entryPointFilePath: string;
  steps: Array<{
    stepOrder: number;
    definitionId: number;
    name: string;
    kind: string;
    filePath: string;
    moduleId: number | null;
    moduleName: string | null;
    layer: string | null;
  }>;
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

-- Module boundaries detected via community detection on the call graph
CREATE TABLE modules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  layer TEXT,           -- 'controller' | 'service' | 'repository' | 'adapter' | 'utility'
  subsystem TEXT,       -- e.g., 'payments', 'accounts', 'compliance'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mapping of definitions to modules
CREATE TABLE module_members (
  module_id INTEGER NOT NULL,
  definition_id INTEGER NOT NULL,
  cohesion REAL,        -- 0.0-1.0 how cohesive this member is with the module
  PRIMARY KEY (module_id, definition_id),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (definition_id) REFERENCES definitions(id) ON DELETE CASCADE
);

CREATE INDEX idx_module_members_def ON module_members(definition_id);

-- End-to-end execution flows
CREATE TABLE flows (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  entry_point_id INTEGER NOT NULL REFERENCES definitions(id),
  domain TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE flow_steps (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  definition_id INTEGER NOT NULL REFERENCES definitions(id),
  module_id INTEGER REFERENCES modules(id),
  layer TEXT,
  PRIMARY KEY (flow_id, step_order)
);

CREATE INDEX idx_flow_steps_def ON flow_steps(definition_id);
CREATE INDEX idx_flows_entry ON flows(entry_point_id);
`;

// ============================================================
// Utility Functions
// ============================================================

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
