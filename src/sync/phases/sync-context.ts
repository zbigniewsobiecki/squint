import type Database from 'better-sqlite3';
import type { IndexDatabase } from '../../db/database-facade.js';
import type { ParsedFile } from '../../parser/ast-parser.js';
import type { SyncResult } from '../incremental-indexer.js';

/**
 * Shared state passed through all sync phases.
 * Each phase receives this context and may mutate it to communicate
 * data forward to subsequent phases.
 */
export interface SyncContext {
  /** The database facade (provides high-level DB operations) */
  db: IndexDatabase;
  /** The raw better-sqlite3 connection (for raw SQL when needed) */
  conn: Database.Database;
  /** Accumulator for sync statistics — mutated by each phase */
  result: SyncResult;
  /**
   * Maps absolute file path -> DB file ID.
   * Pre-populated from all existing DB files before Phase 3;
   * Phase 3 and Phase 4 add entries for modified/new files.
   */
  fileIdMap: Map<string, number>;
  /**
   * Maps absolute file path -> (exported symbol name -> definition ID).
   * Used for cross-file reference resolution.
   */
  definitionMap: Map<string, Map<string, number>>;
  /**
   * Maps absolute file path -> (all symbol name -> definition ID).
   * Includes non-exported definitions; used for internal usage resolution.
   */
  allDefinitionMap: Map<string, Map<string, number>>;
  /**
   * File IDs for all modified and new files.
   * Built during Phases 3 and 4; consumed by Phase 6.
   */
  changedFileIds: Set<number>;
  /**
   * Module IDs collected *before* cascade-deletes remove module_members rows.
   * Phase 1 and Phase 3 populate this; Phase 8b (post-sync) consumes it.
   */
  preDeleteModuleIds: Set<number>;
  /**
   * Parsed AST data for all changed files (Phase 2) plus
   * pre-parsed dependent files (Phase 2b).
   */
  allParsedFiles: Map<string, ParsedFile>;
  /**
   * Parsed AST data for only the changed (new + modified) files.
   * Subset of allParsedFiles.
   */
  parsedChanges: Map<string, ParsedFile>;
  /** Absolute path to the source directory being indexed */
  sourceDirectory: string;
  /** Whether to emit verbose log messages */
  verbose: boolean;
  /** Log function for verbose output */
  log: (msg: string) => void;
}
