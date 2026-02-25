import { type MockInstance, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock llmist before importing the module under test
const mockStream = vi.fn();
vi.mock('llmist', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    LLMist: class {
      stream = mockStream;
      modelRegistry = {
        estimateCost: () => ({ totalCost: 0.001 }),
      };
    },
    isRetryableError: (error: Error) => error.message.includes('[retryable]'),
  };
});

import { completeWithLogging } from '../../../src/commands/llm/_shared/llm-utils.js';

function makeCommand() {
  return { log: vi.fn() } as unknown as import('@oclif/core').Command;
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    model: 'openrouter:google/gemini-2.5-flash',
    systemPrompt: 'You are a test assistant.',
    userPrompt: 'Say hello.',
    command: makeCommand(),
    isJson: false,
    ...overrides,
  };
}

/** Helper: create an async iterable that yields chunks then completes. */
function successStream(text: string, usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { text, usage };
    },
  };
}

/** Helper: create an async iterable that throws on first iteration. */
function failingStream(error: unknown) {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<never>> {
          throw error;
        },
      };
    },
  };
}

describe('completeWithLogging retry logic', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('returns text on first successful attempt', async () => {
    mockStream.mockReturnValue(successStream('Hello world'));

    const result = await completeWithLogging(baseOptions());

    expect(result).toBe('Hello world');
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    mockStream
      .mockReturnValueOnce(failingStream(new Error('[retryable] SSE stream error')))
      .mockReturnValueOnce(successStream('Recovered'));

    const opts = baseOptions();
    const result = await completeWithLogging(opts);

    expect(result).toBe('Recovered');
    expect(mockStream).toHaveBeenCalledTimes(2);

    // Verify retry was logged
    const command = opts.command as unknown as { log: MockInstance };
    const logCalls = command.log.mock.calls.map((c: unknown[]) => c[0]);
    expect(logCalls.some((msg: string) => msg.includes('LLM error (attempt 1/4)'))).toBe(true);
  });

  it('throws immediately on non-retryable error', async () => {
    const fatalError = new Error('Invalid API key');
    mockStream.mockReturnValue(failingStream(fatalError));

    await expect(completeWithLogging(baseOptions())).rejects.toThrow('Invalid API key');
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', { timeout: 15_000 }, async () => {
    const retryableError = new Error('[retryable] server overloaded');
    mockStream.mockReturnValue(failingStream(retryableError));

    await expect(completeWithLogging(baseOptions())).rejects.toThrow('[retryable] server overloaded');
    // 1 initial + 3 retries = 4 total attempts
    expect(mockStream).toHaveBeenCalledTimes(4);
  });

  it('succeeds on third attempt after two retryable failures', async () => {
    mockStream
      .mockReturnValueOnce(failingStream(new Error('[retryable] error 1')))
      .mockReturnValueOnce(failingStream(new Error('[retryable] error 2')))
      .mockReturnValueOnce(successStream('Finally'));

    const result = await completeWithLogging(baseOptions());
    expect(result).toBe('Finally');
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it('resets text and usage on each retry attempt', async () => {
    // First call: yields partial text then throws
    const partialThenFail = {
      async *[Symbol.asyncIterator]() {
        yield { text: 'partial', usage: { inputTokens: 99, outputTokens: 99, cachedInputTokens: 0 } };
        throw new Error('[retryable] mid-stream');
      },
    };

    mockStream.mockReturnValueOnce(partialThenFail).mockReturnValueOnce(successStream('Clean'));

    const result = await completeWithLogging(baseOptions());
    // Should NOT contain leftover "partial" text
    expect(result).toBe('Clean');
  });

  it('suppresses retry log messages in JSON mode', async () => {
    mockStream
      .mockReturnValueOnce(failingStream(new Error('[retryable] transient')))
      .mockReturnValueOnce(successStream('OK'));

    const opts = baseOptions({ isJson: true });
    await completeWithLogging(opts);

    const command = opts.command as unknown as { log: MockInstance };
    const logCalls = command.log.mock.calls.map((c: unknown[]) => c[0]);
    expect(logCalls.every((msg: string) => !msg.includes('LLM error'))).toBe(true);
  });

  it('does not retry non-Error throwables', async () => {
    // Throwing a string (not an Error instance) — should not be retried
    mockStream.mockReturnValue(failingStream('raw string error'));

    await expect(completeWithLogging(baseOptions())).rejects.toBe('raw string error');
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});
