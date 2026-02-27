import { describe, expect, it } from 'vitest';
import { type DesignedFlow, FlowArchitect } from '../../../src/commands/llm/flows/flow-architect.js';
import type {
  DefinitionEnrichmentContext,
  EntryPointModuleInfo,
  FlowSuggestion,
} from '../../../src/commands/llm/flows/types.js';

describe('FlowArchitect', () => {
  describe('parseFlowCSV', () => {
    it('parses well-formed CSV with 8 columns', () => {
      const csv = `\`\`\`csv
flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
user-views-vehicles,user views vehicle list,Displays vehicles,view,vehicle,user,project.frontend.VehicleList,project.frontend.VehicleList>project.frontend.hooks|project.frontend.hooks>project.backend.api
\`\`\``;

      const { flows, errors } = FlowArchitect.parseFlowCSV(csv);

      expect(errors).toHaveLength(0);
      expect(flows).toHaveLength(1);
      expect(flows[0].slug).toBe('user-views-vehicles');
      expect(flows[0].name).toBe('user views vehicle list');
      expect(flows[0].actionType).toBe('view');
      expect(flows[0].targetEntity).toBe('vehicle');
      expect(flows[0].stakeholder).toBe('user');
      expect(flows[0].entryModulePath).toBe('project.frontend.VehicleList');
      expect(flows[0].steps).toHaveLength(2);
      expect(flows[0].steps[0]).toEqual({ fromPath: 'project.frontend.VehicleList', toPath: 'project.frontend.hooks' });
      expect(flows[0].steps[1]).toEqual({ fromPath: 'project.frontend.hooks', toPath: 'project.backend.api' });
    });

    it('handles unfenced CSV', () => {
      const csv = `flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
admin-creates-item,admin creates item,Creates item,create,item,admin,app.pages.ItemForm,app.pages.ItemForm>app.hooks.useCreate`;

      const { flows, errors } = FlowArchitect.parseFlowCSV(csv);

      expect(errors).toHaveLength(0);
      expect(flows).toHaveLength(1);
      expect(flows[0].actionType).toBe('create');
    });

    it('parses pipe-delimited steps into from/to pairs', () => {
      const csv = `flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
f,name,desc,view,e,user,a.b,a.b>c.d|c.d>e.f|e.f>g.h`;

      const { flows } = FlowArchitect.parseFlowCSV(csv);

      expect(flows[0].steps).toHaveLength(3);
      expect(flows[0].steps[0]).toEqual({ fromPath: 'a.b', toPath: 'c.d' });
      expect(flows[0].steps[1]).toEqual({ fromPath: 'c.d', toPath: 'e.f' });
      expect(flows[0].steps[2]).toEqual({ fromPath: 'e.f', toPath: 'g.h' });
    });

    it('rejects rows with invalid action_type', () => {
      const csv = `flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
bad-flow,bad flow,desc,invalid_action,entity,user,a.b,a.b>c.d`;

      const { flows, errors } = FlowArchitect.parseFlowCSV(csv);

      expect(flows).toHaveLength(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Invalid action_type');
    });

    it('records errors for malformed rows', () => {
      const csv = `flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
only,three,columns`;

      const { flows, errors } = FlowArchitect.parseFlowCSV(csv);

      expect(flows).toHaveLength(0);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('handles empty response', () => {
      const { flows, errors } = FlowArchitect.parseFlowCSV('');

      expect(flows).toHaveLength(0);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('handles quoted fields containing commas', () => {
      const csv = `flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
view-x,view x,"Displays items, filtered by date",view,item,user,a.b,a.b>c.d`;

      const { flows, errors } = FlowArchitect.parseFlowCSV(csv);

      expect(errors).toHaveLength(0);
      expect(flows).toHaveLength(1);
      expect(flows[0].description).toBe('Displays items, filtered by date');
    });

    it('handles >> double separator in steps as from="" to="..."', () => {
      const csv = `flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
f,n,d,view,e,user,a.b,a.b>>c.d`;

      const { flows } = FlowArchitect.parseFlowCSV(csv);

      // First > is treated as separator: from="a.b", to=">c.d"
      expect(flows).toHaveLength(1);
      expect(flows[0].steps).toHaveLength(1);
      expect(flows[0].steps[0]).toEqual({ fromPath: 'a.b', toPath: '>c.d' });
    });

    it('parses multiple flows', () => {
      const csv = `flow_slug,flow_name,description,action_type,target_entity,stakeholder,entry_module_path,steps
view-items,user views items,Views items,view,item,user,app.ItemList,app.ItemList>app.hooks
create-items,user creates item,Creates item,create,item,user,app.ItemForm,app.ItemForm>app.api`;

      const { flows } = FlowArchitect.parseFlowCSV(csv);

      expect(flows).toHaveLength(2);
      expect(flows[0].actionType).toBe('view');
      expect(flows[1].actionType).toBe('create');
    });
  });

  describe('validateFlows', () => {
    function makeArchitect(): FlowArchitect {
      // Create with null db/command since validateFlows doesn't use them
      return new FlowArchitect(null as any, false, false);
    }

    function makeDesignedFlow(overrides: Partial<DesignedFlow> = {}): DesignedFlow {
      return {
        slug: 'test-flow',
        name: 'test flow',
        description: 'A test flow',
        actionType: 'view',
        targetEntity: 'item',
        stakeholder: 'user',
        entryModulePath: 'app.pages.ItemList',
        steps: [{ fromPath: 'app.pages.ItemList', toPath: 'app.hooks.useItems' }],
        ...overrides,
      };
    }

    const modulePathToId = new Map([
      ['app.pages.ItemList', 1],
      ['app.hooks.useItems', 2],
      ['app.api.ItemController', 3],
      ['app.services.ItemService', 4],
    ]);

    const interactionByModulePair = new Map([
      ['1->2', 100],
      ['2->3', 101],
      ['3->4', 102],
    ]);

    const entryPoints: EntryPointModuleInfo[] = [
      {
        moduleId: 1,
        modulePath: 'app.pages.ItemList',
        moduleName: 'ItemList',
        memberDefinitions: [
          {
            id: 10,
            name: 'ItemList',
            kind: 'function',
            actionType: 'view',
            targetEntity: 'item',
            stakeholder: 'user',
            traceFromDefinition: null,
          },
        ],
      },
    ];

    it('validates all steps matching interactions → full flow returned', () => {
      const architect = makeArchitect();
      const flow = makeDesignedFlow({
        steps: [
          { fromPath: 'app.pages.ItemList', toPath: 'app.hooks.useItems' },
          { fromPath: 'app.hooks.useItems', toPath: 'app.api.ItemController' },
        ],
      });

      const result = architect.validateFlows([flow], interactionByModulePair, modulePathToId, entryPoints);

      expect(result.validFlows).toHaveLength(1);
      expect(result.validFlows[0].interactionIds).toEqual([100, 101]);
      expect(result.failedCount).toBe(0);
    });

    it('keeps only valid steps when some do not match', () => {
      const architect = makeArchitect();
      const flow = makeDesignedFlow({
        steps: [
          { fromPath: 'app.pages.ItemList', toPath: 'app.hooks.useItems' },
          { fromPath: 'app.hooks.useItems', toPath: 'app.services.ItemService' }, // No interaction 2->4
        ],
      });

      const result = architect.validateFlows([flow], interactionByModulePair, modulePathToId, entryPoints);

      expect(result.validFlows).toHaveLength(1);
      expect(result.validFlows[0].interactionIds).toEqual([100]);
    });

    it('drops flows with zero valid steps', () => {
      const architect = makeArchitect();
      const flow = makeDesignedFlow({
        steps: [
          { fromPath: 'app.services.ItemService', toPath: 'app.pages.ItemList' }, // No interaction 4->1
        ],
      });

      const result = architect.validateFlows([flow], interactionByModulePair, modulePathToId, entryPoints);

      expect(result.validFlows).toHaveLength(0);
      expect(result.failedCount).toBe(1);
    });

    it('drops flows with unknown entry module', () => {
      const architect = makeArchitect();
      const flow = makeDesignedFlow({
        entryModulePath: 'nonexistent.module',
      });

      const result = architect.validateFlows([flow], interactionByModulePair, modulePathToId, entryPoints);

      expect(result.validFlows).toHaveLength(0);
      expect(result.failedCount).toBe(1);
      expect(result.failureReasons).toContain('Unknown entry module: nonexistent.module');
    });

    it('returns empty results for empty flow list', () => {
      const architect = makeArchitect();
      const result = architect.validateFlows([], interactionByModulePair, modulePathToId, entryPoints);

      expect(result.validFlows).toHaveLength(0);
      expect(result.failedCount).toBe(0);
      expect(result.failureReasons).toHaveLength(0);
    });

    it('sets null entryPointId when entry point module has no matching definitions', () => {
      const architect = makeArchitect();
      const flow = makeDesignedFlow({
        actionType: 'delete',
        targetEntity: 'order',
        steps: [{ fromPath: 'app.pages.ItemList', toPath: 'app.hooks.useItems' }],
      });

      // entryPoints only has a view/item definition — no delete/order match
      const result = architect.validateFlows([flow], interactionByModulePair, modulePathToId, entryPoints);

      expect(result.validFlows).toHaveLength(1);
      expect(result.validFlows[0].entryPointId).toBeNull();
    });

    it('reports correct failure counts and reasons', () => {
      const architect = makeArchitect();
      const flows = [
        makeDesignedFlow({ slug: 'valid', steps: [{ fromPath: 'app.pages.ItemList', toPath: 'app.hooks.useItems' }] }),
        makeDesignedFlow({ slug: 'bad-entry', entryModulePath: 'unknown.Module' }),
        makeDesignedFlow({
          slug: 'no-interactions',
          steps: [{ fromPath: 'app.services.ItemService', toPath: 'app.pages.ItemList' }],
        }),
      ];

      const result = architect.validateFlows(flows, interactionByModulePair, modulePathToId, entryPoints);

      expect(result.validFlows).toHaveLength(1);
      expect(result.failedCount).toBe(2);
      expect(result.failureReasons.length).toBeGreaterThan(0);
    });
  });

  describe('enrichWithDefinitionSteps', () => {
    function makeArchitect(): FlowArchitect {
      return new FlowArchitect(null as any, false, false);
    }

    function makeFlow(overrides: Partial<FlowSuggestion> = {}): FlowSuggestion {
      return {
        name: 'test flow',
        slug: 'test-flow',
        entryPointModuleId: 1,
        entryPointId: 10,
        entryPath: 'app.pages.ItemList',
        stakeholder: 'user',
        description: 'Test flow',
        interactionIds: [100, 101],
        definitionSteps: [],
        actionType: 'view',
        targetEntity: 'item',
        tier: 1,
        subflowSlugs: [],
        ...overrides,
      };
    }

    it('finds steps via call graph edges', () => {
      const architect = makeArchitect();
      const ctx: DefinitionEnrichmentContext = {
        definitionCallGraph: new Map([
          [10, [20]], // def 10 calls def 20 (in different module)
        ]),
        defToModule: new Map([
          [10, { moduleId: 1, modulePath: 'app.pages' }],
          [20, { moduleId: 2, modulePath: 'app.hooks' }],
        ]),
        moduleToDefIds: new Map([
          [1, [10]],
          [2, [20]],
        ]),
        definitionBridgeMap: new Map(),
      };

      const steps = architect.enrichWithDefinitionSteps(makeFlow(), ctx, 10);

      expect(steps).toHaveLength(1);
      expect(steps[0]).toEqual({
        fromDefinitionId: 10,
        toDefinitionId: 20,
        fromModuleId: 1,
        toModuleId: 2,
      });
    });

    it('finds steps via definition bridge map (contract-matched)', () => {
      const architect = makeArchitect();
      const ctx: DefinitionEnrichmentContext = {
        definitionCallGraph: new Map(),
        defToModule: new Map([
          [10, { moduleId: 1, modulePath: 'app.frontend' }],
          [30, { moduleId: 3, modulePath: 'app.backend' }],
        ]),
        moduleToDefIds: new Map([
          [1, [10]],
          [3, [30]],
        ]),
        definitionBridgeMap: new Map([
          [10, [{ interactionId: 100, toDefinitionId: 30, toModuleId: 3, source: 'contract-matched' as const }]],
        ]),
      };

      const steps = architect.enrichWithDefinitionSteps(makeFlow(), ctx, 10);

      expect(steps).toHaveLength(1);
      expect(steps[0]).toEqual({
        fromDefinitionId: 10,
        toDefinitionId: 30,
        fromModuleId: 1,
        toModuleId: 3,
      });
    });

    it('chains correctly across multiple module steps', () => {
      const architect = makeArchitect();
      const ctx: DefinitionEnrichmentContext = {
        definitionCallGraph: new Map([
          [10, [20]],
          [20, [30]],
        ]),
        defToModule: new Map([
          [10, { moduleId: 1, modulePath: 'app.pages' }],
          [20, { moduleId: 2, modulePath: 'app.hooks' }],
          [30, { moduleId: 3, modulePath: 'app.api' }],
        ]),
        moduleToDefIds: new Map([
          [1, [10]],
          [2, [20]],
          [3, [30]],
        ]),
        definitionBridgeMap: new Map(),
      };

      const steps = architect.enrichWithDefinitionSteps(makeFlow(), ctx, 10);

      expect(steps).toHaveLength(2);
      expect(steps[0].fromDefinitionId).toBe(10);
      expect(steps[0].toDefinitionId).toBe(20);
      expect(steps[1].fromDefinitionId).toBe(20);
      expect(steps[1].toDefinitionId).toBe(30);
    });

    it('stops at max 7 steps even with deeper call chains', () => {
      const architect = makeArchitect();

      // Build a linear call chain of 10 definitions across 10 modules
      const callGraph = new Map<number, number[]>();
      const defToModule = new Map<number, { moduleId: number; modulePath: string }>();
      const moduleToDefIds = new Map<number, number[]>();

      for (let i = 0; i < 10; i++) {
        const defId = 100 + i;
        const moduleId = i + 1;
        defToModule.set(defId, { moduleId, modulePath: `mod.${moduleId}` });
        moduleToDefIds.set(moduleId, [defId]);
        if (i < 9) {
          callGraph.set(defId, [defId + 1]);
        }
      }

      const ctx: DefinitionEnrichmentContext = {
        definitionCallGraph: callGraph,
        defToModule,
        moduleToDefIds,
        definitionBridgeMap: new Map(),
      };

      const flow = makeFlow({ entryPointModuleId: 1, interactionIds: [] });
      const steps = architect.enrichWithDefinitionSteps(flow, ctx, 100);

      expect(steps.length).toBe(7);
    });

    it('handles null entry definition ID by falling back to module definitions', () => {
      const architect = makeArchitect();
      const ctx: DefinitionEnrichmentContext = {
        definitionCallGraph: new Map([[10, [20]]]),
        defToModule: new Map([
          [10, { moduleId: 1, modulePath: 'app.pages' }],
          [20, { moduleId: 2, modulePath: 'app.hooks' }],
        ]),
        moduleToDefIds: new Map([
          [1, [10]],
          [2, [20]],
        ]),
        definitionBridgeMap: new Map(),
      };

      // Pass null as entryDefinitionId — should fall back to moduleToDefIds for module 1
      const steps = architect.enrichWithDefinitionSteps(makeFlow(), ctx, null);

      expect(steps).toHaveLength(1);
      expect(steps[0].fromDefinitionId).toBe(10);
      expect(steps[0].toDefinitionId).toBe(20);
    });

    it('returns empty when no definition paths exist', () => {
      const architect = makeArchitect();
      const ctx: DefinitionEnrichmentContext = {
        definitionCallGraph: new Map(),
        defToModule: new Map([[10, { moduleId: 1, modulePath: 'app.pages' }]]),
        moduleToDefIds: new Map([[1, [10]]]),
        definitionBridgeMap: new Map(),
      };

      const steps = architect.enrichWithDefinitionSteps(makeFlow(), ctx, 10);

      expect(steps).toHaveLength(0);
    });
  });

  describe('resolveEntryPointIds', () => {
    const entryPoints: EntryPointModuleInfo[] = [
      {
        moduleId: 1,
        modulePath: 'app.pages.ItemList',
        moduleName: 'ItemList',
        memberDefinitions: [
          {
            id: 10,
            name: 'ItemList',
            kind: 'function',
            actionType: 'view',
            targetEntity: 'item',
            stakeholder: 'user',
            traceFromDefinition: null,
          },
          {
            id: 11,
            name: 'ItemList',
            kind: 'function',
            actionType: 'create',
            targetEntity: 'item',
            stakeholder: 'user',
            traceFromDefinition: 'useCreateItem',
          },
          {
            id: 12,
            name: 'ItemList',
            kind: 'function',
            actionType: 'delete',
            targetEntity: 'order',
            stakeholder: 'admin',
            traceFromDefinition: null,
          },
        ],
      },
    ];

    function makeFlow(overrides: Partial<FlowSuggestion> = {}): FlowSuggestion {
      return {
        name: 'test',
        slug: 'test',
        entryPointModuleId: 1,
        entryPointId: null,
        entryPath: 'app.pages.ItemList',
        stakeholder: 'user',
        description: '',
        interactionIds: [100],
        definitionSteps: [],
        actionType: 'view',
        targetEntity: 'item',
        tier: 1,
        subflowSlugs: [],
        ...overrides,
      };
    }

    it('matches by actionType + targetEntity', () => {
      const flows = [makeFlow({ actionType: 'create', targetEntity: 'item' })];
      FlowArchitect.resolveEntryPointIds(flows, entryPoints);
      expect(flows[0].entryPointId).toBe(11);
    });

    it('falls back to first actionType match', () => {
      const flows = [makeFlow({ actionType: 'delete', targetEntity: 'item' })]; // No delete+item, but delete+order exists
      FlowArchitect.resolveEntryPointIds(flows, entryPoints);
      expect(flows[0].entryPointId).toBe(12);
    });

    it('leaves null when no match', () => {
      const flows = [makeFlow({ actionType: 'update', targetEntity: 'item' })]; // No update action
      FlowArchitect.resolveEntryPointIds(flows, entryPoints);
      expect(flows[0].entryPointId).toBeNull();
    });

    it('skips flows with null entryPointModuleId', () => {
      const flows = [makeFlow({ entryPointModuleId: null })];
      FlowArchitect.resolveEntryPointIds(flows, entryPoints);
      expect(flows[0].entryPointId).toBeNull();
    });

    it('handles empty entry points array without changes', () => {
      const flows = [makeFlow({ actionType: 'view', targetEntity: 'item' })];
      FlowArchitect.resolveEntryPointIds(flows, []);
      expect(flows[0].entryPointId).toBeNull();
    });
  });
});
