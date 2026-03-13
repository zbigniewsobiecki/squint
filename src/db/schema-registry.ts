import type Database from 'better-sqlite3';

// ============================================================
// TableSchema Interface
// ============================================================

/**
 * Column specification for a table column.
 */
export interface ColumnSpec {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string;
}

/**
 * Optional migration metadata attached to a table definition.
 * Declared for future use — not yet consumed by schema-manager.ts.
 */
export interface MigrationMetadata {
  /** Version at which this table was introduced */
  addedInVersion?: string;
  /** Columns added in migrations, with the version they were introduced */
  addedColumns?: Array<{ column: string; version: string }>;
  /** Notes about breaking schema changes */
  breakingChanges?: string[];
}

/**
 * Single-table schema definition: DDL statements plus column specs and optional migration metadata.
 */
export interface TableSchema {
  /** CREATE TABLE DDL statement */
  ddl: string;
  /** CREATE INDEX DDL statements for this table (may be empty) */
  indexes: string[];
  /** Ordered list of column specifications */
  columns: ColumnSpec[];
  /** Optional migration metadata (declared but not yet consumed) */
  migrations?: MigrationMetadata;
}

// ============================================================
// Helper Utilities
// ============================================================

/**
 * Check whether a table exists in the database.
 */
export function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as { count: number };
  return row.count > 0;
}

/**
 * Check whether a column exists on a table.
 */
export function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name=?')
    .get(tableName, columnName) as { count: number };
  return row.count > 0;
}

// ============================================================
// TABLES Registry
// ============================================================

/**
 * Registry mapping table names to their CREATE TABLE + CREATE INDEX DDL statements,
 * column specs, and optional migration metadata.
 *
 * Tables are listed in dependency order: tables with no foreign key dependencies
 * come first so that the concatenated DDL can be executed top-to-bottom.
 */
