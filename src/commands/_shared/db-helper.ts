import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Command } from '@oclif/core';
import chalk from 'chalk';
import { IndexDatabase } from '../../db/database.js';

const DB_NAME = '.squint.db';

/**
 * Walk up from CWD looking for a .squint.db file.
 * Returns the absolute path if found, null otherwise.
 */
function findDatabase(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, DB_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolve the database path from the flag value.
 * Priority: explicit flag > SQUINT_DB_PATH env var > walk-up discovery.
 */
export function resolveDbPath(dbPath: string | undefined, command: Command): string {
  if (dbPath) return path.resolve(dbPath);
  const envPath = process.env.SQUINT_DB_PATH;
  if (envPath) return path.resolve(envPath);
  const found = findDatabase();
  if (!found) {
    command.error(
      chalk.red(
        'No .squint.db found in current directory or any parent.\n' +
          "Run 'squint parse <directory>' first, or specify -d <path> or set SQUINT_DB_PATH."
      )
    );
  }
  return found;
}

/**
 * Open a database, checking that it exists first.
 * Throws Command.error() if the database doesn't exist or can't be opened.
 */
export async function openDatabase(dbPath: string | undefined, command: Command): Promise<IndexDatabase> {
  const resolvedPath = resolveDbPath(dbPath, command);

  // Check if database exists
  try {
    await fsPromises.access(resolvedPath);
  } catch {
    command.error(
      chalk.red(
        `Database file "${resolvedPath}" does not exist.\nRun 'squint parse <directory>' first to create an index.`
      )
    );
  }

  // Open database
  try {
    return new IndexDatabase(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    command.error(chalk.red(`Failed to open database: ${message}`));
  }
}

/**
 * Execute a function with a database connection, ensuring it's closed afterward.
 * Combines database opening and try/finally pattern.
 */
export async function withDatabase<T>(
  dbPath: string | undefined,
  command: Command,
  fn: (db: IndexDatabase) => Promise<T>
): Promise<T> {
  const db = await openDatabase(dbPath, command);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
