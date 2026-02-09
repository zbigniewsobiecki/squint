import { Flags } from '@oclif/core';

/**
 * Shared flag definitions for consistent CLI experience across commands.
 */
export const LlmFlags = {
  model: Flags.string({ char: 'm', description: 'LLM model alias', default: 'openrouter:google/gemini-2.5-flash' }),
  'dry-run': Flags.boolean({ description: 'Show results without persisting', default: false }),
  force: Flags.boolean({ description: 'Re-run even if data already exists', default: false }),
  verbose: Flags.boolean({ description: 'Show detailed progress', default: false }),
  'show-llm-requests': Flags.boolean({ description: 'Show full LLM request prompts', default: false }),
  'show-llm-responses': Flags.boolean({ description: 'Show full LLM responses', default: false }),
};

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
