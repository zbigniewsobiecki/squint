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

    it('infers target entity from name', () => {
      expect(infer('createCustomer', 'project.sales').targetEntity).toBe('customer');
      expect(infer('updateVehicle', 'project.inventory').targetEntity).toBe('vehicle');
      expect(infer('deleteOrder', 'project.orders').targetEntity).toBe('order');
    });

    it('infers target entity from module path', () => {
      expect(infer('handleSubmit', 'project.customer').targetEntity).toBe('customer');
      expect(infer('handleSubmit', 'project.vehicle').targetEntity).toBe('vehicle');
    });

    it('falls back to last path segment for target entity', () => {
      const result = infer('handleClick', 'project.widgets');
      expect(result.targetEntity).toBe('widgets');
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
  });
});
