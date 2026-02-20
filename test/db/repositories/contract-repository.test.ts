import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractRepository } from '../../../src/db/repositories/contract-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { ModuleRepository } from '../../../src/db/repositories/module-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('ContractRepository', () => {
  let db: Database.Database;
  let repo: ContractRepository;
  let moduleRepo: ModuleRepository;
  let fileRepo: FileRepository;
  let moduleId1: number;
  let moduleId2: number;
  let defId1: number;
  let defId2: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new ContractRepository(db);
    moduleRepo = new ModuleRepository(db);
    fileRepo = new FileRepository(db);

    // Set up test modules
    const rootId = moduleRepo.ensureRoot();
    moduleId1 = moduleRepo.insert(rootId, 'backend', 'Backend');
    moduleId2 = moduleRepo.insert(rootId, 'frontend', 'Frontend');

    // Set up test definitions
    const fileId1 = fileRepo.insert({
      path: '/src/controllers/vehicles.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 200,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    const fileId2 = fileRepo.insert({
      path: '/src/services/vehicles.ts',
      language: 'typescript',
      contentHash: 'def456',
      sizeBytes: 150,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    defId1 = fileRepo.insertDefinition(fileId1, {
      name: 'VehiclesController',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 50, column: 1 },
    });

    defId2 = fileRepo.insertDefinition(fileId2, {
      name: 'vehiclesService',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 30, column: 1 },
    });

    moduleRepo.assignSymbol(defId1, moduleId1);
    moduleRepo.assignSymbol(defId2, moduleId2);
  });

  afterEach(() => {
    db.close();
  });

  describe('upsertContract', () => {
    it('inserts a new contract', () => {
      const id = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      expect(id).toBeGreaterThan(0);
      expect(repo.getCount()).toBe(1);
    });

    it('returns existing ID on duplicate (protocol, normalizedKey)', () => {
      const id1 = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      const id2 = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      expect(id1).toBe(id2);
      expect(repo.getCount()).toBe(1);
    });

    it('updates description on duplicate', () => {
      repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles', 'old desc');
      repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles', 'new desc');

      const contract = repo.findByProtocolAndKey('http', 'GET /vehicles');
      expect(contract!.description).toBe('new desc');
    });
  });

  describe('addParticipant', () => {
    it('adds a participant to a contract', () => {
      const contractId = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      const pId = repo.addParticipant(contractId, defId1, moduleId1, 'server');
      expect(pId).toBeGreaterThan(0);
    });

    it('skips duplicate (contract_id, definition_id) pair', () => {
      const contractId = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      const pId1 = repo.addParticipant(contractId, defId1, moduleId1, 'server');
      const pId2 = repo.addParticipant(contractId, defId1, moduleId1, 'server');
      expect(pId1).toBe(pId2);
    });
  });

  describe('getAll', () => {
    it('returns all contracts ordered by protocol and normalizedKey', () => {
      repo.upsertContract('ws', 'events', 'events');
      repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.upsertContract('http', 'GET /customers', 'GET /customers');

      const all = repo.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].protocol).toBe('http');
      expect(all[0].normalizedKey).toBe('GET /customers');
      expect(all[1].normalizedKey).toBe('GET /vehicles');
      expect(all[2].protocol).toBe('ws');
    });
  });

  describe('getWithParticipants', () => {
    it('returns contract with participants', () => {
      const contractId = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.addParticipant(contractId, defId1, moduleId1, 'server');
      repo.addParticipant(contractId, defId2, moduleId2, 'client');

      const result = repo.getWithParticipants(contractId);
      expect(result).not.toBeNull();
      expect(result!.participants).toHaveLength(2);
      expect(result!.participants[0].role).toBeDefined();
    });

    it('returns null for non-existent ID', () => {
      expect(repo.getWithParticipants(999)).toBeNull();
    });
  });

  describe('getAllWithParticipants', () => {
    it('returns all contracts with their participants', () => {
      const c1 = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      const c2 = repo.upsertContract('http', 'POST /vehicles', 'POST /vehicles');
      repo.addParticipant(c1, defId1, moduleId1, 'server');
      repo.addParticipant(c1, defId2, moduleId2, 'client');
      repo.addParticipant(c2, defId1, moduleId1, 'server');

      const all = repo.getAllWithParticipants();
      expect(all).toHaveLength(2);
      expect(all[0].participants).toHaveLength(2);
      expect(all[1].participants).toHaveLength(1);
    });
  });

  describe('getByProtocol', () => {
    it('returns contracts filtered by protocol', () => {
      repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.upsertContract('ws', 'events', 'events');

      const http = repo.getByProtocol('http');
      expect(http).toHaveLength(1);
      expect(http[0].protocol).toBe('http');
    });
  });

  describe('getMatchedContracts', () => {
    it('returns contracts with complementary roles', () => {
      const c1 = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.addParticipant(c1, defId1, moduleId1, 'server');
      repo.addParticipant(c1, defId2, moduleId2, 'client');

      const c2 = repo.upsertContract('http', 'POST /register', 'POST /register');
      repo.addParticipant(c2, defId1, moduleId1, 'server');

      const matched = repo.getMatchedContracts();
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe(c1);
    });
  });

  describe('getUnmatchedContracts', () => {
    it('returns one-sided contracts', () => {
      const c1 = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.addParticipant(c1, defId1, moduleId1, 'server');
      repo.addParticipant(c1, defId2, moduleId2, 'client');

      const c2 = repo.upsertContract('http', 'POST /register', 'POST /register');
      repo.addParticipant(c2, defId1, moduleId1, 'server');

      const unmatched = repo.getUnmatchedContracts();
      expect(unmatched).toHaveLength(1);
      expect(unmatched[0].id).toBe(c2);
    });
  });

  describe('findByProtocolAndKey', () => {
    it('returns contract by protocol and normalizedKey', () => {
      repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');

      const found = repo.findByProtocolAndKey('http', 'GET /vehicles');
      expect(found).not.toBeNull();
      expect(found!.protocol).toBe('http');
      expect(found!.normalizedKey).toBe('GET /vehicles');
    });

    it('returns null when not found', () => {
      expect(repo.findByProtocolAndKey('http', 'DELETE /nonexistent')).toBeNull();
    });
  });

  describe('getParticipantsWithDetails', () => {
    it('returns participants with definition names, file paths, and module paths', () => {
      const contractId = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.addParticipant(contractId, defId1, moduleId1, 'server');
      repo.addParticipant(contractId, defId2, moduleId2, 'client');

      const participants = repo.getParticipantsWithDetails(contractId);
      expect(participants).toHaveLength(2);

      const server = participants.find((p) => p.role === 'server')!;
      expect(server.definitionName).toBe('VehiclesController');
      expect(server.filePath).toBe('/src/controllers/vehicles.ts');
      expect(server.modulePath).toContain('backend');

      const client = participants.find((p) => p.role === 'client')!;
      expect(client.definitionName).toBe('vehiclesService');
      expect(client.filePath).toBe('/src/services/vehicles.ts');
      expect(client.modulePath).toContain('frontend');
    });

    it('returns empty array for non-existent contract', () => {
      const participants = repo.getParticipantsWithDetails(999);
      expect(participants).toHaveLength(0);
    });
  });

  describe('getParticipantsByModule', () => {
    it('returns participants for a specific module', () => {
      const c1 = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.addParticipant(c1, defId1, moduleId1, 'server');
      repo.addParticipant(c1, defId2, moduleId2, 'client');

      const participants = repo.getParticipantsByModule(moduleId1);
      expect(participants).toHaveLength(1);
      expect(participants[0].role).toBe('server');
      expect(participants[0].protocol).toBe('http');
    });
  });

  describe('getProtocolBreakdown', () => {
    it('returns count per protocol', () => {
      repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.upsertContract('http', 'POST /vehicles', 'POST /vehicles');
      repo.upsertContract('ws', 'events', 'events');

      const breakdown = repo.getProtocolBreakdown();
      expect(breakdown).toHaveLength(2);
      expect(breakdown.find((b) => b.protocol === 'http')!.count).toBe(2);
      expect(breakdown.find((b) => b.protocol === 'ws')!.count).toBe(1);
    });
  });

  describe('backfillModuleIds', () => {
    it('fills NULL module_ids from module_members', () => {
      const contractId = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      // Add participant with NULL module_id
      repo.addParticipant(contractId, defId1, null, 'server');

      const backfilled = repo.backfillModuleIds();
      expect(backfilled).toBe(1);

      const contract = repo.getWithParticipants(contractId);
      expect(contract!.participants[0].moduleId).toBe(moduleId1);
    });
  });

  describe('clear', () => {
    it('deletes all contracts and participants', () => {
      const c1 = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.addParticipant(c1, defId1, moduleId1, 'server');

      repo.clear();
      expect(repo.getCount()).toBe(0);
      expect(repo.getParticipantCount()).toBe(0);
    });
  });

  describe('getTopologyBetweenGroups', () => {
    it('returns edges between process groups', () => {
      const c1 = repo.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      repo.addParticipant(c1, defId1, moduleId1, 'server');
      repo.addParticipant(c1, defId2, moduleId2, 'client');

      const moduleToGroup = new Map([
        [moduleId1, 'backend-group'],
        [moduleId2, 'frontend-group'],
      ]);

      const topology = repo.getTopologyBetweenGroups(moduleToGroup);
      expect(topology).toHaveLength(1);
      expect(topology[0].contractCount).toBe(1);
      expect(topology[0].protocols).toContain('http');
    });
  });
});
