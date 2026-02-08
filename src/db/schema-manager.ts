import type Database from 'better-sqlite3';

/**
 * Ensure the modules and module_members tables exist with the current schema.
 */
export function ensureModulesTables(db: Database.Database): void {
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='modules'
  `).get();

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
    const hasSlug = db.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('modules') WHERE name='slug'
    `).get() as { count: number };

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
    }
  }
}

/**
 * Ensure the flows table exists with the hierarchical schema.
 */
export function ensureFlowsTables(db: Database.Database): void {
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='flows'
  `).get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE flows (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES flows(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        full_path TEXT NOT NULL UNIQUE,
        description TEXT,
        from_module_id INTEGER REFERENCES modules(id),
        to_module_id INTEGER REFERENCES modules(id),
        semantic TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        domain TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(parent_id, slug),
        UNIQUE(parent_id, step_order)
      );

      CREATE INDEX idx_flows_parent ON flows(parent_id);
      CREATE INDEX idx_flows_path ON flows(full_path);
      CREATE INDEX idx_flows_depth ON flows(depth);
      CREATE INDEX idx_flows_from_module ON flows(from_module_id);
      CREATE INDEX idx_flows_to_module ON flows(to_module_id);
    `);
  }
}

/**
 * Ensure the domains table exists.
 */
export function ensureDomainsTable(db: Database.Database): void {
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='domains'
  `).get();

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
 * Ensure the relationship_type column exists on relationship_annotations.
 */
export function ensureRelationshipTypeColumn(db: Database.Database): void {
  try {
    // Check if column exists by trying to select it
    db.prepare('SELECT relationship_type FROM relationship_annotations LIMIT 1').get();
  } catch {
    // Column doesn't exist, add it
    db.exec(`ALTER TABLE relationship_annotations ADD COLUMN relationship_type TEXT NOT NULL DEFAULT 'uses'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relationship_annotations_type ON relationship_annotations(relationship_type)`);
  }
}
