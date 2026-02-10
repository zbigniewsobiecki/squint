import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexDatabase } from '../db/database.js';
import { MIME_TYPES, createServer, getMimeType, startServer } from './server.js';

// Create a mock database with all required methods using repository-style access
function createMockDb() {
  const mockDb = {
    getStats: vi.fn().mockReturnValue({ files: 10, definitions: 50, references: 100, imports: 20 }),
    files: {
      getAll: vi.fn().mockReturnValue([{ id: 1, path: 'test.ts' }]),
      getById: vi.fn().mockReturnValue({ id: 1, path: 'test.ts' }),
      getImports: vi.fn().mockReturnValue([]),
    },
    definitions: {
      getAll: vi.fn().mockReturnValue([]),
      getById: vi.fn().mockReturnValue(null),
      getForFile: vi.fn().mockReturnValue([]),
      getClassHierarchy: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    },
    dependencies: {
      getCallsites: vi.fn().mockReturnValue([]),
      getImportGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    },
    relationships: {
      getAll: vi.fn().mockReturnValue([]),
    },
    metadata: {
      get: vi.fn().mockReturnValue({}),
    },
    modules: {
      getAll: vi.fn().mockReturnValue([]),
      getAllWithMembers: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({ moduleCount: 0, assigned: 0, unassigned: 0 }),
      getWithMembers: vi.fn().mockReturnValue(null),
    },
    interactions: {
      getAll: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({ totalCount: 0, businessCount: 0, utilityCount: 0, biDirectionalCount: 0 }),
      getById: vi.fn().mockReturnValue(null),
    },
    interactionAnalysis: {
      getRelationshipCoverage: vi.fn().mockReturnValue({
        totalRelationships: 0,
        crossModuleRelationships: 0,
        relationshipsContributingToInteractions: 0,
        sameModuleCount: 0,
        orphanedCount: 0,
        coveragePercent: 0,
      }),
    },
    flows: {
      getAll: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({ flowCount: 0, withEntryPointCount: 0, avgStepsPerFlow: 0 }),
      getCoverage: vi.fn().mockReturnValue({ totalInteractions: 0, coveredByFlows: 0, percentage: 0 }),
      getWithSteps: vi.fn().mockReturnValue(null),
      getWithDefinitionSteps: vi.fn().mockReturnValue(null),
      expand: vi.fn().mockReturnValue([]),
    },
    callGraph: {
      getModuleCallGraph: vi.fn().mockReturnValue([]),
    },
    features: {
      getAll: vi.fn().mockReturnValue([]),
      getWithFlows: vi.fn().mockReturnValue(null),
    },
  };
  return mockDb as unknown as IndexDatabase;
}

