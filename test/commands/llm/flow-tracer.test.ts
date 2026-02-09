import { describe, expect, it } from 'vitest';
import { FlowTracer, buildFlowTracingContext } from '../../../src/commands/llm/flows/flow-tracer.js';
import type {
  EntryPointModuleInfo,
  FlowSuggestion,
  FlowTracingContext,
} from '../../../src/commands/llm/flows/types.js';
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

function makeAtomicFlow(
  overrides: Partial<FlowSuggestion> & { slug: string; interactionIds: number[] }
): FlowSuggestion {
  return {
    name: overrides.slug,
    entryPointModuleId: null,
    entryPointId: null,
    entryPath: '',
    stakeholder: 'user',
    description: '',
    definitionSteps: [],
    inferredSteps: [],
    actionType: null,
    targetEntity: null,
    tier: 0,
    subflowSlugs: [],
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

    const simpleAtomics: FlowSuggestion[] = [
      makeAtomicFlow({ slug: 'frontend-to-backend', interactionIds: [100] }),
      makeAtomicFlow({ slug: 'backend-to-db', interactionIds: [101] }),
    ];

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

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, simpleAtomics);
      expect(flows).toHaveLength(1);
      expect(flows[0].interactionIds).toContain(100);
      expect(flows[0].interactionIds).toContain(101);
      expect(flows[0].definitionSteps.length).toBeGreaterThan(0);
    });

    it('produces tier-1 flows with subflowSlugs', () => {
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

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, simpleAtomics);
      expect(flows[0].tier).toBe(1);
      expect(flows[0].subflowSlugs).toContain('frontend-to-backend');
      expect(flows[0].subflowSlugs).toContain('backend-to-db');
    });

    it('still has leaf-level interactionIds for coverage', () => {
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

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, simpleAtomics);
      // interactionIds should contain leaf-level IDs (not subflow IDs)
      expect(flows[0].interactionIds).toEqual(expect.arrayContaining([100, 101]));
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

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, simpleAtomics);
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

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows[0].name).toBe('PaymentFlow');
    });

    it('infers stakeholder from module path', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const adminEntry: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'project.admin.panel',
          moduleName: 'Admin',
          memberDefinitions: [{ id: 10, name: 'Dashboard', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];
      expect(tracer.traceFlowsFromEntryPoints(adminEntry, simpleAtomics)[0].stakeholder).toBe('admin');
    });

    it('does not produce flow when no cross-module calls exist', () => {
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

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
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
      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
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

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, simpleAtomics);
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

      const atomics = [makeAtomicFlow({ slug: 'fe-be', interactionIds: [100] })];

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

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, atomics);
      expect(flows).toHaveLength(2);
    });

    it('does not perform BFS expansion — only uses definition-derived interactions', () => {
      // Chain: M1 → M2 → M3 → M4, but definition call graph only covers M1 → M2
      // The tracer should NOT expand beyond the definition graph
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // M1 → M2 via call graph

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10 }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20 }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30 }] },
        { id: 4, fullPath: 'mod.m4', members: [{ definitionId: 40 }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'ast' }),
        makeInteraction({ id: 102, fromModuleId: 3, toModuleId: 4, source: 'ast' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const atomics = [
        makeAtomicFlow({ slug: 'm1-m2', interactionIds: [100] }),
        makeAtomicFlow({ slug: 'm2-m3', interactionIds: [101] }),
        makeAtomicFlow({ slug: 'm3-m4', interactionIds: [102] }),
      ];

      const entryPoints: EntryPointModuleInfo[] = [
        {
          moduleId: 1,
          modulePath: 'mod.m1',
          moduleName: 'M1',
          memberDefinitions: [{ id: 10, name: 'start', kind: 'function', actionType: null, targetEntity: null }],
        },
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, atomics);
      // Only interaction 100 (M1→M2) should be included — no BFS expansion
      expect(flows[0].interactionIds).toContain(100);
      expect(flows[0].interactionIds).not.toContain(101);
      expect(flows[0].interactionIds).not.toContain(102);
      // Only the atomic covering interaction 100 should be referenced
      expect(flows[0].subflowSlugs).toEqual(['m1-m2']);
    });
  });
});
