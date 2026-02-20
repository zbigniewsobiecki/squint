import type Database from 'better-sqlite3';

/**
 * Ensure the modules and module_members tables exist with the current schema.
 */
export function ensureModulesTables(db: Database.Database): void {
  const tableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='modules'
  `)
    .get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE modules (
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
      );

      CREATE INDEX idx_modules_parent ON modules(parent_id);
      CREATE INDEX idx_modules_path ON modules(full_path);
      CREATE INDEX idx_modules_depth ON modules(depth);

      CREATE TABLE module_members (
        module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (definition_id)
      );

      CREATE INDEX idx_module_members_module ON module_members(module_id);
    `);
  } else {
    // Check if we need to migrate from old schema to new schema
    const hasSlug = db
      .prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('modules') WHERE name='slug'
    `)
      .get() as { count: number };

    if (hasSlug.count === 0) {
      // Old schema detected - drop and recreate
      db.exec(`
        DROP TABLE IF EXISTS module_members;
        DROP TABLE IF EXISTS modules;

        CREATE TABLE modules (
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
        );

        CREATE INDEX idx_modules_parent ON modules(parent_id);
        CREATE INDEX idx_modules_path ON modules(full_path);
        CREATE INDEX idx_modules_depth ON modules(depth);

        CREATE TABLE module_members (
          module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
          definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
          assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (definition_id)
        );

        CREATE INDEX idx_module_members_module ON module_members(module_id);
      `);
    } else {
      // Check if we need to add color_index column
      const hasColorIndex = db
        .prepare(`
        SELECT COUNT(*) as count FROM pragma_table_info('modules') WHERE name='color_index'
      `)
        .get() as { count: number };

      if (hasColorIndex.count === 0) {
        db.exec('ALTER TABLE modules ADD COLUMN color_index INTEGER NOT NULL DEFAULT 0');
      }

      // Check if we need to add is_test column
      const hasIsTest = db
        .prepare(`
        SELECT COUNT(*) as count FROM pragma_table_info('modules') WHERE name='is_test'
      `)
        .get() as { count: number };

      if (hasIsTest.count === 0) {
        db.exec('ALTER TABLE modules ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
      }
    }
  }
}

/**
 * Ensure the interactions table exists.
 */
export function ensureInteractionsTables(db: Database.Database): void {
  const tableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='interactions'
  `)
    .get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE interactions (
        id INTEGER PRIMARY KEY,
        from_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        to_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        direction TEXT NOT NULL DEFAULT 'uni',
        weight INTEGER NOT NULL DEFAULT 1,
        pattern TEXT,
        symbols TEXT,
        semantic TEXT,
        source TEXT NOT NULL DEFAULT 'ast',
        confidence TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(from_module_id, to_module_id)
      );

      CREATE INDEX idx_interactions_from_module ON interactions(from_module_id);
      CREATE INDEX idx_interactions_to_module ON interactions(to_module_id);
      CREATE INDEX idx_interactions_pattern ON interactions(pattern);
      CREATE INDEX idx_interactions_source ON interactions(source);
    `);
  } else {
    // Check if we need to add source column
    const hasSource = db
      .prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('interactions') WHERE name='source'
    `)
      .get() as { count: number };

    if (hasSource.count === 0) {
      db.exec(`
        ALTER TABLE interactions ADD COLUMN source TEXT NOT NULL DEFAULT 'ast';
        CREATE INDEX idx_interactions_source ON interactions(source);
      `);
    }

    // Check if we need to add confidence column
    const hasConfidence = db
      .prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('interactions') WHERE name='confidence'
    `)
      .get() as { count: number };

    if (hasConfidence.count === 0) {
      db.exec('ALTER TABLE interactions ADD COLUMN confidence TEXT DEFAULT NULL');
    }
  }
}

/**
 * Ensure the flows and flow_steps tables exist.
 */
export function ensureFlowsTables(db: Database.Database): void {
  const flowsTableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='flows'
  `)
    .get();

  if (!flowsTableExists) {
    db.exec(`
      CREATE TABLE flows (
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
      );

      CREATE INDEX idx_flows_slug ON flows(slug);
      CREATE INDEX idx_flows_entry_point_module ON flows(entry_point_module_id);
      CREATE INDEX idx_flows_entry_point ON flows(entry_point_id);
      CREATE INDEX idx_flows_stakeholder ON flows(stakeholder);
    `);
  } else {
    // Check if we need to migrate from old schema to new schema
    const hasEntryPointId = db
      .prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('flows') WHERE name='entry_point_id'
    `)
      .get() as { count: number };

    if (hasEntryPointId.count === 0) {
      // Old schema detected - drop and recreate
      db.exec(`
        DROP TABLE IF EXISTS flow_subflow_steps;
        DROP TABLE IF EXISTS flow_definition_steps;
        DROP TABLE IF EXISTS flow_steps;
        DROP TABLE IF EXISTS flows;

        CREATE TABLE flows (
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
        );

        CREATE INDEX idx_flows_slug ON flows(slug);
        CREATE INDEX idx_flows_entry_point_module ON flows(entry_point_module_id);
        CREATE INDEX idx_flows_entry_point ON flows(entry_point_id);
        CREATE INDEX idx_flows_stakeholder ON flows(stakeholder);
      `);
    } else {
      // Check if we need to add entry_point_module_id column
      const hasEntryPointModuleId = db
        .prepare(`
        SELECT COUNT(*) as count FROM pragma_table_info('flows') WHERE name='entry_point_module_id'
      `)
        .get() as { count: number };

      if (hasEntryPointModuleId.count === 0) {
        // Add the new column and index
        db.exec(`
          ALTER TABLE flows ADD COLUMN entry_point_module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL;
          CREATE INDEX idx_flows_entry_point_module ON flows(entry_point_module_id);
        `);
      }
    }

    // Check for action_type column
    const hasActionType = db
      .prepare("SELECT COUNT(*) as count FROM pragma_table_info('flows') WHERE name='action_type'")
      .get() as { count: number };
    if (hasActionType.count === 0) {
      db.exec(`
        ALTER TABLE flows ADD COLUMN action_type TEXT;
        ALTER TABLE flows ADD COLUMN target_entity TEXT;
      `);
    }

    // Check for tier column
    const hasTier = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('flows') WHERE name='tier'").get() as {
      count: number;
    };
    if (hasTier.count === 0) {
      db.exec('ALTER TABLE flows ADD COLUMN tier INTEGER NOT NULL DEFAULT 0');
    }
  }

  // Ensure flow_steps table exists
  const flowStepsTableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='flow_steps'
  `)
    .get();

  if (!flowStepsTableExists) {
    db.exec(`
      CREATE TABLE flow_steps (
        flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
        PRIMARY KEY (flow_id, step_order)
      );

      CREATE INDEX idx_flow_steps_interaction ON flow_steps(interaction_id);
    `);
  }

  // Ensure flow_definition_steps table exists (definition-level flow steps)
  const flowDefStepsTableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='flow_definition_steps'
  `)
    .get();

  if (!flowDefStepsTableExists) {
    db.exec(`
      CREATE TABLE flow_definition_steps (
        flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        from_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
        to_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
        PRIMARY KEY (flow_id, step_order)
      );

      CREATE INDEX idx_flow_def_steps_from ON flow_definition_steps(from_definition_id);
      CREATE INDEX idx_flow_def_steps_to ON flow_definition_steps(to_definition_id);
    `);
  }

  // Ensure flow_subflow_steps table exists (subflow references for composite flows)
  const flowSubflowStepsTableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='flow_subflow_steps'
  `)
    .get();

  if (!flowSubflowStepsTableExists) {
    db.exec(`
      CREATE TABLE flow_subflow_steps (
        flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        subflow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        PRIMARY KEY (flow_id, step_order)
      );

      CREATE INDEX idx_flow_subflow_steps_subflow ON flow_subflow_steps(subflow_id);
    `);
  }
}

