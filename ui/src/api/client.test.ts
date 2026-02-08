import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import type { ApiClient } from './client';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('client', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = createApiClient();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSuccessResponse(data: unknown) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(data),
    });
  }

  function mockErrorResponse(status: number, statusText: string) {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      statusText,
    });
  }

  describe('createApiClient', () => {
    it('creates client with default empty baseUrl', () => {
      const defaultClient = createApiClient();
      mockSuccessResponse({ files: 10 });

      defaultClient.getStats();

      expect(mockFetch).toHaveBeenCalledWith('/api/stats');
    });

    it('creates client with custom baseUrl', () => {
      const customClient = createApiClient('http://localhost:3000');
      mockSuccessResponse({ files: 10 });

      customClient.getStats();

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/api/stats');
    });
  });

  describe('getStats', () => {
    it('fetches stats from /api/stats', async () => {
      const mockData = { files: 100, definitions: 500, references: 1000, imports: 200 };
      mockSuccessResponse(mockData);

      const result = await client.getStats();

      expect(mockFetch).toHaveBeenCalledWith('/api/stats');
      expect(result).toEqual(mockData);
    });

    it('throws error on non-ok response', async () => {
      mockErrorResponse(404, 'Not Found');

      await expect(client.getStats()).rejects.toThrow('API error: 404 Not Found');
    });
  });

  describe('getSymbolGraph', () => {
    it('fetches symbol graph from /api/graph/symbols', async () => {
      const mockData = {
        nodes: [{ id: 1, name: 'test', kind: 'function', filePath: 'test.ts', hasAnnotations: false, lines: 10 }],
        edges: [],
        stats: { totalSymbols: 1, annotatedSymbols: 0, totalRelationships: 0, moduleCount: 0 },
      };
      mockSuccessResponse(mockData);

      const result = await client.getSymbolGraph();

      expect(mockFetch).toHaveBeenCalledWith('/api/graph/symbols');
      expect(result).toEqual(mockData);
    });

    it('throws error on server error', async () => {
      mockErrorResponse(500, 'Internal Server Error');

      await expect(client.getSymbolGraph()).rejects.toThrow('API error: 500 Internal Server Error');
    });
  });

  describe('getModules', () => {
    it('fetches modules from /api/modules', async () => {
      const mockData = {
        modules: [
          {
            id: 1,
            parentId: null,
            slug: 'core',
            name: 'core',
            fullPath: 'core',
            description: null,
            depth: 0,
            memberCount: 5,
            members: [],
          },
        ],
        stats: { moduleCount: 1, assigned: 5, unassigned: 3 },
      };
      mockSuccessResponse(mockData);

      const result = await client.getModules();

      expect(mockFetch).toHaveBeenCalledWith('/api/modules');
      expect(result).toEqual(mockData);
    });
  });

  describe('getFlows', () => {
    it('fetches flows from /api/flows', async () => {
      const mockData = {
        flows: [
          {
            id: 1,
            name: 'User Login',
            slug: 'user-login',
            entryPath: '/login',
            stakeholder: 'User',
            description: null,
            stepCount: 3,
            steps: [],
          },
        ],
        stats: { flowCount: 1, withEntryPointCount: 1, avgStepsPerFlow: 3 },
        coverage: { totalInteractions: 10, coveredByFlows: 5, percentage: 50 },
      };
      mockSuccessResponse(mockData);

      const result = await client.getFlows();

      expect(mockFetch).toHaveBeenCalledWith('/api/flows');
      expect(result).toEqual(mockData);
    });
  });

  describe('getFlowsDag', () => {
    it('fetches flows DAG from /api/flows/dag', async () => {
      const mockData = {
        modules: [{ id: 1, parentId: null, name: 'core', fullPath: 'core', depth: 0, memberCount: 5 }],
        edges: [{ fromModuleId: 1, toModuleId: 2, weight: 3 }],
        flows: [{ id: 1, name: 'Test Flow', stakeholder: null, stepCount: 2, steps: [] }],
      };
      mockSuccessResponse(mockData);

      const result = await client.getFlowsDag();

      expect(mockFetch).toHaveBeenCalledWith('/api/flows/dag');
      expect(result).toEqual(mockData);
    });
  });

  describe('getInteractions', () => {
    it('fetches interactions from /api/interactions', async () => {
      const mockData = {
        interactions: [
          {
            id: 1,
            fromModuleId: 1,
            toModuleId: 2,
            fromModulePath: 'a',
            toModulePath: 'b',
            direction: 'forward',
            weight: 1,
            pattern: null,
            symbols: null,
            semantic: null,
          },
        ],
        stats: { totalCount: 1, businessCount: 0, utilityCount: 1, biDirectionalCount: 0 },
        relationshipCoverage: {
          totalRelationships: 10,
          crossModuleRelationships: 5,
          relationshipsContributingToInteractions: 3,
          sameModuleCount: 4,
          orphanedCount: 1,
          coveragePercent: 50,
        },
      };
      mockSuccessResponse(mockData);

      const result = await client.getInteractions();

      expect(mockFetch).toHaveBeenCalledWith('/api/interactions');
      expect(result).toEqual(mockData);
    });
  });

  describe('error handling', () => {
    it('propagates network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.getStats()).rejects.toThrow('Network error');
    });

    it('handles 401 unauthorized', async () => {
      mockErrorResponse(401, 'Unauthorized');

      await expect(client.getModules()).rejects.toThrow('API error: 401 Unauthorized');
    });

    it('handles 403 forbidden', async () => {
      mockErrorResponse(403, 'Forbidden');

      await expect(client.getFlows()).rejects.toThrow('API error: 403 Forbidden');
    });
  });
});