// Helper to make HTTP request to server
function makeRequest(
  server: http.Server,
  path: string,
  method = 'GET'
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('Server not listening'));
      return;
    }

    const req = http.request(
      {
        hostname: 'localhost',
        port: address.port,
        path,
        method,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode!, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('server', () => {
  describe('getMimeType', () => {
    it('returns correct MIME type for HTML', () => {
      expect(getMimeType('.html')).toBe('text/html');
    });

    it('returns correct MIME type for CSS', () => {
      expect(getMimeType('.css')).toBe('text/css');
    });

    it('returns correct MIME type for JavaScript', () => {
      expect(getMimeType('.js')).toBe('application/javascript');
    });

    it('returns correct MIME type for JSON', () => {
      expect(getMimeType('.json')).toBe('application/json');
    });

    it('returns correct MIME type for PNG', () => {
      expect(getMimeType('.png')).toBe('image/png');
    });

    it('returns correct MIME type for JPG', () => {
      expect(getMimeType('.jpg')).toBe('image/jpeg');
    });

    it('returns correct MIME type for SVG', () => {
      expect(getMimeType('.svg')).toBe('image/svg+xml');
    });

    it('returns correct MIME type for ICO', () => {
      expect(getMimeType('.ico')).toBe('image/x-icon');
    });

    it('returns correct MIME type for WOFF', () => {
      expect(getMimeType('.woff')).toBe('font/woff');
    });

    it('returns correct MIME type for WOFF2', () => {
      expect(getMimeType('.woff2')).toBe('font/woff2');
    });

    it('returns application/octet-stream for unknown extensions', () => {
      expect(getMimeType('.xyz')).toBe('application/octet-stream');
      expect(getMimeType('.unknown')).toBe('application/octet-stream');
      expect(getMimeType('')).toBe('application/octet-stream');
    });
  });

  describe('MIME_TYPES', () => {
    it('contains expected extensions', () => {
      expect(MIME_TYPES).toHaveProperty('.html');
      expect(MIME_TYPES).toHaveProperty('.css');
      expect(MIME_TYPES).toHaveProperty('.js');
      expect(MIME_TYPES).toHaveProperty('.json');
      expect(MIME_TYPES).toHaveProperty('.png');
      expect(MIME_TYPES).toHaveProperty('.jpg');
      expect(MIME_TYPES).toHaveProperty('.svg');
      expect(MIME_TYPES).toHaveProperty('.ico');
      expect(MIME_TYPES).toHaveProperty('.woff');
      expect(MIME_TYPES).toHaveProperty('.woff2');
    });
  });

  describe('createServer', () => {
    let mockDb: IndexDatabase;
    let server: http.Server;

    beforeEach(() => {
      mockDb = createMockDb();
    });

    afterEach(() => {
      if (server) {
        server.close();
      }
    });

    it('creates an HTTP server', () => {
      server = createServer(mockDb, 3000);
      expect(server).toBeInstanceOf(http.Server);
    });

    describe('API routes', () => {
      beforeEach(async () => {
        server = createServer(mockDb, 0); // Use port 0 to get random available port
        await startServer(server, 0);
      });

      it('GET /api/stats returns JSON with stats', async () => {
        const response = await makeRequest(server, '/api/stats');

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('application/json');
        expect(JSON.parse(response.body)).toEqual({ files: 10, definitions: 50, references: 100, imports: 20 });
        expect(mockDb.getStats).toHaveBeenCalled();
      });

      it('GET /api/files returns all files', async () => {
        const response = await makeRequest(server, '/api/files');

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('application/json');
        expect(JSON.parse(response.body)).toEqual([{ id: 1, path: 'test.ts' }]);
        expect(mockDb.files.getAll).toHaveBeenCalled();
      });

      it('GET /api/files/:id returns file with definitions and imports', async () => {
        (mockDb.files.getById as any).mockReturnValue({ id: 1, path: 'test.ts' });
        (mockDb.definitions.getForFile as any).mockReturnValue([{ id: 1, name: 'foo' }]);
        (mockDb.files.getImports as any).mockReturnValue([{ id: 1, module: 'bar' }]);

        const response = await makeRequest(server, '/api/files/1');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.id).toBe(1);
        expect(body.definitions).toEqual([{ id: 1, name: 'foo' }]);
        expect(body.imports).toEqual([{ id: 1, module: 'bar' }]);
      });

      it('GET /api/files/:id returns 404 for non-existent file', async () => {
        (mockDb.files.getById as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/files/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'File not found' });
      });

      it('GET /api/definitions returns all definitions', async () => {
        const mockDefs = [{ id: 1, name: 'test', kind: 'function' }];
        (mockDb.definitions.getAll as any).mockReturnValue(mockDefs);

        const response = await makeRequest(server, '/api/definitions');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockDefs);
      });

      it('GET /api/definitions/:id returns definition', async () => {
        const mockDef = { id: 1, name: 'test', kind: 'function' };
        (mockDb.definitions.getById as any).mockReturnValue(mockDef);

        const response = await makeRequest(server, '/api/definitions/1');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockDef);
      });

      it('GET /api/definitions/:id returns 404 for non-existent definition', async () => {
        (mockDb.definitions.getById as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/definitions/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'Definition not found' });
      });

      it('GET /api/definitions/:id/callsites returns callsites', async () => {
        const mockCallsites = [{ id: 1, filePath: 'test.ts', line: 10 }];
        (mockDb.dependencies.getCallsites as any).mockReturnValue(mockCallsites);

        const response = await makeRequest(server, '/api/definitions/1/callsites');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockCallsites);
      });

      it('GET /api/graph/imports returns import graph', async () => {
        const mockGraph = { nodes: [], edges: [] };
        (mockDb.dependencies.getImportGraph as any).mockReturnValue(mockGraph);

        const response = await makeRequest(server, '/api/graph/imports');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockGraph);
      });

      it('GET /api/graph/classes returns class hierarchy', async () => {
        const mockHierarchy = { nodes: [], edges: [] };
        (mockDb.definitions.getClassHierarchy as any).mockReturnValue(mockHierarchy);

        const response = await makeRequest(server, '/api/graph/classes');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockHierarchy);
      });

      it('GET /api/modules returns modules data', async () => {
        (mockDb.modules.getAllWithMembers as any).mockReturnValue([]);
        (mockDb.modules.getStats as any).mockReturnValue({ moduleCount: 0, assigned: 0, unassigned: 0 });

        const response = await makeRequest(server, '/api/modules');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('modules');
        expect(body).toHaveProperty('stats');
      });

      it('GET /api/modules/stats returns module stats', async () => {
        (mockDb.modules.getStats as any).mockReturnValue({ moduleCount: 5, assigned: 20, unassigned: 10 });

        const response = await makeRequest(server, '/api/modules/stats');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ moduleCount: 5, assigned: 20, unassigned: 10 });
      });

      it('GET /api/modules/:id returns module with members', async () => {
        const mockModule = { id: 1, name: 'core', members: [] };
        (mockDb.modules.getWithMembers as any).mockReturnValue(mockModule);

        const response = await makeRequest(server, '/api/modules/1');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockModule);
      });

      it('GET /api/modules/:id returns 404 for non-existent module', async () => {
        (mockDb.modules.getWithMembers as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/modules/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'Module not found' });
      });

      it('GET /api/flows returns flows data', async () => {
        (mockDb.flows.getAll as any).mockReturnValue([]);
        (mockDb.flows.getStats as any).mockReturnValue({
          flowCount: 0,
          withEntryPointCount: 0,
          avgStepsPerFlow: 0,
        });
        (mockDb.flows.getCoverage as any).mockReturnValue({
          totalInteractions: 0,
          coveredByFlows: 0,
          percentage: 0,
        });

        const response = await makeRequest(server, '/api/flows');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('flows');
        expect(body).toHaveProperty('stats');
        expect(body).toHaveProperty('coverage');
      });

      it('GET /api/flows/stats returns flow stats', async () => {
        (mockDb.flows.getStats as any).mockReturnValue({
          flowCount: 3,
          withEntryPointCount: 2,
          avgStepsPerFlow: 4.5,
        });

        const response = await makeRequest(server, '/api/flows/stats');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ flowCount: 3, withEntryPointCount: 2, avgStepsPerFlow: 4.5 });
      });

      it('GET /api/flows/coverage returns flow coverage', async () => {
        const mockCoverage = { totalInteractions: 10, coveredByFlows: 5, percentage: 50 };
        (mockDb.flows.getCoverage as any).mockReturnValue(mockCoverage);

        const response = await makeRequest(server, '/api/flows/coverage');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockCoverage);
      });

      it('GET /api/flows/:id returns flow with steps', async () => {
        const mockFlow = { id: 1, name: 'User Login', steps: [] };
        (mockDb.flows.getWithSteps as any).mockReturnValue(mockFlow);

        const response = await makeRequest(server, '/api/flows/1');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockFlow);
      });

      it('GET /api/flows/:id returns 404 for non-existent flow', async () => {
        (mockDb.flows.getWithSteps as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/flows/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'Flow not found' });
      });

      it('GET /api/interactions returns interactions data', async () => {
        (mockDb.interactions.getAll as any).mockReturnValue([]);
        (mockDb.interactions.getStats as any).mockReturnValue({
          totalCount: 0,
          businessCount: 0,
          utilityCount: 0,
          biDirectionalCount: 0,
        });
        (mockDb.interactionAnalysis.getRelationshipCoverage as any).mockReturnValue({
          totalRelationships: 0,
          crossModuleRelationships: 0,
          relationshipsContributingToInteractions: 0,
          sameModuleCount: 0,
          orphanedCount: 0,
          coveragePercent: 0,
        });

        const response = await makeRequest(server, '/api/interactions');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('interactions');
        expect(body).toHaveProperty('stats');
        expect(body).toHaveProperty('relationshipCoverage');
      });

      it('GET /api/interactions/stats returns interaction stats', async () => {
        (mockDb.interactions.getStats as any).mockReturnValue({
          totalCount: 5,
          businessCount: 3,
          utilityCount: 2,
          biDirectionalCount: 1,
        });

        const response = await makeRequest(server, '/api/interactions/stats');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({
          totalCount: 5,
          businessCount: 3,
          utilityCount: 2,
          biDirectionalCount: 1,
        });
      });

      it('GET /api/interactions/:id returns interaction with module paths', async () => {
        (mockDb.interactions.getById as any).mockReturnValue({
          id: 1,
          fromModuleId: 10,
          toModuleId: 20,
          direction: 'uni',
          weight: 5,
        });
        (mockDb.modules.getAll as any).mockReturnValue([
          { id: 10, fullPath: 'project.auth' },
          { id: 20, fullPath: 'project.api' },
        ]);

        const response = await makeRequest(server, '/api/interactions/1');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.id).toBe(1);
        expect(body.fromModulePath).toBe('project.auth');
        expect(body.toModulePath).toBe('project.api');
      });

      it('GET /api/interactions/:id returns 404 for non-existent interaction', async () => {
        (mockDb.interactions.getById as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/interactions/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'Interaction not found' });
      });

      it('GET /api/graph/symbols returns symbol graph', async () => {
        (mockDb.definitions.getAll as any).mockReturnValue([
          { id: 1, name: 'test', kind: 'function', line: 1, endLine: 10, fileId: 1 },
        ]);
        (mockDb.relationships.getAll as any).mockReturnValue([]);
        (mockDb.files.getAll as any).mockReturnValue([{ id: 1, path: 'test.ts' }]);
        (mockDb.metadata.get as any).mockReturnValue({});
        (mockDb.modules.getAllWithMembers as any).mockReturnValue([]);

        const response = await makeRequest(server, '/api/graph/symbols');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('nodes');
        expect(body).toHaveProperty('edges');
        expect(body).toHaveProperty('stats');
      });

      it('GET /api/definitions supports kind filter', async () => {
        const mockDefs = [{ id: 1, name: 'test', kind: 'function' }];
        (mockDb.definitions.getAll as any).mockReturnValue(mockDefs);

        const response = await makeRequest(server, '/api/definitions?kind=function');

        expect(response.statusCode).toBe(200);
        expect(mockDb.definitions.getAll).toHaveBeenCalledWith({ kind: 'function', exported: undefined });
      });

      it('GET /api/definitions supports exported filter', async () => {
        const mockDefs = [{ id: 1, name: 'test', kind: 'function' }];
        (mockDb.definitions.getAll as any).mockReturnValue(mockDefs);

        const response = await makeRequest(server, '/api/definitions?exported=true');

        expect(response.statusCode).toBe(200);
        expect(mockDb.definitions.getAll).toHaveBeenCalledWith({ kind: undefined, exported: true });
      });

      it('GET /api/flows/dag returns DAG data', async () => {
        (mockDb.modules.getAllWithMembers as any).mockReturnValue([]);
        (mockDb.callGraph.getModuleCallGraph as any).mockReturnValue([]);
        (mockDb.flows.getAll as any).mockReturnValue([]);

        const response = await makeRequest(server, '/api/flows/dag');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('modules');
        expect(body).toHaveProperty('edges');
        expect(body).toHaveProperty('flows');
      });

      it('GET /api/flows/dag uses definition-level steps when available', async () => {
        (mockDb.modules.getAllWithMembers as any).mockReturnValue([
          { id: 1, parentId: null, name: 'api', fullPath: 'api', depth: 0, members: [] },
          { id: 2, parentId: null, name: 'service', fullPath: 'service', depth: 0, members: [] },
        ]);
        (mockDb.callGraph.getModuleCallGraph as any).mockReturnValue([]);
        (mockDb.flows.getAll as any).mockReturnValue([
          { id: 1, name: 'Test Flow', stakeholder: null, description: null },
        ]);
        (mockDb.flows.getWithDefinitionSteps as any).mockReturnValue({
          id: 1,
          name: 'Test Flow',
          stakeholder: null,
          description: null,
          definitionSteps: [
            {
              fromModuleId: 1,
              toModuleId: 2,
              fromDefinitionName: 'controller.create',
              toDefinitionName: 'service.create',
              fromDefinitionKind: 'function',
              toDefinitionKind: 'function',
              fromFilePath: 'api.ts',
              toFilePath: 'service.ts',
              fromLine: 10,
              toLine: 20,
              fromModulePath: 'api',
              toModulePath: 'service',
            },
          ],
        });

        const response = await makeRequest(server, '/api/flows/dag');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.flows).toHaveLength(1);
        const flow = body.flows[0];
        expect(flow.steps).toHaveLength(1);
        expect(flow.steps[0]).toEqual({
          interactionId: null,
          fromModuleId: 1,
          toModuleId: 2,
          semantic: null,
          fromDefName: 'controller.create',
          toDefName: 'service.create',
        });
      });

      it('GET /api/flows/:id/expand returns expanded flow', async () => {
        const mockExpanded = [{ id: 1, fromModulePath: 'a', toModulePath: 'b' }];
        (mockDb.flows.expand as any).mockReturnValue(mockExpanded);

        const response = await makeRequest(server, '/api/flows/1/expand');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockExpanded);
        expect(mockDb.flows.expand).toHaveBeenCalledWith(1);
      });

      it('OPTIONS request returns 204 with CORS headers', async () => {
        const response = await makeRequest(server, '/api/stats', 'OPTIONS');

        expect(response.statusCode).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('*');
        expect(response.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
      });
    });
  });

  describe('startServer', () => {
    let mockDb: IndexDatabase;

    beforeEach(() => {
      mockDb = createMockDb();
    });

    it('starts server and resolves promise', async () => {
      const server = createServer(mockDb, 0);
      await expect(startServer(server, 0)).resolves.toBeUndefined();
      server.close();
    });

    it('rejects on error', async () => {
      const server = createServer(mockDb, 0);
      // Start twice on same port should fail
      await startServer(server, 0);
      const address = server.address();
      if (address && typeof address !== 'string') {
        const server2 = createServer(mockDb, address.port);
        await expect(startServer(server2, address.port)).rejects.toThrow();
        server2.close();
      }
      server.close();
    });
  });
});
