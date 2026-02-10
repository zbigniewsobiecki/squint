import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowValidator } from '../../../src/commands/llm/flows/flow-validator.js';
import { IndexDatabase } from '../../../src/db/database.js';
import type { InteractionWithPaths, Module } from '../../../src/db/schema.js';

describe('FlowValidator parse methods', () => {
  let db: IndexDatabase;
  let validator: FlowValidator;

  beforeEach(() => {
    db = new IndexDatabase(':memory:');
    db.initialize();
    // FlowValidator requires command + flags but we only test private methods
    validator = new FlowValidator(db, {} as any, false, false);
  });

  afterEach(() => {
    db.close();
  });

  function makeModule(id: number, fullPath: string): Module {
    return {
      id,
      parentId: null,
      slug: fullPath.split('.').pop() || fullPath,
      name: fullPath,
      fullPath,
      description: null,
      depth: 1,
      colorIndex: 0,
      isTest: false,
    };
  }

  function makeInteraction(id: number, fromModuleId: number, toModuleId: number): InteractionWithPaths {
    return {
      id,
      fromModuleId,
      toModuleId,
      fromModulePath: `module.${fromModuleId}`,
      toModulePath: `module.${toModuleId}`,
      direction: 'uni',
      weight: 1,
      pattern: null,
      symbols: null,
      semantic: null,
      source: 'ast-inferred',
    };
  }

  // ============================================================
  // parseValidatorResponse (private, access via `as any`)
  // ============================================================

  describe('parseValidatorResponse', () => {
    it('well-formed CSV with valid module paths', () => {
      const modA = makeModule(1, 'project.frontend');
      const modB = makeModule(2, 'project.backend');
      const moduleByPath = new Map([
        ['project.frontend', modA],
        ['project.backend', modB],
      ]);
      const interactions = [makeInteraction(10, 1, 2)];

      const response = `\`\`\`csv
flow_name,stakeholder,action_type,target_entity,interaction_chain,description
"user logs in","user","process","auth","project.frontend→project.backend","Authenticates user"
\`\`\``;

      const result = (validator as any).parseValidatorResponse(response, interactions, moduleByPath);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('user logs in');
      expect(result[0].stakeholder).toBe('user');
      expect(result[0].interactionIds).toContain(10);
      expect(result[0].slug).toBe('user-logs-in');
    });

    it('CSV in code fence', () => {
      const modA = makeModule(1, 'project.api');
      const modB = makeModule(2, 'project.db');
      const moduleByPath = new Map([
        ['project.api', modA],
        ['project.db', modB],
      ]);
      const interactions = [makeInteraction(5, 1, 2)];

      const response = `\`\`\`csv
flow_name,stakeholder,action_type,target_entity,interaction_chain,description
"fetch data","system","view","data","project.api→project.db","Reads from database"
\`\`\``;

      const result = (validator as any).parseValidatorResponse(response, interactions, moduleByPath);
      expect(result).toHaveLength(1);
    });

    it('invalid module paths → skipped', () => {
      const moduleByPath = new Map<string, Module>();
      const interactions: InteractionWithPaths[] = [];

      const response = `flow_name,stakeholder,action_type,target_entity,interaction_chain,description
"test","user","view","x","nonexistent.a→nonexistent.b","Bad"`;

      const result = (validator as any).parseValidatorResponse(response, interactions, moduleByPath);
      expect(result).toHaveLength(0);
    });

    it('chain with <2 paths → skipped', () => {
      const modA = makeModule(1, 'project.api');
      const moduleByPath = new Map([['project.api', modA]]);
      const interactions: InteractionWithPaths[] = [];

      const response = `flow_name,stakeholder,action_type,target_entity,interaction_chain,description
"test","user","view","x","project.api","Only one module"`;

      const result = (validator as any).parseValidatorResponse(response, interactions, moduleByPath);
      expect(result).toHaveLength(0);
    });

    it('stakeholder/action normalization', () => {
      const modA = makeModule(1, 'project.frontend');
      const modB = makeModule(2, 'project.backend');
      const moduleByPath = new Map([
        ['project.frontend', modA],
        ['project.backend', modB],
      ]);
      const interactions = [makeInteraction(10, 1, 2)];

      const response = `flow_name,stakeholder,action_type,target_entity,interaction_chain,description
"admin action","admin","delete","users","project.frontend→project.backend","Admin removes user"`;

      const result = (validator as any).parseValidatorResponse(response, interactions, moduleByPath);
      expect(result).toHaveLength(1);
      expect(result[0].stakeholder).toBe('admin');
      expect(result[0].actionType).toBe('delete');
    });
  });

  // ============================================================
  // findModuleByPrefix (private, access via `as any`)
  // ============================================================

  describe('findModuleByPrefix', () => {
    it('exact path match', () => {
      const mod = makeModule(1, 'project.backend.api');
      const moduleByPath = new Map([['project.backend.api', mod]]);

      const result = (validator as any).findModuleByPrefix('project.backend.api', moduleByPath);
      expect(result).toBe(mod);
    });

    it('suffix match with dot separator', () => {
      const mod = makeModule(1, 'project.backend.api');
      const moduleByPath = new Map([['project.backend.api', mod]]);

      const result = (validator as any).findModuleByPrefix('api', moduleByPath);
      expect(result).toBe(mod);
    });

    it('no match → undefined', () => {
      const moduleByPath = new Map([['project.backend.api', makeModule(1, 'project.backend.api')]]);

      const result = (validator as any).findModuleByPrefix('nonexistent', moduleByPath);
      expect(result).toBeUndefined();
    });
  });
});
