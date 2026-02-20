import { describe, expect, it } from 'vitest';
import { FlowTracer, buildFlowTracingContext } from '../../../src/commands/llm/flows/flow-tracer.js';
import type {
  EntryPointModuleInfo,
  FlowSuggestion,
  FlowTracingContext,
} from '../../../src/commands/llm/flows/types.js';
import type { InteractionDefinitionLink, InteractionWithPaths } from '../../../src/db/schema.js';

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

function makeDefLink(
  overrides: Partial<InteractionDefinitionLink & { toModuleId: number; source: string }> & {
    interactionId: number;
    fromDefinitionId: number;
    toDefinitionId: number;
    toModuleId: number;
    source: string;
  }
): InteractionDefinitionLink & { toModuleId: number; source: string } {
  return {
    contractId: 0,
    ...overrides,
  };
}

function makeEntryPoint(
  overrides: Partial<EntryPointModuleInfo> & {
    moduleId: number;
    modulePath: string;
    memberDefinitions: EntryPointModuleInfo['memberDefinitions'];
  }
): EntryPointModuleInfo {
  return {
    moduleName: overrides.modulePath.split('.').pop() ?? '',
    ...overrides,
  };
}

function makeMember(
  overrides: Partial<EntryPointModuleInfo['memberDefinitions'][0]> & { id: number; name: string }
): EntryPointModuleInfo['memberDefinitions'][0] {
  return {
    kind: 'function',
    actionType: null,
    targetEntity: null,
    stakeholder: null,
    traceFromDefinition: null,
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
        {
          id: 1,
          fullPath: 'project.frontend',
          members: [
            { definitionId: 10, name: 'comp1' },
            { definitionId: 11, name: 'comp2' },
          ],
        },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20, name: 'handler' }] },
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

    it('builds defIdToName lookup', () => {
      const modules = [
        {
          id: 1,
          fullPath: 'project.frontend',
          members: [
            { definitionId: 10, name: 'VehiclesPage' },
            { definitionId: 11, name: 'useCreateVehicle' },
          ],
        },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20, name: 'VehiclesController' }] },
      ];
      const ctx = buildFlowTracingContext(new Map(), modules, []);
      expect(ctx.defIdToName.get(10)).toBe('VehiclesPage');
      expect(ctx.defIdToName.get(11)).toBe('useCreateVehicle');
      expect(ctx.defIdToName.get(20)).toBe('VehiclesController');
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
        {
          id: 1,
          fullPath: 'project.frontend',
          members: [
            { definitionId: 10, name: 'handleCreate' },
            { definitionId: 11, name: 'handleView' },
          ],
        },
        {
          id: 2,
          fullPath: 'project.backend',
          members: [
            { definitionId: 20, name: 'createHandler' },
            { definitionId: 21, name: 'listHandler' },
          ],
        },
        { id: 3, fullPath: 'project.db', members: [{ definitionId: 30, name: 'insert' }] },
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

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            makeMember({ id: 10, name: 'handleCreate', actionType: 'create', targetEntity: 'customer' }),
          ],
        }),
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

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            makeMember({ id: 10, name: 'handleCreate', actionType: 'create', targetEntity: 'customer' }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, simpleAtomics);
      expect(flows[0].tier).toBe(1);
      expect(flows[0].subflowSlugs).toContain('frontend-to-backend');
      expect(flows[0].subflowSlugs).toContain('backend-to-db');
    });

    it('still has leaf-level interactionIds for coverage', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            makeMember({ id: 10, name: 'handleCreate', actionType: 'create', targetEntity: 'customer' }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, simpleAtomics);
      // interactionIds should contain leaf-level IDs (not subflow IDs)
      expect(flows[0].interactionIds).toEqual(expect.arrayContaining([100, 101]));
    });

    it('generates flow name from actionType and targetEntity', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            makeMember({ id: 10, name: 'handleCreate', actionType: 'create', targetEntity: 'customer' }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, simpleAtomics);
      expect(flows[0].name).toBe('CreateCustomerFlow');
      expect(flows[0].slug).toBe('create-customer-flow');
    });

    it('generates flow name from member name when no actionType/targetEntity', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'handlePayment' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows[0].name).toBe('PaymentFlow');
    });

    it('uses LLM-classified stakeholder from member definitions', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const adminEntry = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.admin.panel',
          memberDefinitions: [makeMember({ id: 10, name: 'Dashboard', stakeholder: 'admin' })],
        }),
      ];
      expect(tracer.traceFlowsFromEntryPoints(adminEntry, simpleAtomics)[0].stakeholder).toBe('admin');
    });

    it('does not produce flow when no cross-module calls exist', () => {
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [11]); // both in module 1

      const modules = [
        {
          id: 1,
          fullPath: 'project.frontend',
          members: [
            { definitionId: 10, name: 'comp1' },
            { definitionId: 11, name: 'comp2' },
          ],
        },
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, []);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'test' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(0);
    });

    it('handles cycles in call graph without infinite recursion', () => {
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);
      callGraph.set(20, [10]); // cycle

      const modules = [
        { id: 1, fullPath: 'project.frontend', members: [{ definitionId: 10, name: 'comp' }] },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20, name: 'handler' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 1 }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'test' })],
        }),
      ];

      // Should not hang - visited set prevents revisiting
      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
    });

    it('sets entry point info on flow', () => {
      const ctx = buildSimpleContext();
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'Home', actionType: 'view', targetEntity: 'dashboard' })],
        }),
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
        {
          id: 1,
          fullPath: 'project.frontend',
          members: [
            { definitionId: 10, name: 'listUsers' },
            { definitionId: 11, name: 'createUser' },
          ],
        },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20, name: 'handler' }] },
      ];

      const interactions = [makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 })];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const atomics = [makeAtomicFlow({ slug: 'fe-be', interactionIds: [100] })];

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [
            makeMember({ id: 10, name: 'listUsers', actionType: 'view', targetEntity: 'user' }),
            makeMember({ id: 11, name: 'createUser', actionType: 'create', targetEntity: 'user' }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, atomics);
      expect(flows).toHaveLength(2);
    });

    it('bridges via inferred interaction at leaf but does not recurse into target call graph', () => {
      // Call graph: 10→20 (M1→M2), def 20 is leaf
      // Inferred interaction: M2→M3, M3 has defs 30→40 (M3→M4)
      // Bridge should connect M2→M3 but NOT follow M3's call graph to M4
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // M1→M2 via call graph
      callGraph.set(30, [40]); // M3→M4 via call graph (should NOT be followed after bridge)

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'start' }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20, name: 'mid' }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30, name: 'target' }] },
        { id: 4, fullPath: 'mod.m4', members: [{ definitionId: 40, name: 'deep' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'llm-inferred' }),
        makeInteraction({ id: 102, fromModuleId: 3, toModuleId: 4, source: 'ast' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const atomics = [
        makeAtomicFlow({ slug: 'm1-m2', interactionIds: [100] }),
        makeAtomicFlow({ slug: 'm2-m3', interactionIds: [101] }),
        makeAtomicFlow({ slug: 'm3-m4', interactionIds: [102] }),
      ];

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'start' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, atomics);
      expect(flows).toHaveLength(1);
      // M1→M2 (call graph) and M2→M3 (bridge) should be covered
      expect(flows[0].interactionIds).toContain(100); // M1→M2 (call graph)
      expect(flows[0].interactionIds).toContain(101); // M2→M3 (inferred bridge)
      // M3→M4 should NOT be included — bridge targets don't expand their call graph
      expect(flows[0].interactionIds).not.toContain(102);
      expect(flows[0].inferredSteps.length).toBeGreaterThan(0);
      expect(flows[0].inferredSteps[0]).toEqual({
        fromModuleId: 2,
        toModuleId: 3,
        source: 'llm-inferred',
      });
    });

    it('no duplicate bridges from same module', () => {
      // Two leaf defs (20, 21) in same module M2, both with inferred interaction to M3
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20, 21]); // M1 calls both defs in M2

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'start' }] },
        {
          id: 2,
          fullPath: 'mod.m2',
          members: [
            { definitionId: 20, name: 'fn1' },
            { definitionId: 21, name: 'fn2' },
          ],
        },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30, name: 'target' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'llm-inferred' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'start' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      // Only one bridge step, not two
      const bridgeSteps = flows[0].inferredSteps.filter((s) => s.fromModuleId === 2 && s.toModuleId === 3);
      expect(bridgeSteps).toHaveLength(1);
    });

    it('no bridge at non-leaf (definition has outgoing call graph edges)', () => {
      // Def 20 has outgoing call graph edge (not a leaf), even though M2 has inferred interaction
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);
      callGraph.set(20, [30]); // Not a leaf

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'start' }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20, name: 'mid' }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30, name: 'end' }] },
        { id: 4, fullPath: 'mod.m4', members: [{ definitionId: 40, name: 'extra' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 4, source: 'llm-inferred' }),
        makeInteraction({ id: 102, fromModuleId: 2, toModuleId: 3, source: 'ast' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'start' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      // No inferred steps — def 20 is not a leaf
      expect(flows[0].inferredSteps).toHaveLength(0);
      // Should not contain the inferred interaction
      expect(flows[0].interactionIds).not.toContain(101);
    });

    it('no infinite loop through bridge cycle', () => {
      // M1 infers→M2, M2 infers→M1 — should terminate
      const callGraph = new Map<number, number[]>();
      // No call graph edges — both are leaves

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'start' }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20, name: 'target' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'llm-inferred' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 1, source: 'llm-inferred' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'start' })],
        }),
      ];

      // Should not hang
      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Should have bridged at least one direction
      expect(flows[0].inferredSteps.length).toBeGreaterThanOrEqual(1);
    });

    it('does not perform BFS expansion — only uses definition-derived interactions', () => {
      // Chain: M1 → M2 → M3 → M4, but definition call graph only covers M1 → M2
      // The tracer should NOT expand beyond the definition graph
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // M1 → M2 via call graph

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'start' }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20, name: 'mid' }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30, name: 'end' }] },
        { id: 4, fullPath: 'mod.m4', members: [{ definitionId: 40, name: 'deep' }] },
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

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'start' })],
        }),
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

  // ============================================
  // Fix A: Entry-point module boundary stopping
  // ============================================
  describe('entry-point module boundaries', () => {
    it('stops tracing at other entry-point modules', () => {
      // M1 (entry point) → M2 (entry point) → M3
      // Tracing from M1 should record M1→M2 but NOT recurse into M2→M3
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // M1 → M2
      callGraph.set(20, [30]); // M2 → M3

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'appRouter' }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20, name: 'vehiclesPage' }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30, name: 'vehicleService' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3 }),
        // M2 is a boundary target (reached via contract-matched from some other module)
        makeInteraction({ id: 102, fromModuleId: 99, toModuleId: 2, source: 'contract-matched' }),
      ];

      // Both M1 and M2 are entry points
      const entryPointModuleIds = new Set([1, 2]);
      const ctx = buildFlowTracingContext(callGraph, modules, interactions, entryPointModuleIds);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'appRouter' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // M1→M2 step should be recorded
      expect(flows[0].interactionIds).toContain(100);
      // M2→M3 should NOT be included — M2 is another entry point AND a boundary target
      expect(flows[0].interactionIds).not.toContain(101);
    });

    it('expands entry-point module that is not a boundary target', () => {
      // M1 (entry point, page) → M2 (entry point, component) → M3 (not entry point, shared)
      // M2 is entry point but NOT a target of any inferred/contract interaction
      // Tracer should expand through M2 into M3
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // M1 → M2
      callGraph.set(20, [30]); // M2 → M3

      const modules = [
        { id: 1, fullPath: 'mod.pages', members: [{ definitionId: 10, name: 'SalesPage' }] },
        { id: 2, fullPath: 'mod.components', members: [{ definitionId: 20, name: 'SaleForm' }] },
        { id: 3, fullPath: 'mod.hooks', members: [{ definitionId: 30, name: 'useCustomers' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3 }),
      ];

      // Both M1 and M2 are entry points, but NO inferred/contract interactions target M2
      const entryPointModuleIds = new Set([1, 2]);
      const ctx = buildFlowTracingContext(callGraph, modules, interactions, entryPointModuleIds);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.pages',
          memberDefinitions: [
            makeMember({ id: 10, name: 'SalesPage', actionType: 'view', targetEntity: 'sale', stakeholder: 'user' }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Should expand through M2 (not a boundary target) into M3
      expect(flows[0].interactionIds).toContain(100); // M1→M2
      expect(flows[0].interactionIds).toContain(101); // M2→M3
    });

    it('does not stop at own entry-point module', () => {
      // M1 (entry point) has defs that call into M2 (not entry point)
      // Should continue tracing normally
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);
      callGraph.set(20, [30]);

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'start' }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20, name: 'mid' }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30, name: 'end' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3 }),
      ];

      // Only M1 is entry point
      const entryPointModuleIds = new Set([1]);
      const ctx = buildFlowTracingContext(callGraph, modules, interactions, entryPointModuleIds);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'start' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Full chain should be traced
      expect(flows[0].interactionIds).toContain(100);
      expect(flows[0].interactionIds).toContain(101);
    });

    it('continues through non-entry-point modules', () => {
      // M1 (entry point) → M2 (not entry point) → M3 (not entry point)
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);
      callGraph.set(20, [30]);

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'start' }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20, name: 'mid' }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 30, name: 'end' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3 }),
      ];

      // M1 is entry point, M2 and M3 are not
      const entryPointModuleIds = new Set([1]);
      const ctx = buildFlowTracingContext(callGraph, modules, interactions, entryPointModuleIds);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'start' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      expect(flows[0].interactionIds).toContain(100);
      expect(flows[0].interactionIds).toContain(101);
    });

    it('buildFlowTracingContext stores entry point module IDs', () => {
      const entryPointModuleIds = new Set([1, 5, 10]);
      const ctx = buildFlowTracingContext(new Map(), [], [], entryPointModuleIds);
      expect(ctx.entryPointModuleIds).toEqual(new Set([1, 5, 10]));
    });

    it('buildFlowTracingContext defaults to empty set when no entry point IDs provided', () => {
      const ctx = buildFlowTracingContext(new Map(), [], []);
      expect(ctx.entryPointModuleIds).toEqual(new Set());
    });
  });

  // ============================================
  // Fix B: Contract-matched bridging
  // ============================================
  describe('contract-matched bridging', () => {
    it('bridges via contract-matched interaction at leaf', () => {
      // M1 → M2 (call graph), M2 is leaf with contract-matched interaction to M3
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // M1 → M2

      const modules = [
        { id: 1, fullPath: 'mod.frontend', members: [{ definitionId: 10, name: 'page' }] },
        { id: 2, fullPath: 'mod.services', members: [{ definitionId: 20, name: 'apiCall' }] },
        { id: 3, fullPath: 'mod.backend', members: [{ definitionId: 30, name: 'controller' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'contract-matched' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'page', actionType: 'view', targetEntity: 'vehicle' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Should bridge from M2 to M3 via contract-matched
      expect(flows[0].interactionIds).toContain(100);
      expect(flows[0].interactionIds).toContain(101);
      expect(flows[0].inferredSteps).toHaveLength(1);
      expect(flows[0].inferredSteps[0]).toEqual({
        fromModuleId: 2,
        toModuleId: 3,
        source: 'contract-matched',
      });
    });

    it('bridge source reflects actual interaction source', () => {
      // Two leaf modules: one with llm-inferred, one with contract-matched
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20, 21]); // M1 calls defs in M2 and M3

      const modules = [
        { id: 1, fullPath: 'mod.m1', members: [{ definitionId: 10, name: 'start' }] },
        { id: 2, fullPath: 'mod.m2', members: [{ definitionId: 20, name: 'leaf1' }] },
        { id: 3, fullPath: 'mod.m3', members: [{ definitionId: 21, name: 'leaf2' }] },
        { id: 4, fullPath: 'mod.m4', members: [{ definitionId: 40, name: 'target1' }] },
        { id: 5, fullPath: 'mod.m5', members: [{ definitionId: 50, name: 'target2' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 1, toModuleId: 3, source: 'ast' }),
        makeInteraction({ id: 102, fromModuleId: 2, toModuleId: 4, source: 'llm-inferred' }),
        makeInteraction({ id: 103, fromModuleId: 3, toModuleId: 5, source: 'contract-matched' }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.m1',
          memberDefinitions: [makeMember({ id: 10, name: 'start' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);

      const llmStep = flows[0].inferredSteps.find((s) => s.fromModuleId === 2);
      const contractStep = flows[0].inferredSteps.find((s) => s.fromModuleId === 3);
      expect(llmStep).toEqual({ fromModuleId: 2, toModuleId: 4, source: 'llm-inferred' });
      expect(contractStep).toEqual({ fromModuleId: 3, toModuleId: 5, source: 'contract-matched' });
    });

    it('includes contract-matched interactions in inferredFromModule lookup', () => {
      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'contract-matched' }),
        makeInteraction({ id: 101, fromModuleId: 1, toModuleId: 3, source: 'ast' }),
      ];
      const ctx = buildFlowTracingContext(new Map(), [], interactions);
      const bridgeable = ctx.inferredFromModule.get(1) ?? [];
      expect(bridgeable).toHaveLength(1);
      expect(bridgeable[0].id).toBe(100);
    });
  });

  // ============================================
  // Definition-level bridge precision
  // ============================================
  describe('definition-level bridge precision', () => {
    it('narrows fan-out: each leaf def bridges only to its own target', () => {
      // M1 has two leaf defs (20, 21) each with different definition-level bridges
      // def 20 → M3.controller, def 21 → M4.controller
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20, 21]); // M1 calls both defs in M2

      const modules = [
        { id: 1, fullPath: 'mod.frontend', members: [{ definitionId: 10, name: 'page' }] },
        {
          id: 2,
          fullPath: 'mod.services',
          members: [
            { definitionId: 20, name: 'vehiclesService' },
            { definitionId: 21, name: 'salesService' },
          ],
        },
        { id: 3, fullPath: 'mod.vehicles-backend', members: [{ definitionId: 30, name: 'VehiclesController' }] },
        { id: 4, fullPath: 'mod.sales-backend', members: [{ definitionId: 40, name: 'SalesController' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'contract-matched' }),
        makeInteraction({ id: 102, fromModuleId: 2, toModuleId: 4, source: 'contract-matched' }),
      ];

      const definitionLinks = [
        makeDefLink({
          interactionId: 101,
          fromDefinitionId: 20,
          toDefinitionId: 30,
          toModuleId: 3,
          source: 'contract-matched',
        }),
        makeDefLink({
          interactionId: 102,
          fromDefinitionId: 21,
          toDefinitionId: 40,
          toModuleId: 4,
          source: 'contract-matched',
        }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions, undefined, definitionLinks);
      const tracer = new FlowTracer(ctx);

      // Trace from page → vehiclesService path (def 10 calls def 20)
      // vehiclesService should ONLY bridge to VehiclesController, not SalesController
      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'page', actionType: 'view', targetEntity: 'vehicle' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Should bridge to BOTH targets (since page calls both services)
      expect(flows[0].interactionIds).toContain(101); // vehicles bridge
      expect(flows[0].interactionIds).toContain(102); // sales bridge
      // Each inferred step should map to the correct target
      const vehicleBridge = flows[0].inferredSteps.find((s) => s.toModuleId === 3);
      const salesBridge = flows[0].inferredSteps.find((s) => s.toModuleId === 4);
      expect(vehicleBridge).toBeDefined();
      expect(salesBridge).toBeDefined();
      // The definition steps should use exact toDefinitionId from links
      const vehicleDefStep = flows[0].definitionSteps.find((s) => s.toModuleId === 3);
      const salesDefStep = flows[0].definitionSteps.find((s) => s.toModuleId === 4);
      expect(vehicleDefStep?.toDefinitionId).toBe(30); // VehiclesController
      expect(salesDefStep?.toDefinitionId).toBe(40); // SalesController
    });

    it('falls back to module-level bridge when no definition links exist', () => {
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // M1 → M2

      const modules = [
        { id: 1, fullPath: 'mod.frontend', members: [{ definitionId: 10, name: 'page' }] },
        { id: 2, fullPath: 'mod.services', members: [{ definitionId: 20, name: 'apiCall' }] },
        { id: 3, fullPath: 'mod.backend', members: [{ definitionId: 30, name: 'controller' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'llm-inferred' }),
      ];

      // No definition links — should fall back to module-level
      const ctx = buildFlowTracingContext(callGraph, modules, interactions, undefined, []);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'page' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      expect(flows[0].interactionIds).toContain(101);
      expect(flows[0].inferredSteps).toHaveLength(1);
    });

    it('multiple defs bridge independently (not blocked by visitedBridgeModules)', () => {
      // Two leaf defs in SAME module, each with their own definition bridge
      // Both should fire independently
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20, 21]);

      const modules = [
        { id: 1, fullPath: 'mod.frontend', members: [{ definitionId: 10, name: 'page' }] },
        {
          id: 2,
          fullPath: 'mod.services',
          members: [
            { definitionId: 20, name: 'svcA' },
            { definitionId: 21, name: 'svcB' },
          ],
        },
        { id: 3, fullPath: 'mod.backendA', members: [{ definitionId: 30, name: 'ctrlA' }] },
        { id: 4, fullPath: 'mod.backendB', members: [{ definitionId: 40, name: 'ctrlB' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'contract-matched' }),
        makeInteraction({ id: 102, fromModuleId: 2, toModuleId: 4, source: 'contract-matched' }),
      ];

      const definitionLinks = [
        makeDefLink({
          interactionId: 101,
          fromDefinitionId: 20,
          toDefinitionId: 30,
          toModuleId: 3,
          source: 'contract-matched',
        }),
        makeDefLink({
          interactionId: 102,
          fromDefinitionId: 21,
          toDefinitionId: 40,
          toModuleId: 4,
          source: 'contract-matched',
        }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions, undefined, definitionLinks);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'page' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Both bridges should fire independently
      expect(flows[0].inferredSteps).toHaveLength(2);
      expect(flows[0].inferredSteps.find((s) => s.toModuleId === 3)).toBeDefined();
      expect(flows[0].inferredSteps.find((s) => s.toModuleId === 4)).toBeDefined();
    });

    it('uses exact toDefinitionId from link, not arbitrary representative', () => {
      // Target module has multiple defs, but bridge link specifies exact one
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);

      const modules = [
        { id: 1, fullPath: 'mod.frontend', members: [{ definitionId: 10, name: 'page' }] },
        { id: 2, fullPath: 'mod.services', members: [{ definitionId: 20, name: 'svc' }] },
        {
          id: 3,
          fullPath: 'mod.backend',
          members: [
            { definitionId: 30, name: 'helperA' },
            { definitionId: 31, name: 'targetController' },
            { definitionId: 32, name: 'helperB' },
          ],
        },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'contract-matched' }),
      ];

      // Link specifies def 31 (targetController), not def 30 (helperA, which would be first/arbitrary)
      const definitionLinks = [
        makeDefLink({
          interactionId: 101,
          fromDefinitionId: 20,
          toDefinitionId: 31,
          toModuleId: 3,
          source: 'contract-matched',
        }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions, undefined, definitionLinks);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'mod.frontend',
          moduleName: 'Frontend',
          memberDefinitions: [makeMember({ id: 10, name: 'page' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // The bridge step should use def 31, not def 30
      const bridgeStep = flows[0].definitionSteps.find((s) => s.toModuleId === 3);
      expect(bridgeStep?.toDefinitionId).toBe(31);
    });
  });

  // ============================================
  // E2E bridge continuation
  // ============================================
  describe('e2e bridge continuation', () => {
    it('definition-level bridge continues into backend call graph', () => {
      // Full e2e chain: M1(page) → M2(service) → M3(controller) → M4(backend-svc) → M5(repository)
      // Call graph: 10→20 (M1→M2), 30→40 (M3→M4), 40→50 (M4→M5)
      // Definition link: def 20 → def 30 (contract-matched, interaction 101)
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // page → service
      callGraph.set(30, [40]); // controller → backend-svc
      callGraph.set(40, [50]); // backend-svc → repository

      const modules = [
        { id: 1, fullPath: 'app.pages', members: [{ definitionId: 10, name: 'VehiclesPage' }] },
        { id: 2, fullPath: 'app.services', members: [{ definitionId: 20, name: 'vehiclesService' }] },
        { id: 3, fullPath: 'api.controllers', members: [{ definitionId: 30, name: 'VehiclesController' }] },
        { id: 4, fullPath: 'api.services', members: [{ definitionId: 40, name: 'VehiclesService' }] },
        { id: 5, fullPath: 'api.repositories', members: [{ definitionId: 50, name: 'VehicleRepository' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'contract-matched' }),
        makeInteraction({ id: 102, fromModuleId: 3, toModuleId: 4, source: 'ast' }),
        makeInteraction({ id: 103, fromModuleId: 4, toModuleId: 5, source: 'ast' }),
      ];

      const definitionLinks = [
        makeDefLink({
          interactionId: 101,
          fromDefinitionId: 20,
          toDefinitionId: 30,
          toModuleId: 3,
          source: 'contract-matched',
        }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions, undefined, definitionLinks);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'app.pages',
          memberDefinitions: [
            makeMember({
              id: 10,
              name: 'VehiclesPage',
              actionType: 'create',
              targetEntity: 'vehicle',
              stakeholder: 'user',
            }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Full chain: all 4 interactions should be covered
      expect(flows[0].interactionIds).toContain(100); // page → service
      expect(flows[0].interactionIds).toContain(101); // service → controller (bridge)
      expect(flows[0].interactionIds).toContain(102); // controller → backend-svc
      expect(flows[0].interactionIds).toContain(103); // backend-svc → repository
      // Definition steps should cross into backend
      expect(flows[0].definitionSteps.some((s) => s.fromModuleId === 3 && s.toModuleId === 4)).toBe(true);
      expect(flows[0].definitionSteps.some((s) => s.fromModuleId === 4 && s.toModuleId === 5)).toBe(true);
      // One inferred step for the contract bridge
      expect(flows[0].inferredSteps).toHaveLength(1);
      expect(flows[0].inferredSteps[0]).toEqual({ fromModuleId: 2, toModuleId: 3, source: 'contract-matched' });
    });

    it('module-level fallback bridge still stops (regression guard)', () => {
      // Same topology but NO definition links — bridge goes through module-level fallback
      // Backend call graph should NOT be followed
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // page → service (leaf)
      callGraph.set(30, [40]); // controller → backend-svc (should NOT be followed)

      const modules = [
        { id: 1, fullPath: 'app.pages', members: [{ definitionId: 10, name: 'VehiclesPage' }] },
        { id: 2, fullPath: 'app.services', members: [{ definitionId: 20, name: 'vehiclesService' }] },
        { id: 3, fullPath: 'api.controllers', members: [{ definitionId: 30, name: 'VehiclesController' }] },
        { id: 4, fullPath: 'api.services', members: [{ definitionId: 40, name: 'VehiclesService' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'contract-matched' }),
        makeInteraction({ id: 102, fromModuleId: 3, toModuleId: 4, source: 'ast' }),
      ];

      // No definition links — forces module-level fallback bridge
      const ctx = buildFlowTracingContext(callGraph, modules, interactions, undefined, []);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'app.pages',
          memberDefinitions: [makeMember({ id: 10, name: 'VehiclesPage' })],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // page → service and service → controller (bridge) should be covered
      expect(flows[0].interactionIds).toContain(100);
      expect(flows[0].interactionIds).toContain(101);
      // controller → backend-svc should NOT be followed (module-level bridge stops)
      expect(flows[0].interactionIds).not.toContain(102);
    });

    it('e2e bridge respects entry point boundary after crossing', () => {
      // M1(page) → M2(service) → M3(controller) → M4(backend-svc) → M5(other-controller)
      // M5 is an entry point AND a boundary target — should stop there
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]); // page → service
      callGraph.set(30, [40]); // controller → backend-svc
      callGraph.set(40, [50]); // backend-svc → other-controller (should be stopped)

      const modules = [
        { id: 1, fullPath: 'app.pages', members: [{ definitionId: 10, name: 'SalesPage' }] },
        { id: 2, fullPath: 'app.services', members: [{ definitionId: 20, name: 'salesService' }] },
        { id: 3, fullPath: 'api.sales-ctrl', members: [{ definitionId: 30, name: 'SalesController' }] },
        { id: 4, fullPath: 'api.sales-svc', members: [{ definitionId: 40, name: 'SalesService' }] },
        { id: 5, fullPath: 'api.vehicles-ctrl', members: [{ definitionId: 50, name: 'VehiclesController' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2, source: 'ast' }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3, source: 'contract-matched' }),
        makeInteraction({ id: 102, fromModuleId: 3, toModuleId: 4, source: 'ast' }),
        makeInteraction({ id: 103, fromModuleId: 4, toModuleId: 5, source: 'ast' }),
        // M5 is a boundary target (reached via contract-matched from some frontend service)
        makeInteraction({ id: 104, fromModuleId: 99, toModuleId: 5, source: 'contract-matched' }),
      ];

      const definitionLinks = [
        makeDefLink({
          interactionId: 101,
          fromDefinitionId: 20,
          toDefinitionId: 30,
          toModuleId: 3,
          source: 'contract-matched',
        }),
      ];

      // Both M1 and M5 are entry points; M5 is also a boundary target
      const entryPointModuleIds = new Set([1, 5]);
      const ctx = buildFlowTracingContext(callGraph, modules, interactions, entryPointModuleIds, definitionLinks);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'app.pages',
          memberDefinitions: [
            makeMember({ id: 10, name: 'SalesPage', actionType: 'create', targetEntity: 'sale', stakeholder: 'user' }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Should trace through the bridge into the backend
      expect(flows[0].interactionIds).toContain(100); // page → service
      expect(flows[0].interactionIds).toContain(101); // service → controller (bridge)
      expect(flows[0].interactionIds).toContain(102); // controller → backend-svc
      // M4→M5 step is recorded but M5 is NOT expanded (entry point + boundary target)
      expect(flows[0].definitionSteps.some((s) => s.fromModuleId === 4 && s.toModuleId === 5)).toBe(true);
      // The interaction for M4→M5 is recorded
      expect(flows[0].interactionIds).toContain(103);
    });
  });

  // ============================================
  // Action-aware tracing (traceFromDefinition)
  // ============================================
  describe('action-aware tracing', () => {
    it('resolves traceFromDefinition to correct callee and produces different trace', () => {
      // Page (def 10) calls useCreateVehicle (def 11 in hooks module 2) and useDeleteVehicle (def 12 in hooks module 2)
      // Hooks module 2 calls service module 3
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [11, 12]); // Page calls both hooks
      callGraph.set(11, [30]); // useCreateVehicle → service.create
      callGraph.set(12, [31]); // useDeleteVehicle → service.delete

      const modules = [
        { id: 1, fullPath: 'project.pages', members: [{ definitionId: 10, name: 'VehiclesPage' }] },
        {
          id: 2,
          fullPath: 'project.hooks',
          members: [
            { definitionId: 11, name: 'useCreateVehicle' },
            { definitionId: 12, name: 'useDeleteVehicle' },
          ],
        },
        {
          id: 3,
          fullPath: 'project.services',
          members: [
            { definitionId: 30, name: 'createVehicle' },
            { definitionId: 31, name: 'deleteVehicle' },
          ],
        },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 2, toModuleId: 3 }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      // Two entry points from same page: create traces from useCreateVehicle, delete from useDeleteVehicle
      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.pages',
          memberDefinitions: [
            makeMember({
              id: 10,
              name: 'VehiclesPage',
              actionType: 'create',
              targetEntity: 'vehicle',
              stakeholder: 'user',
              traceFromDefinition: 'useCreateVehicle',
            }),
            makeMember({
              id: 10,
              name: 'VehiclesPage',
              actionType: 'delete',
              targetEntity: 'vehicle',
              stakeholder: 'user',
              traceFromDefinition: 'useDeleteVehicle',
            }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(2);

      // Both should have interactions (cross-module calls)
      const createFlow = flows.find((f) => f.actionType === 'create');
      const deleteFlow = flows.find((f) => f.actionType === 'delete');
      expect(createFlow).toBeDefined();
      expect(deleteFlow).toBeDefined();

      // Create flow should trace through useCreateVehicle → createVehicle
      const createDefSteps = createFlow!.definitionSteps;
      expect(createDefSteps.some((s) => s.toDefinitionId === 11)).toBe(true); // initial step to useCreateVehicle
      expect(createDefSteps.some((s) => s.fromDefinitionId === 11 && s.toDefinitionId === 30)).toBe(true); // useCreateVehicle → createVehicle

      // Delete flow should trace through useDeleteVehicle → deleteVehicle
      const deleteDefSteps = deleteFlow!.definitionSteps;
      expect(deleteDefSteps.some((s) => s.toDefinitionId === 12)).toBe(true); // initial step to useDeleteVehicle
      expect(deleteDefSteps.some((s) => s.fromDefinitionId === 12 && s.toDefinitionId === 31)).toBe(true); // useDeleteVehicle → deleteVehicle
    });

    it('falls back to tracing from page when traceFromDefinition does not match any callee', () => {
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [20]);

      const modules = [
        { id: 1, fullPath: 'project.pages', members: [{ definitionId: 10, name: 'VehiclesPage' }] },
        { id: 2, fullPath: 'project.hooks', members: [{ definitionId: 20, name: 'useVehicles' }] },
      ];

      const interactions = [makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 })];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.pages',
          memberDefinitions: [
            makeMember({
              id: 10,
              name: 'VehiclesPage',
              actionType: 'create',
              targetEntity: 'vehicle',
              stakeholder: 'user',
              traceFromDefinition: 'useNonExistentHook', // Does not match any callee
            }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      // Should still produce a flow — falls back to tracing from the page itself
      expect(flows).toHaveLength(1);
      expect(flows[0].interactionIds).toContain(100);
    });

    it('view action ignores traceFromDefinition and traces full component tree', () => {
      // Page (def 10) calls Component (def 11, module 2) and Hook (def 12, module 3)
      // LLM incorrectly set traceFromDefinition: 'Hook'
      // With actionType: 'view', tracer should start from page (def 10), following BOTH edges
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [11, 12]); // Page calls Component and Hook
      callGraph.set(11, []);
      callGraph.set(12, []);

      const modules = [
        { id: 1, fullPath: 'project.pages', members: [{ definitionId: 10, name: 'SalesPage' }] },
        { id: 2, fullPath: 'project.components', members: [{ definitionId: 11, name: 'SaleForm' }] },
        { id: 3, fullPath: 'project.hooks', members: [{ definitionId: 12, name: 'useSales' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 1, toModuleId: 3 }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.pages',
          memberDefinitions: [
            makeMember({
              id: 10,
              name: 'SalesPage',
              actionType: 'view',
              targetEntity: 'sale',
              stakeholder: 'user',
              traceFromDefinition: 'useSales', // LLM incorrectly set this
            }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // View action should trace from page, including BOTH component and hook
      expect(flows[0].interactionIds).toContain(100); // Page → SaleForm (component)
      expect(flows[0].interactionIds).toContain(101); // Page → useSales (hook)
      // Should have steps to both modules
      expect(flows[0].definitionSteps.some((s) => s.toModuleId === 2)).toBe(true);
      expect(flows[0].definitionSteps.some((s) => s.toModuleId === 3)).toBe(true);
    });

    it('mutation action still respects traceFromDefinition (regression guard)', () => {
      // Same topology as above, but actionType: 'create'
      // traceFromDefinition: 'useSales' should narrow trace to only the hook path
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [11, 12]); // Page calls Component and Hook
      callGraph.set(11, []);
      callGraph.set(12, []);

      const modules = [
        { id: 1, fullPath: 'project.pages', members: [{ definitionId: 10, name: 'SalesPage' }] },
        { id: 2, fullPath: 'project.components', members: [{ definitionId: 11, name: 'SaleForm' }] },
        { id: 3, fullPath: 'project.hooks', members: [{ definitionId: 12, name: 'useSales' }] },
      ];

      const interactions = [
        makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 }),
        makeInteraction({ id: 101, fromModuleId: 1, toModuleId: 3 }),
      ];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.pages',
          memberDefinitions: [
            makeMember({
              id: 10,
              name: 'SalesPage',
              actionType: 'create',
              targetEntity: 'sale',
              stakeholder: 'user',
              traceFromDefinition: 'useSales', // Narrow to hook only
            }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      // Mutation should narrow: only hook path, NOT the component path
      expect(flows[0].interactionIds).not.toContain(100); // Should NOT include Page → SaleForm
      // The initial step (Page → useSales) should be included
      expect(flows[0].definitionSteps.some((s) => s.toDefinitionId === 12)).toBe(true);
      // SaleForm (module 2) should NOT appear
      expect(flows[0].definitionSteps.some((s) => s.toModuleId === 2)).toBe(false);
    });

    it('view action with null traceFromDefinition traces from the page definition', () => {
      const callGraph = new Map<number, number[]>();
      callGraph.set(10, [11, 20]); // Page calls hook (same module) and backend

      const modules = [
        {
          id: 1,
          fullPath: 'project.pages',
          members: [
            { definitionId: 10, name: 'VehiclesPage' },
            { definitionId: 11, name: 'useVehicleList' },
          ],
        },
        { id: 2, fullPath: 'project.backend', members: [{ definitionId: 20, name: 'listVehicles' }] },
      ];

      const interactions = [makeInteraction({ id: 100, fromModuleId: 1, toModuleId: 2 })];

      const ctx = buildFlowTracingContext(callGraph, modules, interactions);
      const tracer = new FlowTracer(ctx);

      const entryPoints = [
        makeEntryPoint({
          moduleId: 1,
          modulePath: 'project.pages',
          memberDefinitions: [
            makeMember({
              id: 10,
              name: 'VehiclesPage',
              actionType: 'view',
              targetEntity: 'vehicle',
              stakeholder: 'user',
            }),
          ],
        }),
      ];

      const flows = tracer.traceFlowsFromEntryPoints(entryPoints, []);
      expect(flows).toHaveLength(1);
      expect(flows[0].actionType).toBe('view');
      expect(flows[0].interactionIds).toContain(100);
    });
  });
});
