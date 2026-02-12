#!/usr/bin/env node

import { execute } from '@oclif/core';

try {
  await execute({ dir: import.meta.url });
} catch (error) {
  const msg = error.message || '';
  if (
    msg.includes('Could not locate the bindings file') ||
    (msg.includes('Cannot find module') && /(better-sqlite3|tree-sitter)/.test(msg))
  ) {
    console.error(`Error: Native modules not built.

If you installed with pnpm globally, run:
  pnpm approve-builds -g
  pnpm add -g @zbigniewsobiecki/squint

If you installed with npm:
  npm rebuild`);
    process.exit(1);
  }
  throw error;
}
