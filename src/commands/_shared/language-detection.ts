/**
 * Utilities for detecting the project language from the database
 * and resolving per-file languages for symbols.
 */

import type { IndexDatabase } from '../../db/database.js';
import type { SupportedLanguage } from '../llm/_shared/prompts.js';

/**
 * Detect the majority language of the project from the files table.
 * Returns 'typescript' for TS/JS projects, 'ruby' for Ruby projects.
 */
export function detectProjectLanguage(db: IndexDatabase): SupportedLanguage {
  const conn = db.getConnection();
  const rows = conn
    .prepare('SELECT language, COUNT(*) as cnt FROM files GROUP BY language ORDER BY cnt DESC')
    .all() as Array<{ language: string; cnt: number }>;

  if (rows.length === 0) return 'typescript';

  const top = rows[0].language.toLowerCase();
  if (top === 'ruby') return 'ruby';
  if (top === 'javascript') return 'javascript';
  return 'typescript';
}

/**
 * Build a map from file path to SupportedLanguage for all files in the DB.
 * Used for per-symbol language resolution in mixed-language projects.
 */
export function buildFileLanguageMap(db: IndexDatabase): Map<string, SupportedLanguage> {
  const conn = db.getConnection();
  const rows = conn.prepare('SELECT path, language FROM files').all() as Array<{ path: string; language: string }>;

  const map = new Map<string, SupportedLanguage>();
  for (const row of rows) {
    const lang = row.language.toLowerCase();
    if (lang === 'ruby') {
      map.set(row.path, 'ruby');
    } else if (lang === 'javascript') {
      map.set(row.path, 'javascript');
    } else {
      map.set(row.path, 'typescript');
    }
  }
  return map;
}
