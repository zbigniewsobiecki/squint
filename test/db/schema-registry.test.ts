import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TABLES, TABLE_ORDER, columnExists, generateSchemaDDL, tableExists } from '../../src/db/schema-registry.js';
import { SCHEMA } from '../../src/db/schema.js';

describe('schema-registry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // ──────────────────────────────────────────────────────────────
  // tableExists helper
  // ──────────────────────────────────────────────────────────────

  describe('tableExists()', () => {
    it('returns false for a non-existent table', () => {
      expect(tableExists(db, 'nonexistent')).toBe(false);
    });

    it('returns true after the table is created', () => {
      db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY)');
      expect(tableExists(db, 'foo')).toBe(true);
    });

    it('returns false for a dropped table', () => {
      db.exec('CREATE TABLE bar (id INTEGER PRIMARY KEY)');
      db.exec('DROP TABLE bar');
      expect(tableExists(db, 'bar')).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // columnExists helper
  // ──────────────────────────────────────────────────────────────

  describe('columnExists()', () => {
    beforeEach(() => {
      db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)');
    });

    it('returns true for an existing column', () => {
      expect(columnExists(db, 'things', 'id')).toBe(true);
      expect(columnExists(db, 'things', 'name')).toBe(true);
    });

    it('returns false for a non-existent column', () => {
      expect(columnExists(db, 'things', 'description')).toBe(false);
    });

    it('returns true after ALTER TABLE ADD COLUMN', () => {
      db.exec('ALTER TABLE things ADD COLUMN description TEXT');
      expect(columnExists(db, 'things', 'description')).toBe(true);
    });

    it('returns false for a table that does not exist', () => {
      expect(columnExists(db, 'no_such_table', 'id')).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // TABLES registry structure
  // ──────────────────────────────────────────────────────────────

  describe('TABLES registry', () => {
    it('contains all 22 tables', () => {
      expect(Object.keys(TABLES)).toHaveLength(22);
    });

    it('every entry has a non-empty ddl string starting with CREATE TABLE', () => {
      for (const [name, schema] of Object.entries(TABLES)) {
        expect(typeof schema.ddl).toBe('string');
        expect(schema.ddl.trimStart()).toMatch(/^CREATE TABLE/);
        expect(schema.ddl).toContain(name);
      }
    });

    it('every entry has an indexes array (possibly empty)', () => {
      for (const [, schema] of Object.entries(TABLES)) {
        expect(Array.isArray(schema.indexes)).toBe(true);
        for (const idx of schema.indexes) {
          expect(idx.trimStart()).toMatch(/^CREATE INDEX/);
        }
      }
    });

    it('every entry has a non-empty columns array', () => {
      for (const [, schema] of Object.entries(TABLES)) {
        expect(Array.isArray(schema.columns)).toBe(true);
        expect(schema.columns.length).toBeGreaterThan(0);
        for (const col of schema.columns) {
          expect(typeof col.name).toBe('string');
          expect(typeof col.type).toBe('string');
        }
      }
    });

    it('contains flow_subflow_steps (previously missing from schema.ts)', () => {
      expect(TABLES).toHaveProperty('flow_subflow_steps');
    });

    it('contains features and feature_flows (previously missing from schema.ts)', () => {
      expect(TABLES).toHaveProperty('features');
      expect(TABLES).toHaveProperty('feature_flows');
    });

    it('interaction_definition_links has contract_id as NOT NULL with 4-column PK', () => {
      const ddl = TABLES.interaction_definition_links.ddl;
      expect(ddl).toContain('contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE');
      expect(ddl).toContain('PRIMARY KEY (interaction_id, from_definition_id, to_definition_id, contract_id)');
    });

    it('flows table includes action_type, target_entity, and tier columns', () => {
      const ddl = TABLES.flows.ddl;
      expect(ddl).toContain('action_type');
      expect(ddl).toContain('target_entity');
      expect(ddl).toContain('tier');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // TABLE_ORDER
  // ──────────────────────────────────────────────────────────────

  describe('TABLE_ORDER', () => {
    it('contains exactly the same tables as TABLES, with no extras or missing entries', () => {
      const registryKeys = new Set(Object.keys(TABLES));
      const orderSet = new Set(TABLE_ORDER);

      // Every table in TABLES must appear in TABLE_ORDER
      for (const key of registryKeys) {
        expect(TABLE_ORDER).toContain(key);
      }

      // Every entry in TABLE_ORDER must exist in TABLES
      for (const name of TABLE_ORDER) {
        expect(registryKeys).toContain(name);
      }

      // No duplicates in TABLE_ORDER
      expect(TABLE_ORDER).toHaveLength(orderSet.size);
    });

    it('metadata, files, and domains come before tables that depend on them', () => {
      const metaIdx = TABLE_ORDER.indexOf('metadata');
      const filesIdx = TABLE_ORDER.indexOf('files');
      const domainsIdx = TABLE_ORDER.indexOf('domains');
      const defsIdx = TABLE_ORDER.indexOf('definitions');
      const modulesIdx = TABLE_ORDER.indexOf('modules');

      expect(metaIdx).toBeLessThan(defsIdx);
      expect(filesIdx).toBeLessThan(defsIdx);
      expect(domainsIdx).toBeGreaterThanOrEqual(0);
      expect(modulesIdx).toBeGreaterThan(filesIdx);
    });

    it('flows comes after modules and definitions', () => {
      const flowsIdx = TABLE_ORDER.indexOf('flows');
      const modulesIdx = TABLE_ORDER.indexOf('modules');
      const defsIdx = TABLE_ORDER.indexOf('definitions');

      expect(flowsIdx).toBeGreaterThan(modulesIdx);
      expect(flowsIdx).toBeGreaterThan(defsIdx);
    });

    it('features and feature_flows come after flows', () => {
      const flowsIdx = TABLE_ORDER.indexOf('flows');
      const featuresIdx = TABLE_ORDER.indexOf('features');
      const featureFlowsIdx = TABLE_ORDER.indexOf('feature_flows');

      expect(featuresIdx).toBeGreaterThan(flowsIdx);
      expect(featureFlowsIdx).toBeGreaterThan(featuresIdx);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // generateSchemaDDL() — the DDL is executable
  // ──────────────────────────────────────────────────────────────

  describe('generateSchemaDDL()', () => {
    it('produces executable DDL that creates all tables', () => {
      const ddl = generateSchemaDDL();
      expect(() => db.exec(ddl)).not.toThrow();

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>;
      const tableNames = tables.map((t) => t.name);

      for (const name of Object.keys(TABLES)) {
        expect(tableNames).toContain(name);
      }
    });

    it('produces all expected indexes', () => {
      db.exec(generateSchemaDDL());

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name"
        )
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);

      // Spot-check some well-known indexes
      expect(indexNames).toContain('idx_files_path');
      expect(indexNames).toContain('idx_definitions_file');
      expect(indexNames).toContain('idx_modules_path');
      expect(indexNames).toContain('idx_interactions_from_module');
      expect(indexNames).toContain('idx_flows_slug');
      expect(indexNames).toContain('idx_features_slug');
      expect(indexNames).toContain('idx_flow_subflow_steps_subflow');
    });

    it('is idempotent-safe: generated DDL can be applied to a fresh in-memory database without error', () => {
      const db2 = new Database(':memory:');
      try {
        expect(() => db2.exec(generateSchemaDDL())).not.toThrow();
      } finally {
        db2.close();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Regression guard: registry-generated DDL ≡ SCHEMA constant
  // ──────────────────────────────────────────────────────────────

  describe('SCHEMA constant regression guard', () => {
    /**
     * Apply the schema and return sorted table names and their pragma_table_info
     * (column names + notnull) from a fresh database.
     */
    function getTableStructure(ddl: string): Record<string, Array<{ name: string; notnull: number }>> {
      const testDb = new Database(':memory:');
      try {
        testDb.exec(ddl);
        const tables = testDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>;

        const result: Record<string, Array<{ name: string; notnull: number }>> = {};
        for (const { name } of tables) {
          result[name] = testDb
            .prepare(`SELECT name, "notnull" FROM pragma_table_info('${name}') ORDER BY cid`)
            .all() as Array<{ name: string; notnull: number }>;
        }
        return result;
      } finally {
        testDb.close();
      }
    }

    it('registry-generated SCHEMA creates the same tables as the TABLES registry', () => {
      const structure = getTableStructure(SCHEMA);
      const tableNames = Object.keys(structure).sort();

      // All tables from registry must be present
      for (const name of Object.keys(TABLES)) {
        expect(tableNames).toContain(name);
      }
    });

    it('registry-generated DDL produces all 22 tables from the registry', () => {
      const structure = getTableStructure(SCHEMA);
      const tableNames = Object.keys(structure);

      expect(tableNames).toContain('flow_subflow_steps');
      expect(tableNames).toContain('features');
      expect(tableNames).toContain('feature_flows');

      // Should have all 22 registry tables (plus sqlite internal tables may vary)
      for (const name of Object.keys(TABLES)) {
        expect(tableNames).toContain(name);
      }
    });

    it('each registry table has the same columns as declared in its column spec', () => {
      db.exec(SCHEMA);

      for (const [tableName, tableSchema] of Object.entries(TABLES)) {
        const columns = db.prepare(`SELECT name FROM pragma_table_info('${tableName}') ORDER BY cid`).all() as Array<{
          name: string;
        }>;
        const actualNames = columns.map((c) => c.name);
        const expectedNames = tableSchema.columns.map((c) => c.name);

        expect(actualNames).toEqual(expectedNames);
      }
    });

    it('all indexes declared in the registry are present in the database', () => {
      db.exec(SCHEMA);

      const dbIndexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'")
        .all() as Array<{ name: string }>;
      const dbIndexNames = new Set(dbIndexes.map((i) => i.name));

      for (const [, tableSchema] of Object.entries(TABLES)) {
        for (const idxDdl of tableSchema.indexes) {
          // Extract index name: "CREATE INDEX idx_name ON ..."
          const match = idxDdl.match(/CREATE INDEX (\w+)/);
          if (match) {
            expect(dbIndexNames).toContain(match[1]);
          }
        }
      }
    });

    it('flow_subflow_steps table allows composite PK (flow_id, step_order) constraint', () => {
      db.exec(SCHEMA);

      // Insert prerequisite rows
      db.exec("INSERT INTO flows (name, slug) VALUES ('a', 'flow-a'), ('b', 'flow-b')");
      db.prepare('INSERT INTO flow_subflow_steps (flow_id, step_order, subflow_id) VALUES (?, ?, ?)').run(1, 1, 2);

      // Duplicate PK should fail
      expect(() => {
        db.prepare('INSERT INTO flow_subflow_steps (flow_id, step_order, subflow_id) VALUES (?, ?, ?)').run(1, 1, 2);
      }).toThrow();
    });

    it('features / feature_flows tables are queryable after schema application', () => {
      db.exec(SCHEMA);

      db.exec("INSERT INTO features (name, slug) VALUES ('Search', 'search')");
      const feature = db.prepare("SELECT * FROM features WHERE slug = 'search'").get() as {
        name: string;
        slug: string;
      };
      expect(feature.name).toBe('Search');

      // Verify feature_flows junction FK to flows
      db.exec("INSERT INTO flows (name, slug) VALUES ('Perform Search', 'perform-search')");
      db.exec('INSERT INTO feature_flows (feature_id, flow_id) VALUES (1, 1)');
      const link = db.prepare('SELECT * FROM feature_flows WHERE feature_id = 1').get() as {
        feature_id: number;
        flow_id: number;
      };
      expect(link.feature_id).toBe(1);
      expect(link.flow_id).toBe(1);
    });
  });
});
