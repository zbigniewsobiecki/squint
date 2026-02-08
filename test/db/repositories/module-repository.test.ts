import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { MetadataRepository } from '../../../src/db/repositories/metadata-repository.js';
import { ModuleRepository } from '../../../src/db/repositories/module-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('ModuleRepository', () => {
  let db: Database.Database;
  let repo: ModuleRepository;
  let fileRepo: FileRepository;
  let metadataRepo: MetadataRepository;
  let fileId: number;
  let defId1: number;
  let defId2: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new ModuleRepository(db);
    fileRepo = new FileRepository(db);
    metadataRepo = new MetadataRepository(db);

    fileId = fileRepo.insert({
      path: '/test/file.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });

    defId1 = fileRepo.insertDefinition(fileId, {
      name: 'ServiceA',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 20, column: 1 },
    });

    defId2 = fileRepo.insertDefinition(fileId, {
      name: 'ServiceB',
      kind: 'class',
      isExported: true,
      isDefault: false,
      position: { row: 25, column: 0 },
      endPosition: { row: 45, column: 1 },
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('ensureRoot', () => {
    it('creates root project module', () => {
      const rootId = repo.ensureRoot();

      expect(rootId).toBe(1);

      const root = repo.getById(rootId);
      expect(root).not.toBeNull();
      expect(root!.fullPath).toBe('project');
      expect(root!.name).toBe('Project');
      expect(root!.depth).toBe(0);
    });

    it('returns existing root on subsequent calls', () => {
      const id1 = repo.ensureRoot();
      const id2 = repo.ensureRoot();

      expect(id1).toBe(id2);
    });
  });

  describe('insert', () => {
    it('inserts a child module', () => {
      const rootId = repo.ensureRoot();
      const childId = repo.insert(rootId, 'auth', 'Authentication', 'Auth module');

      const child = repo.getById(childId);
      expect(child).not.toBeNull();
      expect(child!.slug).toBe('auth');
      expect(child!.fullPath).toBe('project.auth');
      expect(child!.name).toBe('Authentication');
      expect(child!.description).toBe('Auth module');
      expect(child!.depth).toBe(1);
    });

    it('inserts nested modules', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      const loginId = repo.insert(authId, 'login', 'Login');

      const login = repo.getById(loginId);
      expect(login!.fullPath).toBe('project.auth.login');
      expect(login!.depth).toBe(2);
    });

    it('throws for non-existent parent', () => {
      expect(() => repo.insert(999, 'child', 'Child')).toThrow();
    });
  });

  describe('getByPath', () => {
    it('returns module by full path', () => {
      const rootId = repo.ensureRoot();
      repo.insert(rootId, 'auth', 'Authentication');

      const module = repo.getByPath('project.auth');
      expect(module).not.toBeNull();
      expect(module!.name).toBe('Authentication');
    });

    it('returns null/undefined for non-existent path', () => {
      repo.ensureRoot();
      const module = repo.getByPath('project.nonexistent');
      expect(module).toBeFalsy();
    });
  });

  describe('getById', () => {
    it('returns module by ID', () => {
      const rootId = repo.ensureRoot();
      const module = repo.getById(rootId);

      expect(module).not.toBeNull();
      expect(module!.fullPath).toBe('project');
    });

    it('returns null/undefined for non-existent ID', () => {
      const module = repo.getById(999);
      expect(module).toBeFalsy();
    });
  });

  describe('getChildren', () => {
    it('returns direct children of a module', () => {
      const rootId = repo.ensureRoot();
      repo.insert(rootId, 'auth', 'Authentication');
      repo.insert(rootId, 'api', 'API');
      repo.insert(rootId, 'core', 'Core');

      const children = repo.getChildren(rootId);
      expect(children).toHaveLength(3);
      expect(children.map((c) => c.slug).sort()).toEqual(['api', 'auth', 'core']);
    });

    it('returns empty array for leaf module', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');

      const children = repo.getChildren(authId);
      expect(children).toHaveLength(0);
    });
  });

  describe('getAll', () => {
    it('returns all modules', () => {
      const rootId = repo.ensureRoot();
      repo.insert(rootId, 'auth', 'Authentication');
      repo.insert(rootId, 'api', 'API');

      const modules = repo.getAll();
      expect(modules).toHaveLength(3);
    });

    it('returns modules ordered by depth and path', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      repo.insert(rootId, 'api', 'API');
      repo.insert(authId, 'login', 'Login');

      const modules = repo.getAll();
      expect(modules[0].depth).toBe(0);
      expect(modules[1].depth).toBe(1);
      expect(modules[2].depth).toBe(1);
      expect(modules[3].depth).toBe(2);
    });
  });

  describe('getTree', () => {
    it('returns module tree structure', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      repo.insert(authId, 'login', 'Login');
      repo.insert(authId, 'logout', 'Logout');

      const tree = repo.getTree();
      expect(tree).not.toBeNull();
      expect(tree!.fullPath).toBe('project');
      expect(tree!.children).toHaveLength(1);
      expect(tree!.children[0].slug).toBe('auth');
      expect(tree!.children[0].children).toHaveLength(2);
    });

    it('returns null when no modules', () => {
      const tree = repo.getTree();
      expect(tree).toBeNull();
    });
  });

  describe('clear', () => {
    it('deletes all modules', () => {
      const rootId = repo.ensureRoot();
      repo.insert(rootId, 'auth', 'Authentication');

      repo.clear();

      expect(repo.getCount()).toBe(0);
    });
  });

  describe('assignSymbol', () => {
    it('assigns a definition to a module', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');

      repo.assignSymbol(defId1, authId);

      const symbols = repo.getSymbols(authId);
      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe('ServiceA');
    });

    it('replaces existing assignment', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      const apiId = repo.insert(rootId, 'api', 'API');

      repo.assignSymbol(defId1, authId);
      repo.assignSymbol(defId1, apiId);

      expect(repo.getSymbols(authId)).toHaveLength(0);
      expect(repo.getSymbols(apiId)).toHaveLength(1);
    });
  });

  describe('getUnassigned', () => {
    it('returns definitions not assigned to any module', () => {
      repo.ensureRoot();

      const unassigned = repo.getUnassigned();
      expect(unassigned).toHaveLength(2);
    });

    it('includes metadata in results', () => {
      repo.ensureRoot();
      metadataRepo.set(defId1, 'purpose', 'Test purpose');
      metadataRepo.set(defId1, 'domain', '["auth"]');

      const unassigned = repo.getUnassigned();
      const service = unassigned.find((u) => u.name === 'ServiceA');

      expect(service!.purpose).toBe('Test purpose');
      expect(service!.domain).toEqual(['auth']);
    });

    it('excludes assigned definitions', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      repo.assignSymbol(defId1, authId);

      const unassigned = repo.getUnassigned();
      expect(unassigned).toHaveLength(1);
      expect(unassigned[0].name).toBe('ServiceB');
    });
  });

  describe('getSymbols', () => {
    it('returns symbols assigned to a module', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');

      repo.assignSymbol(defId1, authId);
      repo.assignSymbol(defId2, authId);

      const symbols = repo.getSymbols(authId);
      expect(symbols).toHaveLength(2);
    });
  });

  describe('getWithMembers', () => {
    it('returns module with its members', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      repo.assignSymbol(defId1, authId);

      const moduleWithMembers = repo.getWithMembers(authId);

      expect(moduleWithMembers).not.toBeNull();
      expect(moduleWithMembers!.name).toBe('Authentication');
      expect(moduleWithMembers!.members).toHaveLength(1);
      expect(moduleWithMembers!.members[0].name).toBe('ServiceA');
    });

    it('returns null for non-existent module', () => {
      const moduleWithMembers = repo.getWithMembers(999);
      expect(moduleWithMembers).toBeNull();
    });
  });

  describe('getAllWithMembers', () => {
    it('returns all modules with their members', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      repo.assignSymbol(defId1, authId);

      const modulesWithMembers = repo.getAllWithMembers();

      expect(modulesWithMembers).toHaveLength(2);
      const authModule = modulesWithMembers.find((m) => m.slug === 'auth');
      expect(authModule!.members).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('returns module statistics', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      repo.assignSymbol(defId1, authId);

      const stats = repo.getStats();

      expect(stats.moduleCount).toBe(2);
      expect(stats.assigned).toBe(1);
      expect(stats.unassigned).toBe(1);
    });
  });

  describe('getCount', () => {
    it('returns count of modules', () => {
      expect(repo.getCount()).toBe(0);

      const rootId = repo.ensureRoot();
      expect(repo.getCount()).toBe(1);

      repo.insert(rootId, 'auth', 'Authentication');
      expect(repo.getCount()).toBe(2);
    });
  });

  describe('getDefinitionModule', () => {
    it('returns module for an assigned definition', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      repo.assignSymbol(defId1, authId);

      const result = repo.getDefinitionModule(defId1);

      expect(result).not.toBeNull();
      expect(result!.module.name).toBe('Authentication');
    });

    it('returns null for unassigned definition', () => {
      repo.ensureRoot();
      const result = repo.getDefinitionModule(defId1);
      expect(result).toBeNull();
    });
  });

  describe('getCallGraph', () => {
    it('returns symbol-level call graph', () => {
      // Create a call from defId1 to defId2
      const symId = fileRepo.insertSymbol(
        null,
        defId2,
        {
          name: 'ServiceB',
          localName: 'ServiceB',
          kind: 'class',
          usages: [],
        },
        fileId
      );

      fileRepo.insertUsage(symId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
        callsite: { argumentCount: 0, isMethodCall: false, isConstructorCall: false },
      });

      const edges = repo.getCallGraph();
      expect(edges.length).toBeGreaterThan(0);

      const edge = edges.find((e) => e.fromId === defId1 && e.toId === defId2);
      expect(edge).toBeDefined();
    });
  });

  describe('getIncomingEdgesFor', () => {
    it('returns callers of a definition with module info', () => {
      const rootId = repo.ensureRoot();
      const authId = repo.insert(rootId, 'auth', 'Authentication');
      repo.assignSymbol(defId1, authId);

      // Create a call from defId1 to defId2
      const symId = fileRepo.insertSymbol(
        null,
        defId2,
        {
          name: 'ServiceB',
          localName: 'ServiceB',
          kind: 'class',
          usages: [],
        },
        fileId
      );

      fileRepo.insertUsage(symId, {
        position: { row: 10, column: 5 },
        context: 'call_expression',
        callsite: { argumentCount: 0, isMethodCall: false, isConstructorCall: false },
      });

      const edges = repo.getIncomingEdgesFor(defId2);
      expect(edges.length).toBeGreaterThan(0);

      const edge = edges.find((e) => e.callerId === defId1);
      expect(edge).toBeDefined();
      expect(edge!.callerModuleId).toBe(authId);
    });
  });
});
