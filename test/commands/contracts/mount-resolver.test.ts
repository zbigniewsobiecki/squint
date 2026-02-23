import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveContractKeys } from '../../../src/commands/contracts/_shared/key-resolver.js';
import { type MountResolverResult, resolveMounts } from '../../../src/commands/contracts/_shared/mount-resolver.js';
import { IndexDatabase } from '../../../src/db/database-facade.js';

// Mock the source-reader module used by mount-resolver
vi.mock('../../../src/commands/_shared/source-reader.js', () => ({
  readSourceLines: vi.fn(),
  readSourceAsString: vi.fn(),
  readAllLines: vi.fn(),
}));

import { readSourceLines } from '../../../src/commands/_shared/source-reader.js';

const mockedReadSourceLines = vi.mocked(readSourceLines);

describe('mount-resolver', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();

    // Set source directory so resolveFilePath works
    db.setMetadata('source_directory', '/project');
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  /**
   * Helper to set up a simple Express mount scenario:
   * app.ts imports authRoutes from auth.routes.ts and mounts it
   */
  function setupSimpleMount(mountLine: string): { appFileId: number; routeFileId: number; routeDefId: number } {
    const appFileId = db.files.insert({
      path: 'src/app.ts',
      language: 'typescript',
      contentHash: 'aaa',
      sizeBytes: 500,
      modifiedAt: '2024-01-01',
    });

    const routeFileId = db.files.insert({
      path: 'src/routes/auth.routes.ts',
      language: 'typescript',
      contentHash: 'bbb',
      sizeBytes: 300,
      modifiedAt: '2024-01-01',
    });

    // Definition in route file (the router)
    const routeDefId = db.files.insertDefinition(routeFileId, {
      name: 'authRouter',
      kind: 'variable',
      isExported: true,
      isDefault: true,
      position: { row: 0, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    // Import in app.ts: import authRoutes from './routes/auth.routes'
    const importId = db.files.insertReference(appFileId, routeFileId, {
      type: 'import',
      source: './routes/auth.routes',
      isExternal: false,
      isTypeOnly: false,
      position: { row: 0, column: 0 },
    });

    // Symbol linking import to definition
    const symbolId = db.files.insertSymbol(importId, routeDefId, {
      name: 'authRouter',
      localName: 'authRoutes',
      kind: 'default',
    });

    // Usage: app.use('/api/auth', authRoutes) at line 10 (row 9 for 0-based)
    // This is module-scope (no definition covers this line in app.ts)
    db.files.insertUsage(symbolId, {
      position: { row: 9, column: 0 },
      context: 'call',
      callsite: {
        argumentCount: 2,
        isMethodCall: true,
        isConstructorCall: false,
        receiverName: 'app',
      },
    });

    // Mock readSourceLines to return the mount line
    mockedReadSourceLines.mockImplementation(async (_filePath: string, start: number) => {
      if (start === 10) {
        return [mountLine];
      }
      return ['// other code'];
    });

    return { appFileId, routeFileId, routeDefId };
  }

  describe('resolveMounts', () => {
    it('detects a simple Express mount prefix', async () => {
      setupSimpleMount("app.use('/api/auth', authRoutes);");

      const result = await resolveMounts(db);

      expect(result.routeMounts.size).toBe(1);
      expect(result.routeMounts.get('src/routes/auth.routes.ts')).toBe('/api/auth');
    });

    it('handles double-quoted prefix', async () => {
      setupSimpleMount('app.use("/api/auth", authRoutes);');

      const result = await resolveMounts(db);

      expect(result.routeMounts.get('src/routes/auth.routes.ts')).toBe('/api/auth');
    });

    it('ignores app.use() without string prefix', async () => {
      setupSimpleMount('app.use(authRoutes);');

      const result = await resolveMounts(db);

      expect(result.routeMounts.size).toBe(0);
    });

    it('composes nested mount prefixes via BFS', async () => {
      // app.ts → mounts apiRouter at /api
      // apiRouter.ts → mounts authRouter at /auth
      // Result: auth.routes.ts → /api/auth
      const appFileId = db.files.insert({
        path: 'src/app.ts',
        language: 'typescript',
        contentHash: 'aaa',
        sizeBytes: 500,
        modifiedAt: '2024-01-01',
      });

      const apiRouterFileId = db.files.insert({
        path: 'src/api-router.ts',
        language: 'typescript',
        contentHash: 'bbb',
        sizeBytes: 300,
        modifiedAt: '2024-01-01',
      });

      const authRoutesFileId = db.files.insert({
        path: 'src/routes/auth.routes.ts',
        language: 'typescript',
        contentHash: 'ccc',
        sizeBytes: 300,
        modifiedAt: '2024-01-01',
      });

      // apiRouter definition in api-router.ts (covers lines 1-30)
      const apiRouterDefId = db.files.insertDefinition(apiRouterFileId, {
        name: 'apiRouter',
        kind: 'variable',
        isExported: true,
        isDefault: true,
        position: { row: 0, column: 0 },
        endPosition: { row: 29, column: 1 },
      });

      // authRouter definition in auth.routes.ts
      const authRouterDefId = db.files.insertDefinition(authRoutesFileId, {
        name: 'authRouter',
        kind: 'variable',
        isExported: true,
        isDefault: true,
        position: { row: 0, column: 0 },
        endPosition: { row: 20, column: 1 },
      });

      // app.ts imports apiRouter
      const import1Id = db.files.insertReference(appFileId, apiRouterFileId, {
        type: 'import',
        source: './api-router',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
      });
      const sym1Id = db.files.insertSymbol(import1Id, apiRouterDefId, {
        name: 'apiRouter',
        localName: 'apiRouter',
        kind: 'default',
      });
      // app.use('/api', apiRouter) at line 10
      db.files.insertUsage(sym1Id, {
        position: { row: 9, column: 0 },
        context: 'call',
        callsite: {
          argumentCount: 2,
          isMethodCall: true,
          isConstructorCall: false,
          receiverName: 'app',
        },
      });

      // apiRouter.ts imports authRouter
      const import2Id = db.files.insertReference(apiRouterFileId, authRoutesFileId, {
        type: 'import',
        source: './routes/auth.routes',
        isExternal: false,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
      });
      const sym2Id = db.files.insertSymbol(import2Id, authRouterDefId, {
        name: 'authRouter',
        localName: 'authRoutes',
        kind: 'default',
      });
      // router.use('/auth', authRoutes) at line 35 (outside apiRouter def range 1-30)
      db.files.insertUsage(sym2Id, {
        position: { row: 34, column: 0 },
        context: 'call',
        callsite: {
          argumentCount: 2,
          isMethodCall: true,
          isConstructorCall: false,
          receiverName: 'router',
        },
      });

      mockedReadSourceLines.mockImplementation(async (_filePath: string, start: number) => {
        if (_filePath.includes('app.ts') && start === 10) {
          return ["app.use('/api', apiRouter);"];
        }
        if (_filePath.includes('api-router.ts') && start === 35) {
          return ["router.use('/auth', authRoutes);"];
        }
        return ['// other code'];
      });

      const result = await resolveMounts(db);

      expect(result.routeMounts.get('src/api-router.ts')).toBe('/api');
      expect(result.routeMounts.get('src/routes/auth.routes.ts')).toBe('/api/auth');
    });

    it('detects client baseURL from axios import', async () => {
      const clientFileId = db.files.insert({
        path: 'src/services/api.ts',
        language: 'typescript',
        contentHash: 'ddd',
        sizeBytes: 200,
        modifiedAt: '2024-01-01',
      });

      // Import axios (external)
      db.files.insertReference(clientFileId, null, {
        type: 'import',
        source: 'axios',
        isExternal: true,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
      });

      mockedReadSourceLines.mockResolvedValue([
        "import axios from 'axios';",
        "const api = axios.create({ baseURL: '/api' });",
        'export default api;',
      ]);

      const result = await resolveMounts(db);

      expect(result.clientBaseUrl).toBe('/api');
    });

    it('extracts path component from full URL baseURL', async () => {
      const clientFileId = db.files.insert({
        path: 'src/services/api.ts',
        language: 'typescript',
        contentHash: 'eee',
        sizeBytes: 200,
        modifiedAt: '2024-01-01',
      });

      db.files.insertReference(clientFileId, null, {
        type: 'import',
        source: 'axios',
        isExternal: true,
        isTypeOnly: false,
        position: { row: 0, column: 0 },
      });

      mockedReadSourceLines.mockResolvedValue([
        "import axios from 'axios';",
        "const api = axios.create({ baseURL: 'http://localhost:3000/api' });",
        'export default api;',
      ]);

      const result = await resolveMounts(db);

      expect(result.clientBaseUrl).toBe('/api');
    });
  });
});

describe('resolveContractKeys', () => {
  const baseMountResult: MountResolverResult = {
    routeMounts: new Map([
      ['src/routes/auth.routes.ts', '/api/auth'],
      ['src/routes/vehicles.routes.ts', '/api/vehicles'],
    ]),
    clientBaseUrl: '/api',
  };

  it('prepends server mount prefix to HTTP contract', () => {
    const contracts = [{ protocol: 'http', role: 'server', key: 'POST /login', normalizedKey: 'POST /login' }];

    const result = resolveContractKeys(contracts, 'src/routes/auth.routes.ts', baseMountResult);

    expect(result[0].normalizedKey).toBe('POST /api/auth/login');
  });

  it('prepends client baseURL to HTTP contract', () => {
    const contracts = [
      { protocol: 'http', role: 'client', key: 'POST /auth/login', normalizedKey: 'POST /auth/login' },
    ];

    const result = resolveContractKeys(contracts, 'src/services/auth.service.ts', baseMountResult);

    expect(result[0].normalizedKey).toBe('POST /api/auth/login');
  });

  it('does not double-prepend if path already starts with prefix', () => {
    const contracts = [
      { protocol: 'http', role: 'server', key: 'POST /api/auth/login', normalizedKey: 'POST /api/auth/login' },
    ];

    const result = resolveContractKeys(contracts, 'src/routes/auth.routes.ts', baseMountResult);

    expect(result[0].normalizedKey).toBe('POST /api/auth/login');
  });

  it('passes through non-HTTP contracts unchanged', () => {
    const contracts = [{ protocol: 'ws', role: 'server', key: 'vehicle:updated', normalizedKey: 'vehicle:updated' }];

    const result = resolveContractKeys(contracts, 'src/routes/auth.routes.ts', baseMountResult);

    expect(result[0].normalizedKey).toBe('vehicle:updated');
  });

  it('does not modify contracts for files without mount mapping', () => {
    const contracts = [{ protocol: 'http', role: 'server', key: 'GET /health', normalizedKey: 'GET /health' }];

    const result = resolveContractKeys(contracts, 'src/app.ts', baseMountResult);

    expect(result[0].normalizedKey).toBe('GET /health');
  });

  it('handles parameterized routes correctly', () => {
    const contracts = [{ protocol: 'http', role: 'server', key: 'GET /vehicles/:id', normalizedKey: 'GET /{param}' }];

    const result = resolveContractKeys(contracts, 'src/routes/vehicles.routes.ts', baseMountResult);

    expect(result[0].normalizedKey).toBe('GET /api/vehicles/{param}');
  });

  it('does not prepend client baseURL if path already starts with it', () => {
    const contracts = [
      { protocol: 'http', role: 'client', key: 'GET /api/vehicles', normalizedKey: 'GET /api/vehicles' },
    ];

    const result = resolveContractKeys(contracts, 'src/services/vehicle.service.ts', baseMountResult);

    expect(result[0].normalizedKey).toBe('GET /api/vehicles');
  });

  it('handles empty mount result gracefully', () => {
    const emptyResult: MountResolverResult = {
      routeMounts: new Map(),
      clientBaseUrl: null,
    };
    const contracts = [{ protocol: 'http', role: 'server', key: 'POST /login', normalizedKey: 'POST /login' }];

    const result = resolveContractKeys(contracts, 'src/routes/auth.routes.ts', emptyResult);

    expect(result[0].normalizedKey).toBe('POST /login');
  });
});
