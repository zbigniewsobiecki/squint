import path from 'node:path';
import type { Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';

export interface ResolvedSymbol {
  id: number;
}

export interface ResolvedSymbolWithDetails {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  isExported: boolean;
}

/**
 * Utility class for resolving symbols by name, ID, or file path.
 * Handles disambiguation when multiple symbols match.
 */
export class SymbolResolver {
  constructor(
    private db: IndexDatabase,
    private command: Command
  ) {}

  /**
   * Resolve a symbol with interactive disambiguation.
   * Shows disambiguation options and returns null if user needs to specify more.
   * Throws Command.error() if symbol is not found.
   */
  resolve(name?: string, id?: number, filePath?: string, flagPrefix?: string): ResolvedSymbol | null {
    const prefix = flagPrefix ?? '';
    const idFlag = prefix ? `--${prefix}-id` : '--id';
    const fileFlag = prefix ? `--${prefix}-file` : '--file';
    const nameRequiredMsg = prefix ? `--${prefix} or ${idFlag} is required` : 'Symbol name is required';

    // Direct ID lookup
    if (id !== undefined) {
      const def = this.db.getDefinitionById(id);
      if (!def) {
        this.command.error(chalk.red(`No definition found with ID ${id}`));
      }
      return { id };
    }

    // Name lookup
    if (!name) {
      this.command.error(chalk.red(nameRequiredMsg));
    }

    let matches = this.db.getDefinitionsByName(name);

    if (matches.length === 0) {
      this.command.error(chalk.red(`No symbol found with name "${name}"`));
    }

    // Filter by file if specified
    if (filePath) {
      const resolvedPath = path.resolve(filePath);
      matches = matches.filter((m) => m.filePath === resolvedPath || m.filePath.endsWith(filePath));

      if (matches.length === 0) {
        this.command.error(chalk.red(`No symbol "${name}" found in file "${filePath}"`));
      }
    }

    // Disambiguation needed
    if (matches.length > 1) {
      this.command.log(chalk.yellow(`Multiple symbols found with name "${name}":`));
      this.command.log('');
      for (const match of matches) {
        this.command.log(`  ${chalk.cyan(idFlag)} ${match.id}\t${match.kind}\t${match.filePath}:${match.line}`);
      }
      this.command.log('');
      this.command.log(chalk.gray(`Use ${idFlag} or ${fileFlag} to disambiguate`));
      return null;
    }

    return { id: matches[0].id };
  }

  /**
   * Resolve a symbol silently (for batch operations).
   * Returns null if not found or ambiguous, without printing errors.
   */
  resolveSilent(name?: string, id?: number, filePath?: string): ResolvedSymbolWithDetails | null {
    // Direct ID lookup
    if (id !== undefined) {
      const def = this.db.getDefinitionById(id);
      if (!def) return null;
      return {
        id: def.id,
        name: def.name,
        kind: def.kind,
        filePath: def.filePath,
        line: def.line,
        endLine: def.endLine,
        isExported: def.isExported,
      };
    }

    // Name lookup
    if (!name) return null;

    let matches = this.db.getDefinitionsByName(name);
    if (matches.length === 0) return null;

    // Filter by file if specified
    if (filePath) {
      const resolvedPath = path.resolve(filePath);
      matches = matches.filter((m) => m.filePath === resolvedPath || m.filePath.endsWith(filePath));
      if (matches.length === 0) return null;
    }

    // Ambiguous
    if (matches.length > 1) return null;

    return matches[0];
  }
}
