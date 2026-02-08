import Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';

/**
 * Create a new database connection with WAL mode enabled.
 */
export function createConnection(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Initialize the database schema, dropping any existing tables.
 */
export function initializeSchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS flows;
    DROP TABLE IF EXISTS module_members;
    DROP TABLE IF EXISTS modules;
    DROP TABLE IF EXISTS domains;
    DROP TABLE IF EXISTS relationship_annotations;
    DROP TABLE IF EXISTS definition_metadata;
    DROP TABLE IF EXISTS usages;
    DROP TABLE IF EXISTS symbols;
    DROP TABLE IF EXISTS imports;
    DROP TABLE IF EXISTS definitions;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS metadata;
  `);
  db.exec(SCHEMA);
}

/**
 * Close the database connection.
 */
export function closeConnection(db: Database.Database): void {
  db.close();
}
