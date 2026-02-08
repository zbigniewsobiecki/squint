import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { createServer, startServer, getMimeType, MIME_TYPES } from './server.js';
import type { IndexDatabase } from '../db/database.js';

// Create a mock database with all required methods
function createMockDb(): IndexDatabase {
  return {
    getStats: vi.fn().mockReturnValue({ files: 10, definitions: 50, references: 100, imports: 20 }),
    getAllFiles: vi.fn().mockReturnValue([{ id: 1, path: 'test.ts' }]),
    getFileById: vi.fn().mockReturnValue({ id: 1, path: 'test.ts' }),
    getFileDefinitions: vi.fn().mockReturnValue([]),
    getFileImports: vi.fn().mockReturnValue([]),
    getAllDefinitions: vi.fn().mockReturnValue([]),
    getDefinitionById: vi.fn().mockReturnValue(null),
    getCallsites: vi.fn().mockReturnValue([]),
    getImportGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    getClassHierarchy: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    getAllRelationshipAnnotations: vi.fn().mockReturnValue([]),
    getDefinitionMetadata: vi.fn().mockReturnValue({}),
    getAllModulesWithMembers: vi.fn().mockReturnValue([]),
    getAllModules: vi.fn().mockReturnValue([]),
    getModuleStats: vi.fn().mockReturnValue({ moduleCount: 0, assigned: 0, unassigned: 0 }),
    getModuleWithMembers: vi.fn().mockReturnValue(null),
    getAllInteractions: vi.fn().mockReturnValue([]),
    getInteractionStats: vi.fn().mockReturnValue({ totalCount: 0, businessCount: 0, utilityCount: 0, biDirectionalCount: 0 }),
    getInteractionById: vi.fn().mockReturnValue(null),
    getRelationshipCoverage: vi.fn().mockReturnValue({
      totalRelationships: 0,
      crossModuleRelationships: 0,
      relationshipsContributingToInteractions: 0,
      sameModuleCount: 0,
      orphanedCount: 0,
      coveragePercent: 0,
    }),
    getAllFlows: vi.fn().mockReturnValue([]),
    getFlowStats: vi.fn().mockReturnValue({ flowCount: 0, withEntryPointCount: 0, avgStepsPerFlow: 0 }),
    getFlowCoverage: vi.fn().mockReturnValue({ totalInteractions: 0, coveredByFlows: 0, percentage: 0 }),
    getFlowWithSteps: vi.fn().mockReturnValue(null),
    expandFlow: vi.fn().mockReturnValue([]),
    getModuleCallGraph: vi.fn().mockReturnValue([]),
  } as unknown as IndexDatabase;
}

