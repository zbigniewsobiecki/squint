import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractMatcher } from '../../src/commands/interactions/_shared/contract-matcher.js';
import type { ProcessGroups } from '../../src/commands/llm/_shared/process-utils.js';
import { IndexDatabase } from '../../src/db/database-facade.js';

describe('ContractMatcher', () => {
  let db: IndexDatabase;
  let matcher: ContractMatcher;
  let moduleId1: number;
  let moduleId2: number;
  let moduleId3: number;
  let defId1: number;
  let defId2: number;
  let defId3: number;
  let defId4: number;
  let processGroups: ProcessGroups;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
    matcher = new ContractMatcher();

    // Set up modules
    const rootId = db.modules.ensureRoot();
    moduleId1 = db.modules.insert(rootId, 'backend', 'Backend');
    moduleId2 = db.modules.insert(rootId, 'frontend', 'Frontend');
    moduleId3 = db.modules.insert(rootId, 'shared', 'Shared');

    // Set up definitions
    const fileId1 = db.files.insert({
      path: '/src/backend/controller.ts',
      language: 'typescript',
      contentHash: 'abc',
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
    const fileId2 = db.files.insert({
      path: '/src/frontend/service.ts',
      language: 'typescript',
      contentHash: 'def',
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
    const fileId3 = db.files.insert({
      path: '/src/backend/auth.ts',
      language: 'typescript',
      contentHash: 'ghi',
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });

    defId1 = db.files.insertDefinition(fileId1, {
      name: 'VehiclesController',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 50, column: 1 },
    });
    defId2 = db.files.insertDefinition(fileId2, {
      name: 'vehiclesService',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 30, column: 1 },
    });
    defId3 = db.files.insertDefinition(fileId3, {
      name: 'AuthController',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 40, column: 1 },
    });
    defId4 = db.files.insertDefinition(fileId2, {
      name: 'authService',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 35, column: 0 },
      endPosition: { row: 60, column: 1 },
    });

    db.modules.assignSymbol(defId1, moduleId1);
    db.modules.assignSymbol(defId2, moduleId2);
    db.modules.assignSymbol(defId3, moduleId1);
    db.modules.assignSymbol(defId4, moduleId2);

    // Process groups (not used for filtering, but required parameter)
    processGroups = {
      groups: [
        { label: 'backend', moduleIds: [moduleId1] },
        { label: 'frontend', moduleIds: [moduleId2] },
      ],
      groupCount: 2,
      moduleToGroup: new Map([
        [moduleId1, 'backend'],
        [moduleId2, 'frontend'],
      ]),
    };
  });

  afterEach(() => {
    db.close();
  });

  describe('match - double-counting fix', () => {
    it('produces one match per contract (not two)', () => {
      const contractId = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(contractId, defId1, moduleId1, 'server');
      db.contracts.addParticipant(contractId, defId2, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);

      // Should produce exactly 1 match, not 2
      expect(matches).toHaveLength(1);
      expect(matches[0].fromModuleId).toBe(moduleId2); // client is initiator
      expect(matches[0].toModuleId).toBe(moduleId1); // server is handler
    });

    it('produces correct number of matches for multiple contracts', () => {
      const c1 = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c1, defId1, moduleId1, 'server');
      db.contracts.addParticipant(c1, defId2, moduleId2, 'client');

      const c2 = db.contracts.upsertContract('http', 'POST /auth/login', 'POST /auth/login');
      db.contracts.addParticipant(c2, defId3, moduleId1, 'server');
      db.contracts.addParticipant(c2, defId4, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);

      // 2 contracts, each with server+client → 2 matches total (not 4)
      expect(matches).toHaveLength(2);
    });

    it('identifies initiator correctly', () => {
      const contractId = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(contractId, defId1, moduleId1, 'server');
      db.contracts.addParticipant(contractId, defId2, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);
      expect(matches[0].initiator.definitionId).toBe(defId2); // client = initiator
      expect(matches[0].handler.definitionId).toBe(defId1); // server = handler
    });
  });

  describe('match - unmatched contracts', () => {
    it('returns no matches for one-sided contracts', () => {
      const contractId = db.contracts.upsertContract('http', 'POST /register', 'POST /register');
      db.contracts.addParticipant(contractId, defId1, moduleId1, 'server');

      const matches = matcher.match(db, processGroups);
      expect(matches).toHaveLength(0);
    });

    it('skips participants with null moduleId', () => {
      const contractId = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(contractId, defId1, null, 'server');
      db.contracts.addParticipant(contractId, defId2, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);
      expect(matches).toHaveLength(0);
    });

    it('skips self-module matches', () => {
      const contractId = db.contracts.upsertContract('http', 'GET /internal', 'GET /internal');
      db.contracts.addParticipant(contractId, defId1, moduleId1, 'server');
      db.contracts.addParticipant(contractId, defId3, moduleId1, 'client'); // same module

      const matches = matcher.match(db, processGroups);
      expect(matches).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('returns correct matched/unmatched counts', () => {
      const c1 = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c1, defId1, moduleId1, 'server');
      db.contracts.addParticipant(c1, defId2, moduleId2, 'client');

      const c2 = db.contracts.upsertContract('http', 'POST /register', 'POST /register');
      db.contracts.addParticipant(c2, defId3, moduleId1, 'server');

      const stats = matcher.getStats(db, processGroups);
      expect(stats.matched).toBe(1);
      expect(stats.unmatched).toBe(1);
    });
  });

  describe('fuzzy cross-contract matching', () => {
    it('matches complementary roles across two contracts with different API prefixes', () => {
      // Server contract: /api/v1/vehicles
      const c1 = db.contracts.upsertContract('http', 'GET /api/v1/vehicles', 'GET /api/v1/vehicles');
      db.contracts.addParticipant(c1, defId1, moduleId1, 'server');

      // Client contract: /vehicles (no prefix)
      const c2 = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c2, defId2, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);

      // Phase 1 (exact) finds nothing, Phase 2 (fuzzy) should find the cross-contract match
      expect(matches).toHaveLength(1);
      expect(matches[0].fromModuleId).toBe(moduleId2); // client = initiator
      expect(matches[0].toModuleId).toBe(moduleId1); // server = handler
    });

    it('does not fuzzy-match contracts that are already exactly matched', () => {
      // Single contract with both roles — exact match handles it
      const c1 = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c1, defId1, moduleId1, 'server');
      db.contracts.addParticipant(c1, defId2, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);

      // Should get exactly 1 match from Phase 1, not duplicated by Phase 2
      expect(matches).toHaveLength(1);
    });

    it('does not fuzzy-match across different protocols', () => {
      const c1 = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c1, defId1, moduleId1, 'server');

      const c2 = db.contracts.upsertContract('websocket', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c2, defId2, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);

      expect(matches).toHaveLength(0);
    });

    it('does not fuzzy-match same module', () => {
      const c1 = db.contracts.upsertContract('http', 'GET /api/v1/vehicles', 'GET /api/v1/vehicles');
      db.contracts.addParticipant(c1, defId1, moduleId1, 'server');

      const c2 = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c2, defId3, moduleId1, 'client'); // same module as server

      const matches = matcher.match(db, processGroups);

      expect(matches).toHaveLength(0);
    });

    it('fuzzy-matches /api prefix variants', () => {
      const c1 = db.contracts.upsertContract('http', 'POST /api/users', 'POST /api/users');
      db.contracts.addParticipant(c1, defId1, moduleId1, 'server');

      const c2 = db.contracts.upsertContract('http', 'POST /users', 'POST /users');
      db.contracts.addParticipant(c2, defId2, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);

      expect(matches).toHaveLength(1);
      expect(matches[0].fromModuleId).toBe(moduleId2);
      expect(matches[0].toModuleId).toBe(moduleId1);
    });
  });

  describe('materializeInteractions', () => {
    it('creates interactions from matches with correct weights', () => {
      const c1 = db.contracts.upsertContract('http', 'GET /vehicles', 'GET /vehicles');
      db.contracts.addParticipant(c1, defId1, moduleId1, 'server');
      db.contracts.addParticipant(c1, defId2, moduleId2, 'client');

      const c2 = db.contracts.upsertContract('http', 'POST /auth/login', 'POST /auth/login');
      db.contracts.addParticipant(c2, defId3, moduleId1, 'server');
      db.contracts.addParticipant(c2, defId4, moduleId2, 'client');

      const matches = matcher.match(db, processGroups);
      const result = matcher.materializeInteractions(db, matches);

      // Both matches go frontend → backend, so one interaction with weight 2
      expect(result.created).toBe(1);
      expect(result.linked).toBe(2);

      const interaction = db.interactions.getByModules(moduleId2, moduleId1);
      expect(interaction).not.toBeNull();
      expect(interaction!.weight).toBe(2);
      expect(interaction!.source).toBe('contract-matched');
      expect(interaction!.confidence).toBe('high');
    });
  });
});
