import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enforceBaseClassRule } from '../../../../src/commands/modules/phases/assignment-phase.js';
import { FileRepository } from '../../../../src/db/repositories/file-repository.js';
import { ModuleRepository } from '../../../../src/db/repositories/module-repository.js';
import { SCHEMA } from '../../../../src/db/schema.js';

function createMockDb(sqliteDb: Database.Database) {
  const modules = new ModuleRepository(sqliteDb);
  return { modules } as any;
}

function createMockCommand() {
  const logs: string[] = [];
  return {
    command: { log: (msg: string) => logs.push(msg), warn: () => {} } as any,
    logs,
  };
}

describe('enforceBaseClassRule', () => {
  let sqliteDb: Database.Database;
  let fileRepo: FileRepository;
  let moduleRepo: ModuleRepository;
  let fileId: number;

  beforeEach(() => {
    sqliteDb = new Database(':memory:');
    sqliteDb.exec(SCHEMA);
    fileRepo = new FileRepository(sqliteDb);
    moduleRepo = new ModuleRepository(sqliteDb);

    fileId = fileRepo.insert({
      path: '/test/file.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    sqliteDb.close();
  });

  function insertDef(name: string, extendsName?: string): number {
    return fileRepo.insertDefinition(fileId, {
      name,
      kind: 'class',
      isExported: true,
      isDefault: false,
      extends: extendsName,
      position: { row: 0, column: 0 },
      endPosition: { row: 10, column: 1 },
    });
  }

  it('reassigns base class from leaf to common ancestor', () => {
    // Tree: project -> backend -> [api, services]
    const rootId = moduleRepo.ensureRoot();
    const backendId = moduleRepo.insert(rootId, 'backend', 'Backend');
    const apiId = moduleRepo.insert(backendId, 'api', 'API');
    const servicesId = moduleRepo.insert(backendId, 'services', 'Services');

    const baseId = insertDef('BaseController', undefined);
    const sub1 = insertDef('UsersController', 'BaseController');
    const sub2 = insertDef('OrdersController', 'BaseController');

    // Base class in a leaf (api), extenders in two different leaf modules
    moduleRepo.assignSymbol(baseId, apiId);
    moduleRepo.assignSymbol(sub1, apiId);
    moduleRepo.assignSymbol(sub2, servicesId);

    const db = createMockDb(sqliteDb);
    const { command } = createMockCommand();

    enforceBaseClassRule({ db, command, isJson: false });

    // Base class should be reassigned to common ancestor (backend)
    const result = moduleRepo.getDefinitionModule(baseId);
    expect(result).not.toBeNull();
    expect(result!.module.slug).toBe('backend');
  });

  it('skips when base class is already in an ancestor module', () => {
    // Tree: project -> backend -> [api, services]
    const rootId = moduleRepo.ensureRoot();
    const backendId = moduleRepo.insert(rootId, 'backend', 'Backend');
    const apiId = moduleRepo.insert(backendId, 'api', 'API');
    const servicesId = moduleRepo.insert(backendId, 'services', 'Services');

    const baseId = insertDef('BaseController', undefined);
    const sub1 = insertDef('UsersController', 'BaseController');
    const sub2 = insertDef('OrdersController', 'BaseController');

    // Base class already in ancestor (backend)
    moduleRepo.assignSymbol(baseId, backendId);
    moduleRepo.assignSymbol(sub1, apiId);
    moduleRepo.assignSymbol(sub2, servicesId);

    const db = createMockDb(sqliteDb);
    const { command } = createMockCommand();

    enforceBaseClassRule({ db, command, isJson: false });

    // Should remain in backend (it's already an ancestor)
    const result = moduleRepo.getDefinitionModule(baseId);
    expect(result!.module.slug).toBe('backend');
  });

  it('skips when base class is in a branch module (not leaf)', () => {
    // Tree: project -> backend -> [api, services]
    const rootId = moduleRepo.ensureRoot();
    const backendId = moduleRepo.insert(rootId, 'backend', 'Backend');
    const apiId = moduleRepo.insert(backendId, 'api', 'API');
    const servicesId = moduleRepo.insert(backendId, 'services', 'Services');

    const baseId = insertDef('BaseController', undefined);
    const sub1 = insertDef('UsersController', 'BaseController');
    const sub2 = insertDef('OrdersController', 'BaseController');

    // Base class in branch module (backend has children)
    moduleRepo.assignSymbol(baseId, backendId);
    moduleRepo.assignSymbol(sub1, apiId);
    moduleRepo.assignSymbol(sub2, servicesId);

    const db = createMockDb(sqliteDb);
    const { command } = createMockCommand();

    enforceBaseClassRule({ db, command, isJson: false });

    // Should remain in backend (branch, not leaf)
    const result = moduleRepo.getDefinitionModule(baseId);
    expect(result!.module.slug).toBe('backend');
  });

  it('skips when all extenders are in the same module', () => {
    const rootId = moduleRepo.ensureRoot();
    const apiId = moduleRepo.insert(rootId, 'api', 'API');

    const baseId = insertDef('BaseController', undefined);
    const sub1 = insertDef('UsersController', 'BaseController');
    const sub2 = insertDef('OrdersController', 'BaseController');

    // All in the same module
    moduleRepo.assignSymbol(baseId, apiId);
    moduleRepo.assignSymbol(sub1, apiId);
    moduleRepo.assignSymbol(sub2, apiId);

    const db = createMockDb(sqliteDb);
    const { command } = createMockCommand();

    enforceBaseClassRule({ db, command, isJson: false });

    // Should remain in api — only 1 unique extender module
    const result = moduleRepo.getDefinitionModule(baseId);
    expect(result!.module.slug).toBe('api');
  });

  it('skips when common ancestor is root (depth 0)', () => {
    // Tree: project -> [frontend, backend], extenders span distant branches
    const rootId = moduleRepo.ensureRoot();
    const frontendId = moduleRepo.insert(rootId, 'frontend', 'Frontend');
    const backendId = moduleRepo.insert(rootId, 'backend', 'Backend');

    const baseId = insertDef('BaseService', undefined);
    const sub1 = insertDef('FrontService', 'BaseService');
    const sub2 = insertDef('BackService', 'BaseService');

    // Base in frontend leaf, extenders in frontend and backend → ancestor is root
    moduleRepo.assignSymbol(baseId, frontendId);
    moduleRepo.assignSymbol(sub1, frontendId);
    moduleRepo.assignSymbol(sub2, backendId);

    const db = createMockDb(sqliteDb);
    const { command } = createMockCommand();

    enforceBaseClassRule({ db, command, isJson: false });

    // Should NOT be moved to root — root is depth 0
    const result = moduleRepo.getDefinitionModule(baseId);
    expect(result!.module.slug).toBe('frontend');
  });

  it('does nothing when there are no base class candidates', () => {
    const rootId = moduleRepo.ensureRoot();
    const apiId = moduleRepo.insert(rootId, 'api', 'API');

    const def1 = insertDef('ServiceA');
    moduleRepo.assignSymbol(def1, apiId);

    const db = createMockDb(sqliteDb);
    const { command, logs } = createMockCommand();

    enforceBaseClassRule({ db, command, isJson: false });

    // No log output about reassignment
    expect(logs.every((l) => !l.includes('Base class rule'))).toBe(true);
  });

  it('logs per-reassignment details when verbose is true', () => {
    const rootId = moduleRepo.ensureRoot();
    const backendId = moduleRepo.insert(rootId, 'backend', 'Backend');
    const apiId = moduleRepo.insert(backendId, 'api', 'API');
    const servicesId = moduleRepo.insert(backendId, 'services', 'Services');

    const baseId = insertDef('BaseController', undefined);
    const sub1 = insertDef('UsersController', 'BaseController');
    const sub2 = insertDef('OrdersController', 'BaseController');

    moduleRepo.assignSymbol(baseId, apiId);
    moduleRepo.assignSymbol(sub1, apiId);
    moduleRepo.assignSymbol(sub2, servicesId);

    const db = createMockDb(sqliteDb);
    const { command, logs } = createMockCommand();

    enforceBaseClassRule({ db, command, isJson: false, verbose: true });

    // Should have verbose per-reassignment log
    expect(logs.some((l) => l.includes('BaseController'))).toBe(true);
  });
});