export const TABLES: Record<string, TableSchema> = {
  // ── Tier 0: no foreign key dependencies ────────────────────

  metadata: {
    ddl: `CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
    indexes: [],
    columns: [
      { name: 'key', type: 'TEXT', nullable: false },
      { name: 'value', type: 'TEXT', nullable: false },
    ],
  },

  files: {
    ddl: `CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at TEXT NOT NULL
)`,
    indexes: ['CREATE INDEX idx_files_path ON files(path)'],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'path', type: 'TEXT', nullable: false },
      { name: 'language', type: 'TEXT', nullable: false },
      { name: 'content_hash', type: 'TEXT', nullable: false },
      { name: 'size_bytes', type: 'INTEGER', nullable: false },
      { name: 'modified_at', type: 'TEXT', nullable: false },
    ],
  },

  domains: {
    ddl: `CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
    indexes: ['CREATE INDEX idx_domains_name ON domains(name)'],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'description', type: 'TEXT', nullable: true },
      { name: 'created_at', type: 'TEXT', nullable: false, defaultValue: "(datetime('now'))" },
    ],
  },

  // ── Tier 1: depends on files ────────────────────────────────

  definitions: {
    ddl: `CREATE TABLE definitions (
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
  declaration_end_line INTEGER NOT NULL,
  declaration_end_column INTEGER NOT NULL,
  extends_name TEXT,
  implements_names TEXT,
  extends_interfaces TEXT,
  FOREIGN KEY (file_id) REFERENCES files(id)
)`,
    indexes: [
      'CREATE INDEX idx_definitions_file ON definitions(file_id)',
      'CREATE INDEX idx_definitions_name ON definitions(name)',
      'CREATE INDEX idx_definitions_extends ON definitions(extends_name)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'file_id', type: 'INTEGER', nullable: false },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'kind', type: 'TEXT', nullable: false },
      { name: 'is_exported', type: 'INTEGER', nullable: false },
      { name: 'is_default', type: 'INTEGER', nullable: false },
      { name: 'line', type: 'INTEGER', nullable: false },
      { name: 'column', type: 'INTEGER', nullable: false },
      { name: 'end_line', type: 'INTEGER', nullable: false },
      { name: 'end_column', type: 'INTEGER', nullable: false },
      { name: 'declaration_end_line', type: 'INTEGER', nullable: false },
      { name: 'declaration_end_column', type: 'INTEGER', nullable: false },
      { name: 'extends_name', type: 'TEXT', nullable: true },
      { name: 'implements_names', type: 'TEXT', nullable: true },
      { name: 'extends_interfaces', type: 'TEXT', nullable: true },
    ],
  },

  imports: {
    ddl: `CREATE TABLE imports (
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
)`,
    indexes: [
      'CREATE INDEX idx_imports_from_file ON imports(from_file_id)',
      'CREATE INDEX idx_imports_to_file ON imports(to_file_id)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'from_file_id', type: 'INTEGER', nullable: false },
      { name: 'to_file_id', type: 'INTEGER', nullable: true },
      { name: 'type', type: 'TEXT', nullable: false },
      { name: 'source', type: 'TEXT', nullable: false },
      { name: 'is_external', type: 'INTEGER', nullable: false },
      { name: 'is_type_only', type: 'INTEGER', nullable: false },
      { name: 'line', type: 'INTEGER', nullable: false },
      { name: 'column', type: 'INTEGER', nullable: false },
    ],
  },

  // ── Tier 2: depends on files + definitions ──────────────────

  symbols: {
    ddl: `CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  reference_id INTEGER,
  file_id INTEGER,
  definition_id INTEGER,
  name TEXT NOT NULL,
  local_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  FOREIGN KEY (reference_id) REFERENCES imports(id),
  FOREIGN KEY (file_id) REFERENCES files(id),
  FOREIGN KEY (definition_id) REFERENCES definitions(id)
)`,
    indexes: [
      'CREATE INDEX idx_symbols_reference ON symbols(reference_id)',
      'CREATE INDEX idx_symbols_definition ON symbols(definition_id)',
      'CREATE INDEX idx_symbols_file ON symbols(file_id)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'reference_id', type: 'INTEGER', nullable: true },
      { name: 'file_id', type: 'INTEGER', nullable: true },
      { name: 'definition_id', type: 'INTEGER', nullable: true },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'local_name', type: 'TEXT', nullable: false },
      { name: 'kind', type: 'TEXT', nullable: false },
    ],
  },

  definition_metadata: {
    ddl: `CREATE TABLE definition_metadata (
  id INTEGER PRIMARY KEY,
  definition_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  FOREIGN KEY (definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  UNIQUE(definition_id, key)
)`,
    indexes: [
      'CREATE INDEX idx_definition_metadata_def ON definition_metadata(definition_id)',
      'CREATE INDEX idx_definition_metadata_key ON definition_metadata(key)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'definition_id', type: 'INTEGER', nullable: false },
      { name: 'key', type: 'TEXT', nullable: false },
      { name: 'value', type: 'TEXT', nullable: false },
    ],
  },

  relationship_annotations: {
    ddl: `CREATE TABLE relationship_annotations (
  id INTEGER PRIMARY KEY,
  from_definition_id INTEGER NOT NULL,
  to_definition_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT 'uses',
  semantic TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (from_definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (to_definition_id) REFERENCES definitions(id) ON DELETE CASCADE,
  UNIQUE(from_definition_id, to_definition_id)
)`,
    indexes: [
      'CREATE INDEX idx_relationship_annotations_from ON relationship_annotations(from_definition_id)',
      'CREATE INDEX idx_relationship_annotations_to ON relationship_annotations(to_definition_id)',
      'CREATE INDEX idx_relationship_annotations_type ON relationship_annotations(relationship_type)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'from_definition_id', type: 'INTEGER', nullable: false },
      { name: 'to_definition_id', type: 'INTEGER', nullable: false },
      { name: 'relationship_type', type: 'TEXT', nullable: false, defaultValue: "'uses'" },
      { name: 'semantic', type: 'TEXT', nullable: false },
      { name: 'created_at', type: 'TEXT', nullable: false, defaultValue: "(datetime('now'))" },
    ],
  },

  // ── Tier 3: depends on symbols ──────────────────────────────

  usages: {
    ddl: `CREATE TABLE usages (
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
)`,
    indexes: [
      'CREATE INDEX idx_usages_symbol ON usages(symbol_id)',
      'CREATE INDEX idx_usages_context ON usages(context)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'symbol_id', type: 'INTEGER', nullable: false },
      { name: 'line', type: 'INTEGER', nullable: false },
      { name: 'column', type: 'INTEGER', nullable: false },
      { name: 'context', type: 'TEXT', nullable: false },
      { name: 'argument_count', type: 'INTEGER', nullable: true },
      { name: 'is_method_call', type: 'INTEGER', nullable: true },
      { name: 'is_constructor_call', type: 'INTEGER', nullable: true },
      { name: 'receiver_name', type: 'TEXT', nullable: true },
    ],
  },

  // ── Tier 4: module tree ─────────────────────────────────────

  modules: {
    ddl: `CREATE TABLE modules (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  full_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  color_index INTEGER NOT NULL DEFAULT 0,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parent_id, slug)
)`,
    indexes: [
      'CREATE INDEX idx_modules_parent ON modules(parent_id)',
      'CREATE INDEX idx_modules_path ON modules(full_path)',
      'CREATE INDEX idx_modules_depth ON modules(depth)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'parent_id', type: 'INTEGER', nullable: true },
      { name: 'slug', type: 'TEXT', nullable: false },
      { name: 'full_path', type: 'TEXT', nullable: false },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'description', type: 'TEXT', nullable: true },
      { name: 'depth', type: 'INTEGER', nullable: false, defaultValue: '0' },
      { name: 'color_index', type: 'INTEGER', nullable: false, defaultValue: '0' },
      { name: 'is_test', type: 'INTEGER', nullable: false, defaultValue: '0' },
      { name: 'created_at', type: 'TEXT', nullable: false, defaultValue: "(datetime('now'))" },
    ],
    migrations: {
      addedColumns: [
        { column: 'color_index', version: '1.1' },
        { column: 'is_test', version: '1.2' },
      ],
    },
  },

  module_members: {
    ddl: `CREATE TABLE module_members (
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (definition_id)
)`,
    indexes: ['CREATE INDEX idx_module_members_module ON module_members(module_id)'],
    columns: [
      { name: 'module_id', type: 'INTEGER', nullable: false },
      { name: 'definition_id', type: 'INTEGER', nullable: false },
      { name: 'assigned_at', type: 'TEXT', nullable: false, defaultValue: "(datetime('now'))" },
    ],
  },

  // ── Tier 5: contracts ───────────────────────────────────────

  contracts: {
    ddl: `CREATE TABLE contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT NOT NULL,
  key TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(protocol, normalized_key)
)`,
    indexes: ['CREATE INDEX idx_contracts_protocol ON contracts(protocol)'],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'protocol', type: 'TEXT', nullable: false },
      { name: 'key', type: 'TEXT', nullable: false },
      { name: 'normalized_key', type: 'TEXT', nullable: false },
      { name: 'description', type: 'TEXT', nullable: true },
      { name: 'created_at', type: 'TEXT', nullable: true, defaultValue: "(datetime('now'))" },
    ],
  },

  contract_participants: {
    ddl: `CREATE TABLE contract_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  UNIQUE(contract_id, definition_id)
)`,
    indexes: [
      'CREATE INDEX idx_cp_contract ON contract_participants(contract_id)',
      'CREATE INDEX idx_cp_definition ON contract_participants(definition_id)',
      'CREATE INDEX idx_cp_module ON contract_participants(module_id)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'contract_id', type: 'INTEGER', nullable: false },
      { name: 'definition_id', type: 'INTEGER', nullable: false },
      { name: 'module_id', type: 'INTEGER', nullable: true },
      { name: 'role', type: 'TEXT', nullable: false },
    ],
  },

  // ── Tier 6: interactions ────────────────────────────────────

  interactions: {
    ddl: `CREATE TABLE interactions (
  id INTEGER PRIMARY KEY,
  from_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  to_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT 'uni',
  weight INTEGER NOT NULL DEFAULT 1,
  pattern TEXT,
  symbols TEXT,
  semantic TEXT,
  source TEXT NOT NULL DEFAULT 'ast',
  confidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_module_id, to_module_id)
)`,
    indexes: [
      'CREATE INDEX idx_interactions_from_module ON interactions(from_module_id)',
      'CREATE INDEX idx_interactions_to_module ON interactions(to_module_id)',
      'CREATE INDEX idx_interactions_pattern ON interactions(pattern)',
      'CREATE INDEX idx_interactions_source ON interactions(source)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'from_module_id', type: 'INTEGER', nullable: false },
      { name: 'to_module_id', type: 'INTEGER', nullable: false },
      { name: 'direction', type: 'TEXT', nullable: false, defaultValue: "'uni'" },
      { name: 'weight', type: 'INTEGER', nullable: false, defaultValue: '1' },
      { name: 'pattern', type: 'TEXT', nullable: true },
      { name: 'symbols', type: 'TEXT', nullable: true },
      { name: 'semantic', type: 'TEXT', nullable: true },
      { name: 'source', type: 'TEXT', nullable: false, defaultValue: "'ast'" },
      { name: 'confidence', type: 'TEXT', nullable: true },
      { name: 'created_at', type: 'TEXT', nullable: false, defaultValue: "(datetime('now'))" },
    ],
    migrations: {
      addedColumns: [
        { column: 'source', version: '1.1' },
        { column: 'confidence', version: '1.2' },
      ],
    },
  },

  interaction_definition_links: {
    ddl: `CREATE TABLE interaction_definition_links (
  interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  from_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  to_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  PRIMARY KEY (interaction_id, from_definition_id, to_definition_id, contract_id)
)`,
    indexes: ['CREATE INDEX idx_idl_interaction ON interaction_definition_links(interaction_id)'],
    columns: [
      { name: 'interaction_id', type: 'INTEGER', nullable: false },
      { name: 'from_definition_id', type: 'INTEGER', nullable: false },
      { name: 'to_definition_id', type: 'INTEGER', nullable: false },
      { name: 'contract_id', type: 'INTEGER', nullable: false },
    ],
    migrations: {
      breakingChanges: [
        'contract_id changed from nullable ON DELETE SET NULL to NOT NULL ON DELETE CASCADE',
        'PK expanded from (interaction_id, from_definition_id, to_definition_id) to include contract_id',
      ],
    },
  },

  // ── Tier 7: flows ───────────────────────────────────────────

  flows: {
    ddl: `CREATE TABLE flows (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  entry_point_module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
  entry_point_id INTEGER REFERENCES definitions(id) ON DELETE SET NULL,
  entry_path TEXT,
  stakeholder TEXT,
  description TEXT,
  action_type TEXT,
  target_entity TEXT,
  tier INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
    indexes: [
      'CREATE INDEX idx_flows_slug ON flows(slug)',
      'CREATE INDEX idx_flows_entry_point_module ON flows(entry_point_module_id)',
      'CREATE INDEX idx_flows_entry_point ON flows(entry_point_id)',
      'CREATE INDEX idx_flows_stakeholder ON flows(stakeholder)',
    ],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'slug', type: 'TEXT', nullable: false },
      { name: 'entry_point_module_id', type: 'INTEGER', nullable: true },
      { name: 'entry_point_id', type: 'INTEGER', nullable: true },
      { name: 'entry_path', type: 'TEXT', nullable: true },
      { name: 'stakeholder', type: 'TEXT', nullable: true },
      { name: 'description', type: 'TEXT', nullable: true },
      { name: 'action_type', type: 'TEXT', nullable: true },
      { name: 'target_entity', type: 'TEXT', nullable: true },
      { name: 'tier', type: 'INTEGER', nullable: false, defaultValue: '0' },
      { name: 'created_at', type: 'TEXT', nullable: false, defaultValue: "(datetime('now'))" },
    ],
    migrations: {
      addedColumns: [
        { column: 'entry_point_module_id', version: '1.1' },
        { column: 'action_type', version: '1.2' },
        { column: 'target_entity', version: '1.2' },
        { column: 'tier', version: '1.3' },
      ],
    },
  },

  flow_steps: {
    ddl: `CREATE TABLE flow_steps (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  PRIMARY KEY (flow_id, step_order)
)`,
    indexes: ['CREATE INDEX idx_flow_steps_interaction ON flow_steps(interaction_id)'],
    columns: [
      { name: 'flow_id', type: 'INTEGER', nullable: false },
      { name: 'step_order', type: 'INTEGER', nullable: false },
      { name: 'interaction_id', type: 'INTEGER', nullable: false },
    ],
  },

  flow_definition_steps: {
    ddl: `CREATE TABLE flow_definition_steps (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  from_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  to_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  PRIMARY KEY (flow_id, step_order)
)`,
    indexes: [
      'CREATE INDEX idx_flow_def_steps_from ON flow_definition_steps(from_definition_id)',
      'CREATE INDEX idx_flow_def_steps_to ON flow_definition_steps(to_definition_id)',
    ],
    columns: [
      { name: 'flow_id', type: 'INTEGER', nullable: false },
      { name: 'step_order', type: 'INTEGER', nullable: false },
      { name: 'from_definition_id', type: 'INTEGER', nullable: false },
      { name: 'to_definition_id', type: 'INTEGER', nullable: false },
    ],
  },

  flow_subflow_steps: {
    ddl: `CREATE TABLE flow_subflow_steps (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  subflow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  PRIMARY KEY (flow_id, step_order)
)`,
    indexes: ['CREATE INDEX idx_flow_subflow_steps_subflow ON flow_subflow_steps(subflow_id)'],
    columns: [
      { name: 'flow_id', type: 'INTEGER', nullable: false },
      { name: 'step_order', type: 'INTEGER', nullable: false },
      { name: 'subflow_id', type: 'INTEGER', nullable: false },
    ],
  },

  // ── Tier 8: features ────────────────────────────────────────

  features: {
    ddl: `CREATE TABLE features (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
    indexes: ['CREATE INDEX idx_features_slug ON features(slug)'],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'slug', type: 'TEXT', nullable: false },
      { name: 'description', type: 'TEXT', nullable: true },
      { name: 'created_at', type: 'TEXT', nullable: false, defaultValue: "(datetime('now'))" },
    ],
  },

  feature_flows: {
    ddl: `CREATE TABLE feature_flows (
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_id, flow_id)
)`,
    indexes: [
      'CREATE INDEX idx_feature_flows_feature ON feature_flows(feature_id)',
      'CREATE INDEX idx_feature_flows_flow ON feature_flows(flow_id)',
    ],
    columns: [
      { name: 'feature_id', type: 'INTEGER', nullable: false },
      { name: 'flow_id', type: 'INTEGER', nullable: false },
    ],
  },

  // ── Tier 9: sync bookkeeping ────────────────────────────────

  sync_dirty: {
    ddl: `CREATE TABLE sync_dirty (
  layer TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (layer, entity_id)
)`,
    indexes: [],
    columns: [
      { name: 'layer', type: 'TEXT', nullable: false },
      { name: 'entity_id', type: 'INTEGER', nullable: false },
      { name: 'reason', type: 'TEXT', nullable: false },
    ],
  },
};