/**
 * Ensure the features and feature_flows tables exist.
 */
export function ensureFeaturesTables(db: Database.Database): void {
  const tableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='features'
  `)
    .get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE features (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_features_slug ON features(slug);

      CREATE TABLE feature_flows (
        feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
        flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        PRIMARY KEY (feature_id, flow_id)
      );

      CREATE INDEX idx_feature_flows_feature ON feature_flows(feature_id);
      CREATE INDEX idx_feature_flows_flow ON feature_flows(flow_id);
    `);
  }
}

/**
 * Ensure the domains table exists.
 */
export function ensureDomainsTable(db: Database.Database): void {
  const tableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='domains'
  `)
    .get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE domains (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_domains_name ON domains(name);
    `);
  }
}

/**
 * Ensure the declaration_end_line/column columns exist on definitions.
 * For existing databases, defaults them to end_line/end_column.
 */
export function ensureDeclarationEndColumns(db: Database.Database): void {
  const hasColumn = db
    .prepare("SELECT COUNT(*) as count FROM pragma_table_info('definitions') WHERE name='declaration_end_line'")
    .get() as { count: number };

  if (hasColumn.count === 0) {
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
  const tableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='contracts'
  `)
    .get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        protocol TEXT NOT NULL,
        key TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(protocol, normalized_key)
      );

      CREATE INDEX idx_contracts_protocol ON contracts(protocol);

      CREATE TABLE contract_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
        module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        UNIQUE(contract_id, definition_id)
      );

      CREATE INDEX idx_cp_contract ON contract_participants(contract_id);
      CREATE INDEX idx_cp_definition ON contract_participants(definition_id);
      CREATE INDEX idx_cp_module ON contract_participants(module_id);
    `);
  }
}

/**
 * Ensure the interaction_definition_links table exists.
 */
export function ensureInteractionDefinitionLinks(db: Database.Database): void {
  const tableExists = db
    .prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='interaction_definition_links'
  `)
    .get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE interaction_definition_links (
        interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
        from_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
        to_definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
        contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
        PRIMARY KEY (interaction_id, from_definition_id, to_definition_id)
      );

      CREATE INDEX idx_idl_interaction ON interaction_definition_links(interaction_id);
    `);
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
