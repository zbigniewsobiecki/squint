import type Database from 'better-sqlite3';
import { TABLES, columnExists, tableExists } from './schema-registry.js';

/**
 * Helper: run the DDL (CREATE TABLE + all indexes) for a given table from the registry.
 */
function createTableFromRegistry(db: Database.Database, tableName: string): void {
  const schema = TABLES[tableName];
  if (!schema) {
    throw new Error(`Table "${tableName}" not found in schema registry`);
  }
  db.exec(`${schema.ddl};`);
  for (const idx of schema.indexes) {
    db.exec(`${idx};`);
  }
}

/**
 * Ensure the modules and module_members tables exist with the current schema.
 */
export function ensureModulesTables(db: Database.Database): void {
  if (!tableExists(db, 'modules')) {
    createTableFromRegistry(db, 'modules');
    createTableFromRegistry(db, 'module_members');
  } else {
    // Check if we need to migrate from old schema to new schema (slug column missing)
    if (!columnExists(db, 'modules', 'slug')) {
      // Old schema detected - drop and recreate
      db.exec(`
        DROP TABLE IF EXISTS module_members;
        DROP TABLE IF EXISTS modules;
      `);
      createTableFromRegistry(db, 'modules');
      createTableFromRegistry(db, 'module_members');
    } else {
      // Check if we need to add color_index column
      if (!columnExists(db, 'modules', 'color_index')) {
        db.exec('ALTER TABLE modules ADD COLUMN color_index INTEGER NOT NULL DEFAULT 0');
      }

      // Check if we need to add is_test column
      if (!columnExists(db, 'modules', 'is_test')) {
        db.exec('ALTER TABLE modules ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
      }
    }
  }
}

/**
 * Ensure the interactions table exists.
 */
export function ensureInteractionsTables(db: Database.Database): void {
  if (!tableExists(db, 'interactions')) {
    createTableFromRegistry(db, 'interactions');
  } else {
    // Check if we need to add source column
    if (!columnExists(db, 'interactions', 'source')) {
      db.exec(`
        ALTER TABLE interactions ADD COLUMN source TEXT NOT NULL DEFAULT 'ast';
        CREATE INDEX idx_interactions_source ON interactions(source);
      `);
    }

    // Check if we need to add confidence column
    if (!columnExists(db, 'interactions', 'confidence')) {
      db.exec('ALTER TABLE interactions ADD COLUMN confidence TEXT DEFAULT NULL');
    }
  }
}

/**
 * Ensure the flows and flow_steps tables exist.
 */
export function ensureFlowsTables(db: Database.Database): void {
  if (!tableExists(db, 'flows')) {
    createTableFromRegistry(db, 'flows');
  } else {
    // Check if we need to migrate from old schema to new schema (entry_point_id missing)
    if (!columnExists(db, 'flows', 'entry_point_id')) {
      // Old schema detected - drop and recreate
      db.exec(`
        DROP TABLE IF EXISTS flow_subflow_steps;
        DROP TABLE IF EXISTS flow_definition_steps;
        DROP TABLE IF EXISTS flow_steps;
        DROP TABLE IF EXISTS flows;
      `);
      createTableFromRegistry(db, 'flows');
    } else {
      // Check if we need to add entry_point_module_id column
      if (!columnExists(db, 'flows', 'entry_point_module_id')) {
        db.exec(`
          ALTER TABLE flows ADD COLUMN entry_point_module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL;
          CREATE INDEX idx_flows_entry_point_module ON flows(entry_point_module_id);
        `);
      }
    }

    // Check for action_type column
    if (!columnExists(db, 'flows', 'action_type')) {
      db.exec(`
        ALTER TABLE flows ADD COLUMN action_type TEXT;
        ALTER TABLE flows ADD COLUMN target_entity TEXT;
      `);
    }

    // Check for tier column
    if (!columnExists(db, 'flows', 'tier')) {
      db.exec('ALTER TABLE flows ADD COLUMN tier INTEGER NOT NULL DEFAULT 0');
    }
  }

  // Ensure flow_steps table exists
  if (!tableExists(db, 'flow_steps')) {
    createTableFromRegistry(db, 'flow_steps');
  }

  // Ensure flow_definition_steps table exists (definition-level flow steps)
  if (!tableExists(db, 'flow_definition_steps')) {
    createTableFromRegistry(db, 'flow_definition_steps');
  }

  // Ensure flow_subflow_steps table exists (subflow references for composite flows)
  if (!tableExists(db, 'flow_subflow_steps')) {
    createTableFromRegistry(db, 'flow_subflow_steps');
  }
}

/**
 * Ensure the features and feature_flows tables exist.
 */
export function ensureFeaturesTables(db: Database.Database): void {
  if (!tableExists(db, 'features')) {
    createTableFromRegistry(db, 'features');
    createTableFromRegistry(db, 'feature_flows');
  }
}

/**
 * Ensure the domains table exists.
 */
export function ensureDomainsTable(db: Database.Database): void {
  if (!tableExists(db, 'domains')) {
    createTableFromRegistry(db, 'domains');
  }
}

/**
 * Ensure the declaration_end_line/column columns exist on definitions.
 * For existing databases, defaults them to end_line/end_column.
 */
export function ensureDeclarationEndColumns(db: Database.Database): void {
  if (!columnExists(db, 'definitions', 'declaration_end_line')) {
    db.exec(`
      ALTER TABLE definitions ADD COLUMN declaration_end_line INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE definitions ADD COLUMN declaration_end_column INTEGER NOT NULL DEFAULT 0;
      UPDATE definitions SET declaration_end_line = end_line, declaration_end_column = end_column;
    `);
  }
}

/**
 * Ensure the contracts and contract_participants tables exist.
 */
export function ensureContractsTables(db: Database.Database): void {
  if (!tableExists(db, 'contracts')) {
    createTableFromRegistry(db, 'contracts');
    createTableFromRegistry(db, 'contract_participants');
  }
}

/**
 * Ensure the interaction_definition_links table exists.
 */
export function ensureInteractionDefinitionLinks(db: Database.Database): void {
  if (!tableExists(db, 'interaction_definition_links')) {
    createTableFromRegistry(db, 'interaction_definition_links');
  } else {
    // Migrate: old PK was (interaction_id, from_definition_id, to_definition_id) without contract_id.
    // Check by looking for contract_id NOT NULL constraint in table_info.
    const contractCol = db
      .prepare("SELECT \"notnull\" FROM pragma_table_info('interaction_definition_links') WHERE name='contract_id'")
      .get() as { notnull: number } | undefined;
    if (!contractCol || contractCol.notnull === 0) {
      db.exec('DROP TABLE interaction_definition_links;');
      createTableFromRegistry(db, 'interaction_definition_links');
    }
  }
}

/**
 * Ensure the sync_dirty table exists for incremental sync tracking.
 */
export function ensureSyncDirtyTable(db: Database.Database): void {
  if (!tableExists(db, 'sync_dirty')) {
    createTableFromRegistry(db, 'sync_dirty');
  }
}

/**
 * Ensure the relationship_type column exists on relationship_annotations.
 */
export function ensureRelationshipTypeColumn(db: Database.Database): void {
  try {
    // Check if column exists by trying to select it
    db.prepare('SELECT relationship_type FROM relationship_annotations LIMIT 1').get();
  } catch {
    // Column doesn't exist, add it
    db.exec(`ALTER TABLE relationship_annotations ADD COLUMN relationship_type TEXT NOT NULL DEFAULT 'uses'`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_relationship_annotations_type ON relationship_annotations(relationship_type)'
    );
  }
}
