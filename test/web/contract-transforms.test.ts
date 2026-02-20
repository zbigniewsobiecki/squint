import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDatabase } from '../../src/db/database.js';
import { getContractsData } from '../../src/web/transforms/contract-transforms.js';

describe('contract-transforms', () => {
  let db: IndexDatabase;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  function insertFile(filePath: string) {
    return db.files.insert({
      path: filePath,
      language: 'typescript',
      contentHash: `hash-${filePath}`,
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
  }

  function insertDefinition(fileId: number, name: string, kind = 'function') {
    return db.files.insertDefinition(fileId, {
      name,
      kind,
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 10, column: 1 },
    });
  }

  describe('getContractsData', () => {
    it('returns empty data when no contracts exist', () => {
      const result = getContractsData(db);
      expect(result.contracts).toEqual([]);
      expect(result.stats.total).toBe(0);
      expect(result.stats.matched).toBe(0);
      expect(result.stats.unmatched).toBe(0);
    });

    it('returns contracts with participant details', () => {
      const fileId = insertFile('/src/controller.ts');
      const defId = insertDefinition(fileId, 'VehiclesController', 'class');
      const rootId = db.modules.ensureRoot();
      const moduleId = db.modules.insert(rootId, 'backend', 'Backend');
      db.modules.assignSymbol(defId, moduleId);

      const contractId = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(contractId, defId, moduleId, 'server');

      const result = getContractsData(db);
      expect(result.contracts).toHaveLength(1);
      expect(result.contracts[0].protocol).toBe('http');
      expect(result.contracts[0].normalizedKey).toBe('GET /vehicles');
      expect(result.contracts[0].participants).toHaveLength(1);
      expect(result.contracts[0].participants[0].definitionName).toBe('VehiclesController');
      expect(result.contracts[0].participants[0].modulePath).toContain('backend');
    });

    it('correctly identifies matched vs unmatched contracts', () => {
      const fileId1 = insertFile('/src/controller.ts');
      const fileId2 = insertFile('/src/service.ts');
      const defId1 = insertDefinition(fileId1, 'VehiclesController');
      const defId2 = insertDefinition(fileId2, 'vehiclesService');
      const rootId = db.modules.ensureRoot();
      const mod1 = db.modules.insert(rootId, 'backend', 'Backend');
      const mod2 = db.modules.insert(rootId, 'frontend', 'Frontend');
      db.modules.assignSymbol(defId1, mod1);
      db.modules.assignSymbol(defId2, mod2);

      // Matched contract: server + client
      const c1 = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c1, defId1, mod1, 'server');
      db.contracts.addParticipant(c1, defId2, mod2, 'client');

      // Unmatched contract: server only
      const c2 = db.contracts.upsertContract('http', 'POST /register', 'POST /register');
      db.contracts.addParticipant(c2, defId1, mod1, 'server');

      const result = getContractsData(db);
      expect(result.stats.total).toBe(2);
      expect(result.stats.matched).toBe(1);
      expect(result.stats.unmatched).toBe(1);
      expect(result.stats.byProtocol.http).toBe(2);

      const matched = result.contracts.find((c) => c.matched);
      expect(matched!.normalizedKey).toBe('GET /vehicles');

      const unmatched = result.contracts.find((c) => !c.matched);
      expect(unmatched!.normalizedKey).toBe('POST /register');
    });

    it('handles participants with null moduleId', () => {
      const fileId = insertFile('/src/controller.ts');
      const defId = insertDefinition(fileId, 'VehiclesController');

      const contractId = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(contractId, defId, null, 'server');

      const result = getContractsData(db);
      expect(result.contracts[0].participants[0].moduleId).toBeNull();
      expect(result.contracts[0].participants[0].modulePath).toBeNull();
    });
  });
});
