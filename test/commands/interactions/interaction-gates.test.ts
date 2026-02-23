import { beforeEach, describe, expect, it } from 'vitest';
import {
  gateInferredInteraction,
  isTypeOnlyModule,
} from '../../../src/commands/interactions/_shared/interaction-gates.js';
import { IndexDatabase } from '../../../src/db/database-facade.js';
import type { Module } from '../../../src/db/schema.js';

describe('interaction-gates', () => {
  let db: IndexDatabase;
  let moduleA: Module;
  let moduleB: Module;
  let moduleC: Module;
  let typeOnlyModuleId: number;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();

    // Set up modules
    const rootId = db.modules.ensureRoot();
    const idA = db.modules.insert(rootId, 'backend.services', 'Backend Services');
    const idB = db.modules.insert(rootId, 'backend.controllers', 'Backend Controllers');
    const idC = db.modules.insert(rootId, 'backend.models', 'Backend Models');
    typeOnlyModuleId = db.modules.insert(rootId, 'shared.types', 'Shared Types');

    // Create files and definitions for type-only module
    const typeFile = db.files.insert({
      path: '/src/shared/types.ts',
      language: 'typescript',
      contentHash: 'type1',
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });

    const interfaceDef = db.files.insertDefinition(typeFile, {
      name: 'UserDTO',
      kind: 'interface',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 10, column: 1 },
    });
    const typeDef = db.files.insertDefinition(typeFile, {
      name: 'Status',
      kind: 'type',
      isExported: true,
      isDefault: false,
      position: { row: 12, column: 0 },
      endPosition: { row: 12, column: 40 },
    });
    const enumDef = db.files.insertDefinition(typeFile, {
      name: 'Role',
      kind: 'enum',
      isExported: true,
      isDefault: false,
      position: { row: 14, column: 0 },
      endPosition: { row: 18, column: 1 },
    });
    db.modules.assignSymbol(interfaceDef, typeOnlyModuleId);
    db.modules.assignSymbol(typeDef, typeOnlyModuleId);
    db.modules.assignSymbol(enumDef, typeOnlyModuleId);

    // Create file + function for moduleC so it's NOT type-only
    const modelFile = db.files.insert({
      path: '/src/backend/models.ts',
      language: 'typescript',
      contentHash: 'model1',
      sizeBytes: 100,
      modifiedAt: '2024-01-01',
    });
    const funcDef = db.files.insertDefinition(modelFile, {
      name: 'createUser',
      kind: 'function',
      isExported: true,
      isDefault: false,
      position: { row: 0, column: 0 },
      endPosition: { row: 5, column: 1 },
    });
    db.modules.assignSymbol(funcDef, idC);

    // Fetch full Module objects
    const all = db.modules.getAll();
    moduleA = all.find((m) => m.id === idA)!;
    moduleB = all.find((m) => m.id === idB)!;
    moduleC = all.find((m) => m.id === idC)!;
  });

  describe('gateInferredInteraction', () => {
    it('rejects duplicate pairs', () => {
      const existingPairs = new Set([`${moduleA.id}->${moduleB.id}`]);

      const result = gateInferredInteraction(moduleA, moduleB, existingPairs, db);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe('duplicate');
    });

    it('rejects self-loops', () => {
      const existingPairs = new Set<string>();

      const result = gateInferredInteraction(moduleA, moduleA, existingPairs, db);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe('self-loop');
    });

    it('rejects reverse-of-AST interactions', () => {
      // Create an AST interaction B → A
      db.interactions.upsert(moduleB.id, moduleA.id, {
        semantic: 'Controllers use services',
        source: 'ast',
        pattern: 'business',
        weight: 1,
      });

      const existingPairs = new Set<string>();

      // Now try to infer A → B (reverse of the AST interaction)
      const result = gateInferredInteraction(moduleA, moduleB, existingPairs, db);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe('reverse-of-ast');
    });

    it('rejects reverse-of-ast-import interactions', () => {
      db.interactions.upsert(moduleB.id, moduleA.id, {
        semantic: 'Import dependency',
        source: 'ast-import',
        pattern: 'business',
        weight: 1,
      });

      const existingPairs = new Set<string>();

      const result = gateInferredInteraction(moduleA, moduleB, existingPairs, db);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe('reverse-of-ast');
    });

    it('does not reject reverse of llm-inferred interactions', () => {
      db.interactions.upsert(moduleB.id, moduleA.id, {
        semantic: 'LLM inferred',
        source: 'llm-inferred',
        pattern: 'business',
        weight: 1,
      });

      const existingPairs = new Set<string>();

      const result = gateInferredInteraction(moduleA, moduleB, existingPairs, db);

      expect(result.pass).toBe(true);
    });

    it('rejects type-only module as initiator', () => {
      const typeModule = db.modules.getAll().find((m) => m.id === typeOnlyModuleId)!;
      const existingPairs = new Set<string>();

      const result = gateInferredInteraction(typeModule, moduleB, existingPairs, db);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe('type-only-initiator');
    });

    it('passes valid interactions', () => {
      const existingPairs = new Set<string>();

      const result = gateInferredInteraction(moduleA, moduleB, existingPairs, db);

      expect(result.pass).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('isTypeOnlyModule', () => {
    it('returns true for modules with only interface/type/enum definitions', () => {
      expect(isTypeOnlyModule(typeOnlyModuleId, db)).toBe(true);
    });

    it('returns false for modules with functions', () => {
      expect(isTypeOnlyModule(moduleC.id, db)).toBe(false);
    });

    it('returns false for modules with no members', () => {
      // moduleA has no assigned members
      expect(isTypeOnlyModule(moduleA.id, db)).toBe(false);
    });
  });
});