// Helper to make HTTP request to server
function makeRequest(server: http.Server, path: string, method = 'GET'): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
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
        res.on('data', (chunk) => { body += chunk; });
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
        expect(mockDb.getAllFiles).toHaveBeenCalled();
      });

      it('GET /api/files/:id returns file with definitions and imports', async () => {
        (mockDb.getFileById as any).mockReturnValue({ id: 1, path: 'test.ts' });
        (mockDb.getFileDefinitions as any).mockReturnValue([{ id: 1, name: 'foo' }]);
        (mockDb.getFileImports as any).mockReturnValue([{ id: 1, module: 'bar' }]);

        const response = await makeRequest(server, '/api/files/1');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.id).toBe(1);
        expect(body.definitions).toEqual([{ id: 1, name: 'foo' }]);
        expect(body.imports).toEqual([{ id: 1, module: 'bar' }]);
      });

      it('GET /api/files/:id returns 404 for non-existent file', async () => {
        (mockDb.getFileById as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/files/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'File not found' });
      });

      it('GET /api/definitions returns all definitions', async () => {
        const mockDefs = [{ id: 1, name: 'test', kind: 'function' }];
        (mockDb.getAllDefinitions as any).mockReturnValue(mockDefs);

        const response = await makeRequest(server, '/api/definitions');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockDefs);
      });

      it('GET /api/definitions/:id returns definition', async () => {
        const mockDef = { id: 1, name: 'test', kind: 'function' };
        (mockDb.getDefinitionById as any).mockReturnValue(mockDef);

        const response = await makeRequest(server, '/api/definitions/1');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockDef);
      });

      it('GET /api/definitions/:id returns 404 for non-existent definition', async () => {
        (mockDb.getDefinitionById as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/definitions/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'Definition not found' });
      });

      it('GET /api/definitions/:id/callsites returns callsites', async () => {
        const mockCallsites = [{ id: 1, filePath: 'test.ts', line: 10 }];
        (mockDb.getCallsites as any).mockReturnValue(mockCallsites);

        const response = await makeRequest(server, '/api/definitions/1/callsites');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockCallsites);
      });

      it('GET /api/graph/imports returns import graph', async () => {
        const mockGraph = { nodes: [], edges: [] };
        (mockDb.getImportGraph as any).mockReturnValue(mockGraph);

        const response = await makeRequest(server, '/api/graph/imports');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockGraph);
      });

      it('GET /api/graph/classes returns class hierarchy', async () => {
        const mockHierarchy = { nodes: [], edges: [] };
        (mockDb.getClassHierarchy as any).mockReturnValue(mockHierarchy);

        const response = await makeRequest(server, '/api/graph/classes');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockHierarchy);
      });

      it('GET /api/modules returns modules data', async () => {
        (mockDb.getAllModulesWithMembers as any).mockReturnValue([]);
        (mockDb.getModuleStats as any).mockReturnValue({ moduleCount: 0, assigned: 0, unassigned: 0 });

        const response = await makeRequest(server, '/api/modules');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('modules');
        expect(body).toHaveProperty('stats');
      });

      it('GET /api/modules/stats returns module stats', async () => {
        (mockDb.getModuleStats as any).mockReturnValue({ moduleCount: 5, assigned: 20, unassigned: 10 });

        const response = await makeRequest(server, '/api/modules/stats');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ moduleCount: 5, assigned: 20, unassigned: 10 });
      });

      it('GET /api/modules/:id returns module with members', async () => {
        const mockModule = { id: 1, name: 'core', members: [] };
        (mockDb.getModuleWithMembers as any).mockReturnValue(mockModule);

        const response = await makeRequest(server, '/api/modules/1');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockModule);
      });

      it('GET /api/modules/:id returns 404 for non-existent module', async () => {
        (mockDb.getModuleWithMembers as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/modules/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'Module not found' });
      });

      it('GET /api/flows returns flows data', async () => {
        (mockDb.getAllFlows as any).mockReturnValue([]);
        (mockDb.getFlowStats as any).mockReturnValue({ flowCount: 0, withEntryPointCount: 0, avgStepsPerFlow: 0 });
        (mockDb.getFlowCoverage as any).mockReturnValue({ totalInteractions: 0, coveredByFlows: 0, percentage: 0 });

        const response = await makeRequest(server, '/api/flows');

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('flows');
        expect(body).toHaveProperty('stats');
        expect(body).toHaveProperty('coverage');
      });

      it('GET /api/flows/stats returns flow stats', async () => {
        (mockDb.getFlowStats as any).mockReturnValue({ flowCount: 3, withEntryPointCount: 2, avgStepsPerFlow: 4.5 });

        const response = await makeRequest(server, '/api/flows/stats');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ flowCount: 3, withEntryPointCount: 2, avgStepsPerFlow: 4.5 });
      });

      it('GET /api/flows/coverage returns flow coverage', async () => {
        const mockCoverage = { totalInteractions: 10, coveredByFlows: 5, percentage: 50 };
        (mockDb.getFlowCoverage as any).mockReturnValue(mockCoverage);

        const response = await makeRequest(server, '/api/flows/coverage');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockCoverage);
      });

      it('GET /api/flows/:id returns flow with steps', async () => {
        const mockFlow = { id: 1, name: 'User Login', steps: [] };
        (mockDb.getFlowWithSteps as any).mockReturnValue(mockFlow);

        const response = await makeRequest(server, '/api/flows/1');

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(mockFlow);
      });

      it('GET /api/flows/:id returns 404 for non-existent flow', async () => {
        (mockDb.getFlowWithSteps as any).mockReturnValue(null);

        const response = await makeRequest(server, '/api/flows/999');

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: 'Flow not found' });
      });

      it('GET /api/interactions returns interactions data', async () => {
        (mockDb.getAllInteractions as any).mockReturnValue([]);
        (mockDb.getInteractionStats as any).mockReturnValue({ totalCount: 0, businessCount: 0, utilityCount: 0, biDirectionalCount: 0 });
        (mockDb.getRelationshipCoverage as any).mockReturnValue({
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
