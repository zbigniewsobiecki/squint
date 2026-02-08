import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DefinitionRepository } from '../../../src/db/repositories/definition-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';
import type { Definition } from '../../../src/parser/definition-extractor.js';

describe('DefinitionRepository', () => {
  let db: Database.Database;
  let repo: DefinitionRepository;
  let fileRepo: FileRepository;
  let fileId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new DefinitionRepository(db);
    fileRepo = new FileRepository(db);

    fileId = fileRepo.insert({
      path: '/test/file.ts',
      language: 'typescript',
      contentHash: 'abc123',
      sizeBytes: 100,
      modifiedAt: '2024-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    db.close();
  });

  function insertDefinition(def: Partial<Definition> & { name: string }): number {
    const fullDef: Definition = {
      name: def.name,
      kind: def.kind ?? 'function',
      isExported: def.isExported ?? true,
      isDefault: def.isDefault ?? false,
      position: def.position ?? { row: 0, column: 0 },
      endPosition: def.endPosition ?? { row: 10, column: 1 },
      extends: def.extends,
      implements: def.implements,
      extendsAll: def.extendsAll,
    };
    return fileRepo.insertDefinition(fileId, fullDef);
  }

  describe('getByName', () => {
    it('returns definition ID by file and name for exported definitions', () => {
      const defId = insertDefinition({ name: 'myFunction', isExported: true });

      const result = repo.getByName(fileId, 'myFunction');
      expect(result).toBe(defId);
    });

    it('returns null for non-exported definitions', () => {
      insertDefinition({ name: 'privateFunc', isExported: false });

      const result = repo.getByName(fileId, 'privateFunc');
      expect(result).toBeNull();
    });

    it('returns null for non-existent definition', () => {
      const result = repo.getByName(fileId, 'nonExistent');
      expect(result).toBeNull();
    });
  });

  describe('getAllByName', () => {
    it('returns all definitions with given name across files', () => {
      const fileId2 = fileRepo.insert({
        path: '/test/file2.ts',
        language: 'typescript',
        contentHash: 'def456',
        sizeBytes: 100,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });

      insertDefinition({ name: 'Config' });
      fileRepo.insertDefinition(fileId2, {
        name: 'Config',
        kind: 'interface',
        isExported: true,
        isDefault: false,
        position: { row: 0, column: 0 },
        endPosition: { row: 5, column: 1 },
      });

      const results = repo.getAllByName('Config');
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('Config');
      expect(results[1].name).toBe('Config');
    });

    it('returns empty array for non-existent name', () => {
      const results = repo.getAllByName('NonExistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('getById', () => {
    it('returns definition details by ID', () => {
      const defId = insertDefinition({
        name: 'MyClass',
        kind: 'class',
        isExported: true,
        isDefault: false,
        extends: 'BaseClass',
        implements: ['Interface1', 'Interface2'],
      });

      const def = repo.getById(defId);
      expect(def).not.toBeNull();
      expect(def!.name).toBe('MyClass');
      expect(def!.kind).toBe('class');
      expect(def!.isExported).toBe(true);
      expect(def!.filePath).toBe('/test/file.ts');
      expect(def!.extendsName).toBe('BaseClass');
      expect(def!.implementsNames).toEqual(['Interface1', 'Interface2']);
    });

    it('returns null for non-existent ID', () => {
      const def = repo.getById(999);
      expect(def).toBeNull();
    });
  });

  describe('getCount', () => {
    it('returns count of definitions', () => {
      expect(repo.getCount()).toBe(0);

      insertDefinition({ name: 'func1' });
      expect(repo.getCount()).toBe(1);

      insertDefinition({ name: 'func2' });
      expect(repo.getCount()).toBe(2);
    });
  });

  describe('getForFile', () => {
    it('returns all definitions in a file', () => {
      insertDefinition({ name: 'func1', position: { row: 0, column: 0 }, endPosition: { row: 5, column: 1 } });
      insertDefinition({ name: 'func2', position: { row: 10, column: 0 }, endPosition: { row: 15, column: 1 } });

      const defs = repo.getForFile(fileId);
      expect(defs).toHaveLength(2);
      expect(defs[0].name).toBe('func1');
      expect(defs[1].name).toBe('func2');
    });

    it('returns definitions ordered by line', () => {
      insertDefinition({ name: 'second', position: { row: 20, column: 0 }, endPosition: { row: 25, column: 1 } });
      insertDefinition({ name: 'first', position: { row: 0, column: 0 }, endPosition: { row: 5, column: 1 } });

      const defs = repo.getForFile(fileId);
      expect(defs[0].name).toBe('first');
      expect(defs[1].name).toBe('second');
    });
  });

  describe('getAll', () => {
    it('returns all definitions', () => {
      insertDefinition({ name: 'func1' });
      insertDefinition({ name: 'func2' });

      const defs = repo.getAll();
      expect(defs).toHaveLength(2);
    });

    it('filters by kind', () => {
      insertDefinition({ name: 'myFunc', kind: 'function' });
      insertDefinition({ name: 'MyClass', kind: 'class' });

      const funcs = repo.getAll({ kind: 'function' });
      expect(funcs).toHaveLength(1);
      expect(funcs[0].name).toBe('myFunc');
    });

    it('filters by exported status', () => {
      insertDefinition({ name: 'exported', isExported: true });
      insertDefinition({ name: 'private', isExported: false });

      const exported = repo.getAll({ exported: true });
      expect(exported).toHaveLength(1);
      expect(exported[0].name).toBe('exported');

      const nonExported = repo.getAll({ exported: false });
      expect(nonExported).toHaveLength(1);
      expect(nonExported[0].name).toBe('private');
    });
  });

  describe('getSubclasses', () => {
    it('returns classes that extend a given class', () => {
      insertDefinition({ name: 'BaseClass', kind: 'class' });
      insertDefinition({ name: 'Child1', kind: 'class', extends: 'BaseClass' });
      insertDefinition({ name: 'Child2', kind: 'class', extends: 'BaseClass' });
      insertDefinition({ name: 'Unrelated', kind: 'class' });

      const subclasses = repo.getSubclasses('BaseClass');
      expect(subclasses).toHaveLength(2);
      expect(subclasses.map(s => s.name).sort()).toEqual(['Child1', 'Child2']);
    });

    it('returns empty array when no subclasses', () => {
      insertDefinition({ name: 'BaseClass', kind: 'class' });

      const subclasses = repo.getSubclasses('BaseClass');
      expect(subclasses).toHaveLength(0);
    });
  });

  describe('getImplementations', () => {
    it('returns classes that implement a given interface', () => {
      insertDefinition({ name: 'MyInterface', kind: 'interface' });
      insertDefinition({ name: 'Impl1', kind: 'class', implements: ['MyInterface'] });
      insertDefinition({ name: 'Impl2', kind: 'class', implements: ['MyInterface', 'OtherInterface'] });
      insertDefinition({ name: 'Unrelated', kind: 'class' });

      const impls = repo.getImplementations('MyInterface');
      expect(impls).toHaveLength(2);
      expect(impls.map(i => i.name).sort()).toEqual(['Impl1', 'Impl2']);
    });
  });

  describe('getClassHierarchy', () => {
    it('returns nodes and links for class hierarchy', () => {
      insertDefinition({ name: 'Base', kind: 'class' });
      insertDefinition({ name: 'Child', kind: 'class', extends: 'Base' });
      insertDefinition({ name: 'IFace', kind: 'interface' });
      insertDefinition({ name: 'Impl', kind: 'class', implements: ['IFace'] });

      const { nodes, links } = repo.getClassHierarchy();

      expect(nodes).toHaveLength(4);
      expect(links).toHaveLength(2);

      const extendsLink = links.find(l => l.type === 'extends');
      expect(extendsLink).toBeDefined();

      const implementsLink = links.find(l => l.type === 'implements');
      expect(implementsLink).toBeDefined();
    });
  });

  describe('getSymbols', () => {
    it('returns symbols with optional filters', () => {
      insertDefinition({ name: 'func1', kind: 'function' });
      insertDefinition({ name: 'MyClass', kind: 'class' });

      const all = repo.getSymbols();
      expect(all).toHaveLength(2);

      const funcs = repo.getSymbols({ kind: 'function' });
      expect(funcs).toHaveLength(1);
      expect(funcs[0].name).toBe('func1');

      const byFile = repo.getSymbols({ fileId });
      expect(byFile).toHaveLength(2);
    });
  });

  describe('getFilteredCount', () => {
    it('returns count with optional filters', () => {
      insertDefinition({ name: 'func1', kind: 'function' });
      insertDefinition({ name: 'MyClass', kind: 'class' });

      expect(repo.getFilteredCount()).toBe(2);
      expect(repo.getFilteredCount({ kind: 'function' })).toBe(1);
      expect(repo.getFilteredCount({ filePattern: 'file.ts' })).toBe(2);
      expect(repo.getFilteredCount({ filePattern: 'other.ts' })).toBe(0);
    });
  });
});
