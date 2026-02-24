import { describe, expect, it } from 'vitest';
import {
  STRIP_PREFIXES,
  normalizeContractKeys,
  resolveContractKeys,
  stripApiPrefix,
} from '../../../src/commands/contracts/_shared/key-resolver.js';
import type { MountResolverResult } from '../../../src/commands/contracts/_shared/mount-resolver.js';

describe('key-resolver', () => {
  const emptyMounts: MountResolverResult = {
    routeMounts: new Map(),
    clientBaseUrl: null,
  };

  describe('resolveContractKeys', () => {
    it('passes through non-HTTP contracts unchanged', () => {
      const contracts = [
        { protocol: 'websocket', role: 'server', key: 'connection', normalizedKey: 'connection' },
        { protocol: 'grpc', role: 'server', key: 'GetUser', normalizedKey: 'GetUser' },
      ];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/auth.ts', '/api/auth']]),
        clientBaseUrl: '/api',
      };

      const result = resolveContractKeys(contracts, '/src/routes/auth.ts', mounts);

      expect(result).toEqual(contracts);
    });

    it('passes through HTTP contracts when no mounts configured', () => {
      const contracts = [{ protocol: 'http', role: 'server', key: 'GET /vehicles', normalizedKey: 'GET /vehicles' }];

      const result = resolveContractKeys(contracts, '/src/routes/vehicles.ts', emptyMounts);

      expect(result).toEqual(contracts);
    });

    it('prepends mount prefix for server role', () => {
      const contracts = [{ protocol: 'http', role: 'server', key: 'GET /vehicles', normalizedKey: 'GET /vehicles' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/vehicles.ts', '/api/v1']]),
        clientBaseUrl: null,
      };

      const result = resolveContractKeys(contracts, '/src/routes/vehicles.ts', mounts);

      expect(result).toHaveLength(1);
      expect(result[0].normalizedKey).toBe('GET /api/v1/vehicles');
    });

    it('does not double-prepend if prefix already present', () => {
      const contracts = [
        { protocol: 'http', role: 'server', key: 'GET /api/v1/vehicles', normalizedKey: 'GET /api/v1/vehicles' },
      ];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/vehicles.ts', '/api/v1']]),
        clientBaseUrl: null,
      };

      const result = resolveContractKeys(contracts, '/src/routes/vehicles.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /api/v1/vehicles');
    });

    it('prepends baseURL for client role', () => {
      const contracts = [{ protocol: 'http', role: 'client', key: 'GET /vehicles', normalizedKey: 'GET /vehicles' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map(),
        clientBaseUrl: '/api',
      };

      const result = resolveContractKeys(contracts, '/src/hooks/useVehicles.ts', mounts);

      expect(result).toHaveLength(1);
      expect(result[0].normalizedKey).toBe('GET /api/vehicles');
    });

    it('does not double-prepend baseURL if already present', () => {
      const contracts = [
        { protocol: 'http', role: 'client', key: 'GET /api/vehicles', normalizedKey: 'GET /api/vehicles' },
      ];
      const mounts: MountResolverResult = {
        routeMounts: new Map(),
        clientBaseUrl: '/api',
      };

      const result = resolveContractKeys(contracts, '/src/hooks/useVehicles.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /api/vehicles');
    });

    it('handles producer role as server', () => {
      const contracts = [{ protocol: 'http', role: 'producer', key: 'POST /events', normalizedKey: 'POST /events' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/events.ts', '/api']]),
        clientBaseUrl: null,
      };

      const result = resolveContractKeys(contracts, '/src/routes/events.ts', mounts);

      expect(result[0].normalizedKey).toBe('POST /api/events');
    });

    it('handles consumer role as client', () => {
      const contracts = [{ protocol: 'http', role: 'consumer', key: 'GET /data', normalizedKey: 'GET /data' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map(),
        clientBaseUrl: '/v2',
      };

      const result = resolveContractKeys(contracts, '/src/client.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /v2/data');
    });

    it('uses normalizedKey when present, falls back to key', () => {
      const contracts = [{ protocol: 'http', role: 'server', key: 'GET /raw/{id}', normalizedKey: 'GET /{param}' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/items.ts', '/api']]),
        clientBaseUrl: null,
      };

      const result = resolveContractKeys(contracts, '/src/routes/items.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /api/{param}');
    });

    it('falls back to key when normalizedKey is undefined', () => {
      const contracts = [{ protocol: 'http', role: 'server', key: 'GET /items' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/items.ts', '/api']]),
        clientBaseUrl: null,
      };

      const result = resolveContractKeys(contracts, '/src/routes/items.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /api/items');
    });

    it('handles malformed HTTP keys gracefully (no method)', () => {
      const contracts = [{ protocol: 'http', role: 'server', key: '/vehicles', normalizedKey: '/vehicles' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/vehicles.ts', '/api']]),
        clientBaseUrl: null,
      };

      // No method prefix → regex won't match → pass through unchanged
      const result = resolveContractKeys(contracts, '/src/routes/vehicles.ts', mounts);

      expect(result[0].normalizedKey).toBe('/vehicles');
    });

    it('preserves other contract fields when resolving', () => {
      const contracts = [
        { protocol: 'http', role: 'server', key: 'GET /users', normalizedKey: 'GET /users', details: 'List users' },
      ];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/users.ts', '/api']]),
        clientBaseUrl: null,
      };

      const result = resolveContractKeys(contracts, '/src/routes/users.ts', mounts);

      expect(result[0].protocol).toBe('http');
      expect(result[0].role).toBe('server');
      expect(result[0].key).toBe('GET /users');
      expect(result[0].details).toBe('List users');
      expect(result[0].normalizedKey).toBe('GET /api/users');
    });

    it('handles trailing slash in prefix', () => {
      const contracts = [{ protocol: 'http', role: 'server', key: 'GET /items', normalizedKey: 'GET /items' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/items.ts', '/api/']]),
        clientBaseUrl: null,
      };

      const result = resolveContractKeys(contracts, '/src/routes/items.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /api/items');
    });

    it('handles mixed contract types in a single batch', () => {
      const contracts = [
        { protocol: 'http', role: 'server', key: 'GET /items', normalizedKey: 'GET /items' },
        { protocol: 'websocket', role: 'server', key: 'item:update' },
        { protocol: 'http', role: 'server', key: 'POST /items', normalizedKey: 'POST /items' },
      ];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/items.ts', '/api']]),
        clientBaseUrl: null,
      };

      const result = resolveContractKeys(contracts, '/src/routes/items.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /api/items');
      expect(result[1]).toEqual(contracts[1]); // websocket unchanged
      expect(result[2].normalizedKey).toBe('POST /api/items');
    });

    it('does not apply server mount to client contracts', () => {
      const contracts = [{ protocol: 'http', role: 'client', key: 'GET /vehicles', normalizedKey: 'GET /vehicles' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/hooks/useVehicles.ts', '/api']]),
        clientBaseUrl: null,
      };

      // Client role should not use routeMounts, and no clientBaseUrl → unchanged
      const result = resolveContractKeys(contracts, '/src/hooks/useVehicles.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /vehicles');
    });

    it('pathStartsWith prevents false prefix match (/api vs /apifoo)', () => {
      const contracts = [{ protocol: 'http', role: 'server', key: 'GET /apifoo', normalizedKey: 'GET /apifoo' }];
      const mounts: MountResolverResult = {
        routeMounts: new Map([['/src/routes/foo.ts', '/api']]),
        clientBaseUrl: null,
      };

      // /apifoo does NOT start with /api (segment boundary check)
      const result = resolveContractKeys(contracts, '/src/routes/foo.ts', mounts);

      expect(result[0].normalizedKey).toBe('GET /api/apifoo');
    });
  });

  describe('STRIP_PREFIXES', () => {
    it('contains expected API version prefixes in priority order', () => {
      expect(STRIP_PREFIXES).toEqual(['/api/v1', '/api/v2', '/api/v3', '/api']);
    });
  });

  describe('stripApiPrefix', () => {
    it('strips /api/v1 prefix', () => {
      expect(stripApiPrefix('/api/v1/vehicles')).toBe('/vehicles');
    });

    it('strips /api/v2 prefix', () => {
      expect(stripApiPrefix('/api/v2/users')).toBe('/users');
    });

    it('strips /api/v3 prefix', () => {
      expect(stripApiPrefix('/api/v3/items')).toBe('/items');
    });

    it('strips /api prefix', () => {
      expect(stripApiPrefix('/api/vehicles')).toBe('/vehicles');
    });

    it('returns / when path equals prefix exactly', () => {
      expect(stripApiPrefix('/api/v1')).toBe('/');
      expect(stripApiPrefix('/api')).toBe('/');
    });

    it('does not strip /api from /apifoo (segment boundary)', () => {
      expect(stripApiPrefix('/apifoo')).toBe('/apifoo');
    });

    it('returns path unchanged when no prefix matches', () => {
      expect(stripApiPrefix('/vehicles')).toBe('/vehicles');
      expect(stripApiPrefix('/users/123')).toBe('/users/123');
    });

    it('prefers longest matching prefix (/api/v1 over /api)', () => {
      // /api/v1/foo should strip /api/v1 (first match), not /api
      expect(stripApiPrefix('/api/v1/foo')).toBe('/foo');
    });

    it('handles paths with parameters', () => {
      expect(stripApiPrefix('/api/v1/vehicles/{id}')).toBe('/vehicles/{id}');
    });
  });

  describe('normalizeContractKeys', () => {
    it('strips API prefix from HTTP contract normalizedKey', () => {
      const contracts = [
        { protocol: 'http', role: 'server', key: 'GET /api/v1/vehicles', normalizedKey: 'GET /api/v1/vehicles' },
      ];

      const result = normalizeContractKeys(contracts);

      expect(result).toHaveLength(1);
      expect(result[0].normalizedKey).toBe('GET /vehicles');
    });

    it('preserves original key field', () => {
      const contracts = [
        { protocol: 'http', role: 'server', key: 'GET /api/v1/vehicles', normalizedKey: 'GET /api/v1/vehicles' },
      ];

      const result = normalizeContractKeys(contracts);

      expect(result[0].key).toBe('GET /api/v1/vehicles');
    });

    it('passes through non-HTTP contracts unchanged', () => {
      const contracts = [{ protocol: 'websocket', role: 'server', key: 'connection', normalizedKey: 'connection' }];

      const result = normalizeContractKeys(contracts);

      expect(result).toEqual(contracts);
    });

    it('passes through HTTP contracts without prefix unchanged', () => {
      const contracts = [{ protocol: 'http', role: 'client', key: 'GET /vehicles', normalizedKey: 'GET /vehicles' }];

      const result = normalizeContractKeys(contracts);

      expect(result[0].normalizedKey).toBe('GET /vehicles');
    });

    it('falls back to key when normalizedKey is undefined', () => {
      const contracts = [{ protocol: 'http', role: 'server', key: 'GET /api/v1/users' }];

      const result = normalizeContractKeys(contracts);

      expect(result[0].normalizedKey).toBe('GET /users');
    });

    it('handles malformed HTTP keys (no method) gracefully', () => {
      const contracts = [
        { protocol: 'http', role: 'server', key: '/api/v1/vehicles', normalizedKey: '/api/v1/vehicles' },
      ];

      const result = normalizeContractKeys(contracts);

      // No HTTP method → regex won't match → pass through unchanged
      expect(result[0].normalizedKey).toBe('/api/v1/vehicles');
    });

    it('normalizes multiple contracts in a batch', () => {
      const contracts = [
        { protocol: 'http', role: 'server', key: 'GET /api/v1/vehicles', normalizedKey: 'GET /api/v1/vehicles' },
        { protocol: 'http', role: 'client', key: 'POST /api/users', normalizedKey: 'POST /api/users' },
        { protocol: 'websocket', role: 'server', key: 'item:update' },
      ];

      const result = normalizeContractKeys(contracts);

      expect(result[0].normalizedKey).toBe('GET /vehicles');
      expect(result[1].normalizedKey).toBe('POST /users');
      expect(result[2]).toEqual(contracts[2]);
    });

    it('uppercases HTTP method in result', () => {
      const contracts = [
        { protocol: 'http', role: 'server', key: 'get /api/v1/items', normalizedKey: 'get /api/v1/items' },
      ];

      const result = normalizeContractKeys(contracts);

      expect(result[0].normalizedKey).toBe('GET /items');
    });
  });
});
