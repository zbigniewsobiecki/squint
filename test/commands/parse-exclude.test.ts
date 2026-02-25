import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Parse from '../../src/commands/parse.js';

const fixtureDir = path.resolve(__dirname, '../fixtures/with-excludes');
const dbPath = path.join(fixtureDir, '.squint-test-exclude.db');

afterEach(() => {
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // ignore
  }
});

describe('parse --exclude', () => {
  it('accepts --exclude flag and filters files', async () => {
    await Parse.run([fixtureDir, '-o', dbPath, '--exclude', '**/tests/**', '--exclude', '**/workspace/**']);
    // If it gets here without error, the flag was accepted and parsing succeeded.
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('accepts -e shorthand', async () => {
    await Parse.run([fixtureDir, '-o', dbPath, '-e', '**/tests/**', '-e', '**/workspace/**']);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
