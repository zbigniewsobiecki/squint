import { describe, expect, it } from 'vitest';
import { FlowTracer, buildFlowTracingContext } from '../../../src/commands/llm/flows/flow-tracer.js';
import type { EntryPointModuleInfo, FlowTracingContext } from '../../../src/commands/llm/flows/types.js';
import type { InteractionWithPaths } from '../../../src/db/schema.js';

function makeInteraction(
  overrides: Partial<InteractionWithPaths> & { id: number; fromModuleId: number; toModuleId: number }
): InteractionWithPaths {
  return {
    direction: 'uni',
    weight: 1,
    pattern: null,
    symbols: null,
    semantic: null,
    source: 'ast',
    createdAt: '2024-01-01',
    fromModulePath: `module-${overrides.fromModuleId}`,
    toModulePath: `module-${overrides.toModuleId}`,
    ...overrides,
  };
}

describe('flow-tracer', () => {
  // ============================================
  // buildFlowTracingContext
  // ============================================
  describe('buildFlowTracingContext', () => {
    it('builds defToModule lookup', () => {
      const modules = [
        { id: 1, fullPath: 'project.frontend', members: [{ definitionId: 10 }, { definitionId: 11 }] },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20 }] },
      ];
      const ctx = buildFlowTracingContext(new Map(), modules, []);
      expect(ctx.defToModule.get(10)).toEqual({ moduleId: 1, modulePath: 'project.frontend' });
      expect(ctx.defToModule.get(20)).toEqual({ moduleId: 2, modulePath: 'project.backend' });
    });

    it('builds interactionByModulePair lookup', () => {
      const interactions = [makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 })];
      const ctx = buildFlowTracingContext(new Map(), [], interactions);
      expect(ctx.interactionByModulePair.get('1->2')).toBe(100);
    });

    it('builds inferredFromModule lookup', () => {
      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'llm-inferred' }),
        makeInteraction({ id: 101, fromModuleId: 1, toModuleId: 3, source: 'ast' }),
      ];
      const ctx = buildFlowTracingContext(new Map(), [], interactions);
      const inferred = ctx.inferredFromModule.get(1) ?? [];
      expect(inferred).toHaveLength(1);
      expect(inferred[0].id).toBe(100);
    });

    it('builds allInteractionsFromModule lookup', () => {
      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 1, toModuleId: 3 }),
        makeInteraction({ id: 102, fromModuleId: 2, toModuleId: 3 }),
      ];
      const ctx = buildFlowTracingContext(new Map(), [], interactions);
      expect(ctx.allInteractionsFromModule.get(1)).toHaveLength(2);
      expect(ctx.allInteractionsFromModule.get(2)).toHaveLength(1);
    });
  });

  // ============================================
  // FlowTracer.traceFlowsFromEntryPoints
  // ============================================
  describe('FlowTracer.traceFlowsFromEntryPoints', () => {
    function buildSimpleContext(): FlowTracingContext {
      // Module 1 (frontend) has definitions 10, 11
      // Module 2 (backend) has definitions 20, 21
      // Module 3 (db) has definition 30
      // Call graph: 10 -> 20, 20 -> 30
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);
      callGraph.set(20, [30]);

      const modules = [
        { id: 1, fullPath: 'project.frontend', members: [{ definitionId: 10 }, { definitionId: 11 }] },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20 }, { definitionId: 21 }] },
        { id: 3, fullPath: 'project.db', members: [{ definitionId: 30 }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3 }),
      ];

      return buildFlowTracingContext(callGraph, modules, interactions);
    }

    it('traces a simple linear flow across modules', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            { id: 10, name: 'handleCreate', kind: 'function', actionType: 'create', targetEntity: 'customer' },
          ],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows).toHaveLength(1);
      expect(flows[0].interactionIds).toContain(100);
      expect(flows[0].interactionIds).toContain(101);
      expect(flows[0].definitionSteps.length).toBeGreaterThan(0);
    });

    it('generates flow name from actionType and targetEntity', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            { id: 10, name: 'handleCreate', kind: 'function', actionType: 'create', targetEntity: 'customer' },
          ],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows[0].name).toBe('CreateCustomerFlow');
      expect(flows[0].slug).toBe('create-customer-flow');
    });

    it('generates flow name from member name when no actionType/targetEntity', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            { id: 10, name: 'handlePayment', kind: 'function', actionType: null, targetEntity: null },
          ],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows[0].name).toBe('PaymentFlow');
    });

    it('strips Handler/Controller suffixes from name', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            { id: 10, name: 'PaymentHandler', kind: 'function', actionType: null, targetEntity: null },
          ],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows[0].name).toBe('PaymentFlow');
    });

    it('infers stakeholder from module path', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      // Test admin path
      const adminEntry: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.admin.panel',
          moduleName: 'Admin',
          memberDefinitions: [{ id: 10, name: 'Dashboard', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];
      expect(tracer.traceFlowsFromEntryPoints(adminEntry)[0].stakeholder).toBe('admin');

      // Test api path
      const apiEntry: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.api.users',
          moduleName: 'API',
          memberDefinitions: [{ id: 10, name: 'getUser', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];
      expect(tracer.traceFlowsFromEntryPoints(apiEntry)[0].stakeholder).toBe('external');

      // Test cron path
      const cronEntry: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.cron.cleanup',
          moduleName: 'Cron',
          memberDefinitions: [{ id: 10, name: 'cleanup', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];
      expect(tracer.traceFlowsFromEntryPoints(cronEntry)[0].stakeholder).toBe('system');

      // Test cli path
      const cliEntry: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.cli.migrate',
          moduleName: 'CLI',
          memberDefinitions: [{ id: 10, name: 'migrate', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];
      expect(tracer.traceFlowsFromEntryPoints(cliEntry)[0].stakeholder).toBe('developer');
    });

    it('defaults stakeholder to "user" for unknown paths', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [{ id: 10, name: 'Home', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];
      expect(tracer.traceFlowsFromEntryPoints(entryPoints)[0].stakeholder).toBe('user');
    });

    it('does not produce flow when no cross-module calls exist', () => {
      // All definitions in same module -> no cross-module steps
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [11]); // both in module 1

      const modules = [{ id: 1, fullPath: 'project.frontend', members: [{ definitionId: 10 }, { definitionId: 11 }] }];

      const ctx = buildFlowTracingContext(callGraph, modules, []);
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [{ id: 10, name: 'test', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows).toHaveLength(0);
    });

    it('handles cycles in call graph without infinite recursion', () => {
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);
      callGraph.set(20, [10]); // cycle

      const modules = [
        { id: 1, fullPath: 'project.frontend', members: [{ definitionId: 10 }] },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20 }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 1 }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [{ id: 10, name: 'test', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];

      // Should not hang - visited set prevents revisiting
      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows).toHaveLength(1);
    });

    it('extends flows with inferred interactions', () => {
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);

      const modules = [
        { id: 1, fullPath: 'project.frontend', members: [{ definitionId: 10 }] },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20 }] },
        { id: 3, fullPath: 'project.db', members: [{ definitionId: 30 }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        // Inferred interaction from backend to db
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'llm-inferred' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [{ id: 10, name: 'test', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows[0].interactionIds).toContain(101);
      expect(flows[0].inferredSteps.length).toBeGreaterThan(0);
    });

    it('follows AST interactions from traced modules (not just inferred)', () => {
      // Scenario: definition call graph traces frontend→backend (AST interaction 100)
      // Backend also has an AST interaction to services (101), which should be followed
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);

      const modules = [
        { id: 1, fullPath: 'project.frontend', members: [{ definitionId: 10 }] },
        { id: 2, fullPath: 'project.backend.api', members: [{ definitionId: 20 }] },
        { id: 3, fullPath: 'project.backend.services', members: [{ definitionId: 30 }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        // AST interaction from a traced module (backend.api → backend.services)
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'ast' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [{ id: 10, name: 'login', kind: 'function', actionType: 'process', targetEntity: 'auth' }],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      // Should include the AST interaction from the traced module (backend.api → backend.services)
      expect(flows[0].interactionIds).toContain(101);
    });

    it('stops expansion at depth 3', () => {
      // Chain: M1 → M2 → M3 → M4 → M5 → M6 → M7
      // Definition steps only cover M1 → M2, so M1 and M2 are seeds at depth 0
      // Expansion from seeds at depth 0:
      //   M2→M3 added, M3 enqueued at depth 1
      //   M3→M4 added, M4 enqueued at depth 2
      //   M4→M5 added, M5 enqueued at depth 3
      //   M5→M6 added (interactions from depth-3 module are still followed),
      //     but M6 NOT enqueued (depth 4 > maxExpansionDepth)
      //   M6→M7 never reached — M6 not in queue
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // M1 → M2 via call graph

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10 }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20 }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30 }] },
        { id: 4, fullPath: 'mod.m4', members: [{ definitionId: 40 }] },
        { id: 5, fullPath: 'mod.m5', members: [{ definitionId: 50 }] },
        { id: 6, fullPath: 'mod.m6', members: [{ definitionId: 60 }] },
        { id: 7, fullPath: 'mod.m7', members: [{ definitionId: 70 }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'ast' }),
        makeInteraction({ id: 102, fromModuleId: 3, toModuleId: 4, source: 'ast' }),
        makeInteraction({ id: 103, fromModuleId: 4, toModuleId: 5, source: 'ast' }),
        makeInteraction({ id: 104, fromModuleId: 5, toModuleId: 6, source: 'ast' }),
        makeInteraction({ id: 105, fromModuleId: 6, toModuleId: 7, source: 'ast' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'mod.m1',
          moduleName: 'M1',
          memberDefinitions: [{ id: 10, name: 'start', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      // Interaction 100 (M1→M2) is from definition steps
      expect(flows[0].interactionIds).toContain(100); // definition step
      expect(flows[0].interactionIds).toContain(101); // depth 1
      expect(flows[0].interactionIds).toContain(102); // depth 2
      expect(flows[0].interactionIds).toContain(103); // depth 3
      expect(flows[0].interactionIds).toContain(104); // from depth-3 module (M5→M6)
      expect(flows[0].interactionIds).not.toContain(105); // M6→M7 — M6 never enqueued
    });

    it('sets entry point info on flow', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            { id: 10, name: 'Home', kind: 'function', actionType: 'view', targetEntity: 'dashboard' },
          ],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows[0].entryPointModuleId).toBe(1);
      expect(flows[0].entryPointId).toBe(10);
      expect(flows[0].entryPath).toBe('project.frontend.Home');
      expect(flows[0].actionType).toBe('view');
      expect(flows[0].targetEntity).toBe('dashboard');
    });

    it('traces multiple members from one entry point module', () => {
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);
      callGraph.set(11, [20]);

      const modules = [
        { id: 1, fullPath: 'project.frontend', members: [{ definitionId: 10 }, { definitionId: 11 }] },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20 }] },
      ];

      const interactions = [makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 })];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            { id: 10, name: 'listUsers', kind: 'function', actionType: 'view', targetEntity: 'user' },
            { id: 11, name: 'createUser', kind: 'function', actionType: 'create', targetEntity: 'user' },
          ],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints);
      expect(flows).toHaveLength(2);
    });
  });
});
