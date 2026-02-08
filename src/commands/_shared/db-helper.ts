import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from '@oclif/core';
import chalk from 'chalk';
import { IndexDatabase } from '../../db/database.js';

/**
 * Open a database, checking that it exists first.
 * Throws Command.error() if the database doesn't exist or can't be opened.
 */
export async function openDatabase(dbPath: string, command: Command): Promise<IndexDatabase> {
  const resolvedPath = path.resolve(dbPath);

  // Check if database exists
  try {
    await fs.access(resolvedPath);
  } catch {
    command.error(
      chalk.red(
        `Database file "${resolvedPath}" does not exist.\nRun 'ats parse <directory>' first to create an index.`
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
  dbPath: string,
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
