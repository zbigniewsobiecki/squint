import { describe, expect, it } from 'vitest';
import { EntryPointDetector } from '../../../src/commands/llm/flows/entry-point-detector.js';
import type { ModuleCandidate } from '../../../src/commands/llm/flows/types.js';

/**
 * Tests for the pure/heuristic parts of EntryPointDetector.
 * Private methods are accessed via `(instance as any)` since they contain
 * testable pure logic (CSV parsing, heuristic inference).
 */

function createDetector() {
  const mockDb = {} as any;
  const mockCommand = { log: () => {}, warn: () => {} } as any;
  return new EntryPointDetector(mockDb, mockCommand, false, false);
}

describe('entry-point-detector heuristics', () => {
  describe('inferMemberActionType', () => {
    const detector = createDetector();
    const infer = (name: string, path: string) => (detector as any).inferMemberActionType(name, path);

    it('detects create actions', () => {
      expect(infer('createCustomer', 'project.sales').actionType).toBe('create');
      expect(infer('addItem', 'project.cart').actionType).toBe('create');
      expect(infer('insertRecord', 'project.db').actionType).toBe('create');
      expect(infer('newUser', 'project.users').actionType).toBe('create');
    });

    it('detects update actions', () => {
      expect(infer('updateProfile', 'project.users').actionType).toBe('update');
      expect(infer('editCustomer', 'project.sales').actionType).toBe('update');
      expect(infer('modifySettings', 'project.config').actionType).toBe('update');
      expect(infer('saveForm', 'project.forms').actionType).toBe('update');
    });

    it('detects delete actions', () => {
      expect(infer('deleteCustomer', 'project.sales').actionType).toBe('delete');
      expect(infer('removeItem', 'project.cart').actionType).toBe('delete');
    });

    it('detects view actions', () => {
      expect(infer('listCustomers', 'project.sales').actionType).toBe('view');
      expect(infer('viewDetails', 'project.sales').actionType).toBe('view');
      expect(infer('getUser', 'project.users').actionType).toBe('view');
      expect(infer('showDashboard', 'project.admin').actionType).toBe('view');
    });

    it('detects process actions', () => {
      expect(infer('loginUser', 'project.auth').actionType).toBe('process');
      expect(infer('logoutHandler', 'project.auth').actionType).toBe('process');
      expect(infer('syncData', 'project.sync').actionType).toBe('process');
      expect(infer('processPayment', 'project.payments').actionType).toBe('process');
    });

    it('returns null for unrecognized actions', () => {
      expect(infer('doSomething', 'project.misc').actionType).toBeNull();
    });

    it('returns null targetEntity (entity classification deferred to LLM)', () => {
      expect(infer('createCustomer', 'project.sales').targetEntity).toBeNull();
      expect(infer('updateVehicle', 'project.inventory').targetEntity).toBeNull();
      expect(infer('deleteOrder', 'project.orders').targetEntity).toBeNull();
      expect(infer('handleSubmit', 'project.customer').targetEntity).toBeNull();
      expect(infer('handleClick', 'project.widgets').targetEntity).toBeNull();
    });

    it('excludes generic path segments from target entity', () => {
      const result = infer('handleClick', 'project.screen');
      expect(result.targetEntity).toBeNull();
    });
  });

  describe('isLikelyEntryPointModuleHeuristic', () => {
    const detector = createDetector();
    const isEntryPoint = (candidate: ModuleCandidate) => (detector as any).isLikelyEntryPointModuleHeuristic(candidate);

    function makeCandidate(overrides: Partial<ModuleCandidate> & { fullPath: string }): ModuleCandidate {
      return {
        id: 1,
        name: 'Test',
        description: null,
        depth: 1,
        memberCount: 1,
        members: [{ definitionId: 1, name: 'test', kind: 'function' }],
        ...overrides,
      };
    }

    it('returns true for page/screen/view modules', () => {
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.pages.home' }))).toBe(true);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.screens.login' }))).toBe(true);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.views.dashboard' }))).toBe(true);
    });

    it('returns true for route/api/controller modules', () => {
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.routes.auth' }))).toBe(true);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.api.users' }))).toBe(true);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.controllers.user' }))).toBe(true);
    });

    it('returns true for handler/command/cli modules', () => {
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.handlers.auth' }))).toBe(true);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.commands.deploy' }))).toBe(true);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.cli.migrate' }))).toBe(true);
    });

    it('returns false for utility/service modules', () => {
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.utils.helpers' }))).toBe(false);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.services.auth' }))).toBe(false);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.lib.database' }))).toBe(false);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.shared.config' }))).toBe(false);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.core.engine' }))).toBe(false);
      expect(isEntryPoint(makeCandidate({ fullPath: 'project.repository.users' }))).toBe(false);
    });

    it('returns true when members have handler-like names', () => {
      const candidate = makeCandidate({
        fullPath: 'project.features.checkout',
        members: [{ definitionId: 1, name: 'handleSubmit', kind: 'function' }],
      });
      expect(isEntryPoint(candidate)).toBe(true);
    });

    it('returns false for generic modules without handler-like names', () => {
      const candidate = makeCandidate({
        fullPath: 'project.features.checkout',
        members: [{ definitionId: 1, name: 'calculate', kind: 'function' }],
      });
      expect(isEntryPoint(candidate)).toBe(false);
    });
  });

  describe('parseMemberClassificationCSV', () => {
    const detector = createDetector();
    const parseCSV = (response: string, candidates: ModuleCandidate[]) =>
      (detector as any).parseMemberClassificationCSV(response, candidates);

    it('parses well-formed CSV response', () => {
      const response = `\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,reason
1,CustomerList,true,view,customer,"Displays customer list"
1,CreateCustomer,true,create,customer,"Creates new customer"
\`\`\``;

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.customers',
          name: 'Customers',
          description: null,
          depth: 1,
          memberCount: 2,
          members: [
            { definitionId: 10, name: 'CustomerList', kind: 'function' },
            { definitionId: 11, name: 'CreateCustomer', kind: 'function' },
          ],
        },
      ];

      const result = parseCSV(response, candidates);

      expect(result).toHaveLength(2);
      expect(result[0].memberName).toBe('CustomerList');
      expect(result[0].isEntryPoint).toBe(true);
      expect(result[0].actionType).toBe('view');
      expect(result[0].targetEntity).toBe('customer');
      expect(result[1].memberName).toBe('CreateCustomer');
      expect(result[1].actionType).toBe('create');
    });

    it('adds heuristic fallback for members not in response', () => {
      const response = `\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,reason
1,CustomerList,true,view,customer,"Displays list"
\`\`\``;

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.screens.customers',
          name: 'Customers',
          description: null,
          depth: 1,
          memberCount: 2,
          members: [
            { definitionId: 10, name: 'CustomerList', kind: 'function' },
            { definitionId: 11, name: 'handleDelete', kind: 'function' },
          ],
        },
      ];

      const result = parseCSV(response, candidates);

      expect(result).toHaveLength(2);
      const fallback = result.find((r: any) => r.memberName === 'handleDelete');
      expect(fallback).toBeDefined();
      expect(fallback?.reason).toContain('heuristic');
    });

    it('skips lines with too few fields', () => {
      const response = `\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,reason
1,CustomerList,true
\`\`\``;

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.customers',
          name: 'Customers',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 10, name: 'CustomerList', kind: 'function' }],
        },
      ];

      const result = parseCSV(response, candidates);

      expect(result).toHaveLength(1);
      expect(result[0].reason).toContain('heuristic');
    });

    it('skips entries for unknown module IDs', () => {
      const response = `\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,reason
999,Unknown,true,view,entity,"Invalid module"
\`\`\``;

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.valid',
          name: 'Valid',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 10, name: 'test', kind: 'function' }],
        },
      ];

      const result = parseCSV(response, candidates);
      expect(result.every((r: any) => r.moduleId === 1)).toBe(true);
    });

    it('handles invalid action types gracefully', () => {
      const response = `\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,reason
1,Test,true,invalid_action,entity,"Bad action"
\`\`\``;

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.test',
          name: 'Test',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 10, name: 'Test', kind: 'function' }],
        },
      ];

      const result = parseCSV(response, candidates);
      const testResult = result.find((r: any) => r.memberName === 'Test');
      expect(testResult?.actionType).toBeNull();
    });

    it('handles response without code fences', () => {
      const response = `module_id,member_name,is_entry_point,action_type,target_entity,reason
1,Dashboard,true,view,dashboard,"Main view"`;

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.dashboard',
          name: 'Dashboard',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 10, name: 'Dashboard', kind: 'function' }],
        },
      ];

      const result = parseCSV(response, candidates);
      const dashboardResult = result.find((r: any) => r.memberName === 'Dashboard');
      expect(dashboardResult?.actionType).toBe('view');
    });

    it('parses 8-column CSV with trace_from column', () => {
      const response = `\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,stakeholder,trace_from,reason
42,ItemList,true,view,item,user,,"Main component displaying item list"
42,ItemList,true,create,item,user,useCreateItem,"Calls useCreateItem hook for new items"
42,ItemList,true,delete,item,user,useDeleteItem,"Calls useDeleteItem hook"
\`\`\``;

      const candidates: ModuleCandidate[] = [
        {
          id: 42,
          fullPath: 'project.items',
          name: 'Items',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 100, name: 'ItemList', kind: 'function' }],
        },
      ];

      const result = parseCSV(response, candidates);

      expect(result).toHaveLength(3);

      const viewRow = result.find((r: any) => r.actionType === 'view');
      expect(viewRow?.traceFromDefinition).toBeNull(); // empty trace_from for view
      expect(viewRow?.stakeholder).toBe('user');

      const createRow = result.find((r: any) => r.actionType === 'create');
      expect(createRow?.traceFromDefinition).toBe('useCreateItem');
      expect(createRow?.reason).toBe('Calls useCreateItem hook for new items');

      const deleteRow = result.find((r: any) => r.actionType === 'delete');
      expect(deleteRow?.traceFromDefinition).toBe('useDeleteItem');
    });

    it('parses 7-column CSV (backwards compatible, no trace_from)', () => {
      const response = `\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,stakeholder,reason
1,Dashboard,true,view,dashboard,user,"Main dashboard view"
\`\`\``;

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.dashboard',
          name: 'Dashboard',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 10, name: 'Dashboard', kind: 'function' }],
        },
      ];

      const result = parseCSV(response, candidates);
      const dashboardResult = result.find((r: any) => r.memberName === 'Dashboard');
      expect(dashboardResult?.stakeholder).toBe('user');
      expect(dashboardResult?.traceFromDefinition).toBeNull();
      expect(dashboardResult?.reason).toBe('Main dashboard view');
    });

    it('heuristic fallback sets traceFromDefinition to null', () => {
      const response = `\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,stakeholder,trace_from,reason
1,Listed,true,view,item,user,,"Listed view"
\`\`\``;

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.screens.items',
          name: 'Items',
          description: null,
          depth: 1,
          memberCount: 2,
          members: [
            { definitionId: 10, name: 'Listed', kind: 'function' },
            { definitionId: 11, name: 'handleCreate', kind: 'function' },
          ],
        },
      ];

      const result = parseCSV(response, candidates);
      const fallback = result.find((r: any) => r.memberName === 'handleCreate');
      expect(fallback).toBeDefined();
      expect(fallback?.traceFromDefinition).toBeNull();
    });
  });

  describe('contract handler supplement', () => {
    it('ensures contract handler is entry point member even when LLM says no', () => {
      // authController (defId 20) is a contract handler target but LLM classified it as not entry point
      const mockDb = {
        interactions: {
          getAllDefinitionLinks: () => [
            {
              interactionId: 1,
              fromDefinitionId: 10,
              toDefinitionId: 20,
              contractId: 1,
              toModuleId: 2,
              source: 'contract-matched',
            },
          ],
        },
      } as any;
      const mockCommand = { log: () => {}, warn: () => {} } as any;
      const detector = new EntryPointDetector(mockDb, mockCommand, false, false);

      // Simulate: LLM said authController module is NOT entry point
      const classifications = [
        { moduleId: 2, isEntryPoint: false, confidence: 'medium' as const, reason: 'intermediate node' },
      ];
      const candidates = [
        {
          id: 2,
          fullPath: 'backend.api.auth',
          name: 'Auth',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 20, name: 'authController', kind: 'class' }],
        },
      ];

      // Set empty member classifications (LLM said not entry point)
      (detector as any).memberClassifications = [
        {
          moduleId: 2,
          memberName: 'authController',
          isEntryPoint: false,
          actionType: null,
          targetEntity: null,
          stakeholder: null,
          traceFromDefinition: null,
          reason: 'intermediate',
        },
      ];

      const result = (detector as any).buildEntryPointModules(classifications, candidates, true);

      // Module should be forced to entry point
      expect(result).toHaveLength(1);
      expect(result[0].moduleId).toBe(2);
      // authController should be supplemented as entry point member
      const authMember = result[0].memberDefinitions.find((m: any) => m.name === 'authController');
      expect(authMember).toBeDefined();
      expect(authMember.stakeholder).toBe('external');
      expect(authMember.actionType).toBe('process'); // inferred from "auth" in name
    });

    it('does not duplicate already-classified members', () => {
      const mockDb = {
        interactions: {
          getAllDefinitionLinks: () => [
            {
              interactionId: 1,
              fromDefinitionId: 10,
              toDefinitionId: 20,
              contractId: 1,
              toModuleId: 2,
              source: 'contract-matched',
            },
          ],
        },
      } as any;
      const mockCommand = { log: () => {}, warn: () => {} } as any;
      const detector = new EntryPointDetector(mockDb, mockCommand, false, false);

      // LLM already classified VehiclesController as entry point
      const classifications = [
        { moduleId: 2, isEntryPoint: true, confidence: 'medium' as const, reason: 'controller' },
      ];
      const candidates = [
        {
          id: 2,
          fullPath: 'backend.api.vehicles',
          name: 'Vehicles',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 20, name: 'VehiclesController', kind: 'class' }],
        },
      ];

      (detector as any).memberClassifications = [
        {
          moduleId: 2,
          memberName: 'VehiclesController',
          isEntryPoint: true,
          actionType: 'view',
          targetEntity: 'vehicle',
          stakeholder: 'external',
          traceFromDefinition: null,
          reason: 'handles HTTP',
        },
      ];

      const result = (detector as any).buildEntryPointModules(classifications, candidates, true);

      expect(result).toHaveLength(1);
      // Should have exactly one member, not duplicated
      const vehicleMembers = result[0].memberDefinitions.filter((m: any) => m.name === 'VehiclesController');
      expect(vehicleMembers).toHaveLength(1);
      // Should keep the LLM-classified values, not overwrite with supplement
      expect(vehicleMembers[0].stakeholder).toBe('external');
      expect(vehicleMembers[0].actionType).toBe('view');
    });
  });

  describe('buildModuleContext', () => {
    it('annotates modules behind HTTP boundaries', () => {
      const detector = createDetector();
      const buildContext = (candidates: ModuleCandidate[], behindBoundaryModuleIds?: Set<number>) =>
        (detector as any).buildModuleContext(candidates, behindBoundaryModuleIds);

      const candidates: ModuleCandidate[] = [
        {
          id: 1,
          fullPath: 'project.pages.vehicles',
          name: 'VehiclesPage',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 10, name: 'VehiclesPage', kind: 'function' }],
        },
        {
          id: 2,
          fullPath: 'project.controllers.vehicles',
          name: 'VehiclesController',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 20, name: 'VehiclesController', kind: 'class' }],
        },
      ];

      const behindBoundary = new Set([2]); // Only controller is behind HTTP boundary
      const result = buildContext(candidates, behindBoundary);

      // Split into per-module sections to check each independently
      const sections = result.split('## Module ').filter(Boolean);
      const module1Section = sections.find((s: string) => s.startsWith('1:'));
      const module2Section = sections.find((s: string) => s.startsWith('2:'));

      // Frontend page should NOT have annotation
      expect(module1Section).not.toContain('⚠️');

      // Backend controller SHOULD have annotation
      expect(module2Section).toContain(
        '⚠️ This module is a BACKEND API endpoint (reached via HTTP from frontend modules)'
      );
    });

    it('does not annotate when no boundary set is provided', () => {
      const detector = createDetector();
      const buildContext = (candidates: ModuleCandidate[], behindBoundaryModuleIds?: Set<number>) =>
        (detector as any).buildModuleContext(candidates, behindBoundaryModuleIds);

      const candidates: ModuleCandidate[] = [
        {
          id: 2,
          fullPath: 'project.controllers.vehicles',
          name: 'VehiclesController',
          description: null,
          depth: 1,
          memberCount: 1,
          members: [{ definitionId: 20, name: 'VehiclesController', kind: 'class' }],
        },
      ];

      const result = buildContext(candidates); // No boundary set
      expect(result).not.toContain('⚠️');
    });
  });
});
