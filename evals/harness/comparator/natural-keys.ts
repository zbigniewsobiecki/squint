import type { IndexDatabase } from '../../../src/db/database-facade.js';
import { type ContractKey, type DefKey, contractKey, defKey } from '../types.js';

/**
 * ID-agnostic natural-key extractors for every table the comparator handles.
 *
 * Why this matters: hand-authored ground truth never knows DB row IDs.
 * Two ingestion runs of the same fixture produce different IDs (insertion
 * order varies). Comparators must join on natural keys derived from
 * semantically stable columns: file paths, definition names, module
 * full_paths, etc.
 */

export function fileKeyOfRow(row: { path: string }): string {
  return row.path;
}

export function definitionKeyOf(db: IndexDatabase, definitionId: number): DefKey {
  const conn = db.getConnection();
  const row = conn
    .prepare(
      `SELECT f.path AS path, d.name AS name
       FROM definitions d
       JOIN files f ON d.file_id = f.id
       WHERE d.id = ?`
    )
    .get(definitionId) as { path: string; name: string } | undefined;
  if (!row) {
    throw new Error(`No definition with id=${definitionId}`);
  }
  return defKey(row.path, row.name);
}

export function moduleKeyOfRow(row: { fullPath: string }): string {
  return row.fullPath;
}

export function contractKeyOfRow(row: { protocol: string; normalizedKey: string }): ContractKey {
  return contractKey(row.protocol, row.normalizedKey);
}

export function interactionKeyOfRow(row: { fromModulePath: string; toModulePath: string }): string {
  return `${row.fromModulePath}->${row.toModulePath}`;
}

export function flowKeyOfRow(row: { slug: string }): string {
  return row.slug;
}

/**
 * Resolve a natural definition key by looking up file path + name.
 * Returns null if not found (used by comparators to detect "missing" rows).
 */
export function definitionIdByKey(db: IndexDatabase, key: DefKey): number | null {
  const idx = key.indexOf('::');
  if (idx === -1) return null;
  const filePath = key.slice(0, idx);
  const name = key.slice(idx + 2);
  const conn = db.getConnection();
  const row = conn
    .prepare(
      `SELECT d.id AS id
       FROM definitions d
       JOIN files f ON d.file_id = f.id
       WHERE f.path = ? AND d.name = ?
       LIMIT 1`
    )
    .get(filePath, name) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Resolve a natural module key (full_path) to its DB id.
 */
export function moduleIdByKey(db: IndexDatabase, fullPath: string): number | null {
  const conn = db.getConnection();
  const row = conn.prepare('SELECT id FROM modules WHERE full_path = ? LIMIT 1').get(fullPath) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/**
 * Resolve a natural contract key (protocol::normalized_key) to its DB id.
 */
export function contractIdByKey(db: IndexDatabase, key: ContractKey): number | null {
  const idx = key.indexOf('::');
  if (idx === -1) return null;
  const protocol = key.slice(0, idx);
  const normalizedKey = key.slice(idx + 2);
  const conn = db.getConnection();
  const row = conn
    .prepare('SELECT id FROM contracts WHERE protocol = ? AND normalized_key = ? LIMIT 1')
    .get(protocol, normalizedKey) as { id: number } | undefined;
  return row?.id ?? null;
}
