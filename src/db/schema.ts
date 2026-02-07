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

export interface RelationshipAnnotation {
  id: number;
  fromDefinitionId: number;
  toDefinitionId: number;
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
  semantic TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (from_definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (to_definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  UNIQUE(from_definition_id, to_definition_id)
);

CREATE INDEX idx_relationship_annotations_from ON relationship_annotations(from_definition_id);
CREATE INDEX idx_relationship_annotations_to ON relationship_annotations(to_definition_id);

-- Domain registry for managing business domains
CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_domains_name ON domains(name);
`;

// ============================================================
// Utility Functions
// ============================================================

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