// ============================================================
// DDL Generation
// ============================================================

/**
 * Ordered list of table names defining the dependency order for DDL concatenation.
 * Tables appear after the tables they depend on so CREATE statements can run top-to-bottom.
 */
export const TABLE_ORDER: string[] = [
  'metadata',
  'files',
  'domains',
  'definitions',
  'imports',
  'symbols',
  'definition_metadata',
  'relationship_annotations',
  'usages',
  'modules',
  'module_members',
  'contracts',
  'contract_participants',
  'interactions',
  'interaction_definition_links',
  'flows',
  'flow_steps',
  'flow_definition_steps',
  'flow_subflow_steps',
  'features',
  'feature_flows',
  'sync_dirty',
];

/**
 * Generate the full schema DDL by concatenating all table DDL in dependency order.
 * Each table's CREATE TABLE statement is followed by its CREATE INDEX statements.
 */
export function generateSchemaDDL(): string {
  const parts: string[] = [];

  for (const tableName of TABLE_ORDER) {
    const table = TABLES[tableName];
    if (!table) {
      throw new Error(`Table "${tableName}" is in TABLE_ORDER but not in TABLES registry`);
    }
    parts.push(`${table.ddl};`);
    for (const idx of table.indexes) {
      parts.push(`${idx};`);
    }
  }

  return parts.join('\n');
}
