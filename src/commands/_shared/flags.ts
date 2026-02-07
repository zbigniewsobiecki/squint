import { Flags } from '@oclif/core';

/**
 * Shared flag definitions for consistent CLI experience across commands.
 */
export const SharedFlags = {
  database: Flags.string({
    char: 'd',
    description: 'Path to the index database',
    default: 'index.db',
  }),

  symbolName: Flags.string({
    char: 'n',
    description: 'Symbol name',
  }),

  symbolId: Flags.integer({
    description: 'Symbol ID',
  }),

  symbolFile: Flags.string({
    char: 'f',
    description: 'Disambiguate by file path',
  }),

  json: Flags.boolean({
    description: 'Output as JSON',
    default: false,
  }),

  aspect: Flags.string({
    char: 'a',
    description: 'Metadata aspect key',
  }),
};
