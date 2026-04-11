import type { Command } from '@oclif/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompleteWithLoggingOptions } from '../../../src/commands/llm/_shared/llm-utils.js';

// Mock completeWithLogging BEFORE importing the file under test so the import
// resolves to the stub. The mock captures every call so tests can assert on
// the prompts that were sent.
const mockLlmCall = vi.fn<(opts: CompleteWithLoggingOptions) => Promise<string>>(
  async () => '```csv\nfrom_module,to_module,semantic\n```'
);
vi.mock('../../../src/commands/llm/_shared/llm-utils.js', () => ({
  completeWithLogging: (opts: CompleteWithLoggingOptions) => mockLlmCall(opts),
}));

import { generateAstSemantics } from '../../../src/commands/interactions/_shared/ast-semantics.js';
import { IndexDatabase } from '../../../src/db/database-facade.js';
import type { EnrichedModuleCallEdge } from '../../../src/db/schema.js';

function stubCommand(): Command {
  return { log: () => undefined } as unknown as Command;
}

describe('generateAstSemantics', () => {
  let db: IndexDatabase;
  let fromModuleId: number;
  let toModuleId: number;
  let requireAuthDefId: number;

  beforeEach(() => {
    mockLlmCall.mockClear();
    mockLlmCall.mockResolvedValue('```csv\nfrom_module,to_module,semantic\n```');

    db = new IndexDatabase(':memory:');
    db.initialize();

    // Set up two modules: a controllers module and a middleware module.
    const rootId = db.modules.ensureRoot();
    fromModuleId = db.modules.insert(rootId, 'app.controllers', 'Controllers');
    toModuleId = db.modules.insert(rootId, 'app.middleware', 'Middleware');

    // Set up the called symbol's definition with a known purpose annotation.
    const middlewareFile = db.files.insert({
      path: '/src/middleware/auth.middleware.ts',
      language: 'typescript',
      contentHash: 'mid1',
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
    requireAuthDefId = db.files.insertDefinition(middlewareFile, {
      name: 'requireAuth',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });
    db.modules.assignSymbol(requireAuthDefId, toModuleId);
    db.metadata.set(requireAuthDefId, 'purpose', 'Express middleware that rejects unauthenticated requests with 401');

    // A second called symbol with no purpose annotation, to verify graceful fallback.
    const helperDefId = db.files.insertDefinition(middlewareFile, {
      name: 'rateLimit',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 7, column: 0 },
      endPosition: { row: 10, column: 1 },
    });
    db.modules.assignSymbol(helperDefId, toModuleId);
  });

  function makeEdge(overrides: Partial<EnrichedModuleCallEdge> = {}): EnrichedModuleCallEdge {
    return {
      fromModuleId,
      toModuleId,
      fromModulePath: 'app.controllers',
      toModulePath: 'app.middleware',
      weight: 2,
      calledSymbols: [
        { name: 'requireAuth', kind: 'function', callCount: 2 },
        { name: 'rateLimit', kind: 'function', callCount: 1 },
      ],
      avgCallsPerSymbol: 1.5,
      distinctCallers: 1,
      isHighFrequency: false,
      edgePattern: 'business',
      minUsageLine: 10,
      ...overrides,
    };
  }

  it('passes called-symbol purposes into the user prompt', async () => {
    await generateAstSemantics([makeEdge()], 'test-model', db, stubCommand(), true, 0, 1);

    expect(mockLlmCall).toHaveBeenCalledOnce();
    const userPrompt = mockLlmCall.mock.calls[0][0].userPrompt;

    // The purpose for `requireAuth` should appear in the prompt so the LLM
    // has architectural context, not just the bare symbol name + import line.
    expect(userPrompt).toContain('Express middleware that rejects unauthenticated requests');
  });

  it('falls back gracefully when a called symbol has no purpose annotation', async () => {
    await generateAstSemantics([makeEdge()], 'test-model', db, stubCommand(), true, 0, 1);

    expect(mockLlmCall).toHaveBeenCalledOnce();
    const userPrompt = mockLlmCall.mock.calls[0][0].userPrompt;

    // `rateLimit` has no purpose set; the prompt should still mention the symbol
    // (so the LLM knows the edge exists) without crashing or omitting it.
    expect(userPrompt).toContain('rateLimit');
  });

  it('system prompt forbids describing edges as literal import statements', async () => {
    await generateAstSemantics([makeEdge()], 'test-model', db, stubCommand(), true, 0, 1);

    expect(mockLlmCall).toHaveBeenCalledOnce();
    const systemPrompt = mockLlmCall.mock.calls[0][0].systemPrompt;

    // PR1/4: explicit anti-pattern guidance — the LLM was producing
    // "uses an import statement" instead of "guards endpoints with middleware".
    expect(systemPrompt).toContain('architectural USE');
    expect(systemPrompt).toMatch(/import statement|imports? X/i);
  });

  it('still includes the symbol names alongside the new purpose context', async () => {
    await generateAstSemantics([makeEdge()], 'test-model', db, stubCommand(), true, 0, 1);

    expect(mockLlmCall).toHaveBeenCalledOnce();
    const userPrompt = mockLlmCall.mock.calls[0][0].userPrompt;

    // Sanity: the existing symbol-list rendering must not be lost when adding
    // the purpose lookup.
    expect(userPrompt).toContain('requireAuth');
    expect(userPrompt).toContain('rateLimit');
    expect(userPrompt).toContain('app.controllers');
    expect(userPrompt).toContain('app.middleware');
  });
});
