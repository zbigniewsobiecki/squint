import { describe, expect, it } from 'vitest';
import type { ModuleTreeNode } from '../d3/module-dag';
import type { DagFlowStep } from '../types/api';
import {
  buildSelectiveAncestorMap,
  buildVisibleToExpandedParent,
  getRemappedLabel,
  getSelectiveVisibleModules,
  remapSteps,
} from './flows-dag';
import type { RemappedStep } from './flows-dag';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ModuleTreeNode for testing (no _value needed) */
function node(
  id: number,
  name: string,
  parentId: number | null,
  depth: number,
  children: ModuleTreeNode[] = []
): ModuleTreeNode {
  return {
    id,
    parentId,
    name,
    fullPath: name,
    description: null,
    depth,
    colorIndex: 0,
    memberCount: 0,
    children,
  };
}

/**
 * Build a sample tree:
 *
 *   root (0)
 *   ├── Frontend (1, depth 1)
 *   │   ├── LoginPage (4, depth 2)
 *   │   └── Dashboard (5, depth 2)
 *   ├── Backend (2, depth 1)
 *   │   ├── AuthService (6, depth 2)
 *   │   │   └── TokenValidator (8, depth 3)
 *   │   └── UserService (7, depth 2)
 *   └── Database (3, depth 1)
 */
function buildTestTree(): ModuleTreeNode {
  const tokenValidator = node(8, 'TokenValidator', 6, 3);
  const authService = node(6, 'AuthService', 2, 2, [tokenValidator]);
  const userService = node(7, 'UserService', 2, 2);
  const loginPage = node(4, 'LoginPage', 1, 2);
  const dashboard = node(5, 'Dashboard', 1, 2);

  const frontend = node(1, 'Frontend', 0, 1, [loginPage, dashboard]);
  const backend = node(2, 'Backend', 0, 1, [authService, userService]);
  const database = node(3, 'Database', 0, 1);

  return node(0, 'root', null, 0, [frontend, backend, database]);
}

function buildNodeIndex(root: ModuleTreeNode): Map<number, ModuleTreeNode> {
  const map = new Map<number, ModuleTreeNode>();
  function walk(n: ModuleTreeNode) {
    map.set(n.id, n);
    for (const c of n.children) walk(c);
  }
  walk(root);
  return map;
}

function step(fromModuleId: number, toModuleId: number, semantic: string | null = null): DagFlowStep {
  return {
    interactionId: null,
    fromModuleId,
    toModuleId,
    semantic,
    fromDefName: null,
    toDefName: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getSelectiveVisibleModules', () => {
  it('returns depth-1 modules when nothing is expanded', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set());

    const ids = visible.map((m) => m.id);
    expect(ids).toEqual([1, 2, 3]); // Frontend, Backend, Database
  });

  it('expands a single module into its children', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set([2])); // expand Backend

    const ids = visible.map((m) => m.id);
    // Frontend (collapsed), AuthService, UserService, Database (collapsed)
    expect(ids).toEqual([1, 6, 7, 3]);
  });

  it('expands multiple modules', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set([1, 2]));

    const ids = visible.map((m) => m.id);
    // LoginPage, Dashboard, AuthService, UserService, Database
    expect(ids).toEqual([4, 5, 6, 7, 3]);
  });

  it('deeply expands nested modules', () => {
    const root = buildTestTree();
    // Expand Backend and AuthService
    const visible = getSelectiveVisibleModules(root, new Set([2, 6]));

    const ids = visible.map((m) => m.id);
    // Frontend, TokenValidator (child of AuthService), UserService, Database
    expect(ids).toEqual([1, 8, 7, 3]);
  });

  it('expanding a leaf module has no effect (no children)', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set([3])); // Database has no children

    const ids = visible.map((m) => m.id);
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe('buildSelectiveAncestorMap', () => {
  it('maps each module and its descendants to the visible module', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set()); // all collapsed
    const map = buildSelectiveAncestorMap(visible);

    // Frontend (1) owns: LoginPage (4), Dashboard (5)
    expect(map.get(1)).toBe(1);
    expect(map.get(4)).toBe(1);
    expect(map.get(5)).toBe(1);

    // Backend (2) owns: AuthService (6), UserService (7), TokenValidator (8)
    expect(map.get(2)).toBe(2);
    expect(map.get(6)).toBe(2);
    expect(map.get(7)).toBe(2);
    expect(map.get(8)).toBe(2);

    // Database (3) is a leaf
    expect(map.get(3)).toBe(3);
  });

  it('maps correctly when Backend is expanded', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set([2]));
    const map = buildSelectiveAncestorMap(visible);

    // Frontend still collapsed: children map to 1
    expect(map.get(4)).toBe(1);
    expect(map.get(5)).toBe(1);

    // AuthService (6) is now visible: TokenValidator (8) maps to 6
    expect(map.get(6)).toBe(6);
    expect(map.get(8)).toBe(6);

    // UserService (7) is visible as itself
    expect(map.get(7)).toBe(7);
  });
});

describe('remapSteps', () => {
  it('preserves steps when all modules are visible', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set([1, 2]));
    const ancestorMap = buildSelectiveAncestorMap(visible);

    const steps: DagFlowStep[] = [
      step(4, 6, 'login request'), // LoginPage -> AuthService
      step(6, 7, 'fetch user'), // AuthService -> UserService
    ];

    const remapped = remapSteps(steps, ancestorMap);
    expect(remapped).toHaveLength(2);
    expect(remapped[0].fromVisibleId).toBe(4); // LoginPage
    expect(remapped[0].toVisibleId).toBe(6); // AuthService
    expect(remapped[0].labels).toEqual(['login request']);
    expect(remapped[1].fromVisibleId).toBe(6);
    expect(remapped[1].toVisibleId).toBe(7);
  });

  it('merges steps that map to the same visible pair', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set()); // all collapsed
    const ancestorMap = buildSelectiveAncestorMap(visible);

    // Both steps are Frontend (children of 1) -> Backend (children of 2)
    const steps: DagFlowStep[] = [
      step(4, 6, 'login'), // LoginPage -> AuthService => Frontend -> Backend
      step(5, 7, 'dashboard'), // Dashboard -> UserService => Frontend -> Backend
    ];

    const remapped = remapSteps(steps, ancestorMap);
    expect(remapped).toHaveLength(1); // merged into one
    expect(remapped[0].fromVisibleId).toBe(1); // Frontend
    expect(remapped[0].toVisibleId).toBe(2); // Backend
    expect(remapped[0].originalIndices).toEqual([0, 1]);
    expect(remapped[0].labels).toEqual(['login', 'dashboard']);
  });

  it('creates self-calls when both endpoints map to same module', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set());
    const ancestorMap = buildSelectiveAncestorMap(visible);

    // AuthService -> UserService both inside Backend
    const steps: DagFlowStep[] = [step(6, 7, 'internal call')];

    const remapped = remapSteps(steps, ancestorMap);
    expect(remapped).toHaveLength(1);
    expect(remapped[0].fromVisibleId).toBe(2);
    expect(remapped[0].toVisibleId).toBe(2);
  });

  it('self-calls unfold when parent is expanded', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set([2])); // expand Backend
    const ancestorMap = buildSelectiveAncestorMap(visible);

    const steps: DagFlowStep[] = [
      step(6, 7, 'internal call'), // AuthService -> UserService
    ];

    const remapped = remapSteps(steps, ancestorMap);
    expect(remapped).toHaveLength(1);
    expect(remapped[0].fromVisibleId).toBe(6); // AuthService
    expect(remapped[0].toVisibleId).toBe(7); // UserService
  });

  it('maintains order by first original index', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set([1, 2]));
    const ancestorMap = buildSelectiveAncestorMap(visible);

    const steps: DagFlowStep[] = [
      step(4, 6, 'step 1'), // LoginPage -> AuthService
      step(6, 3, 'step 2'), // AuthService -> Database
      step(4, 7, 'step 3'), // LoginPage -> UserService
    ];

    const remapped = remapSteps(steps, ancestorMap);
    expect(remapped).toHaveLength(3);
    expect(remapped[0].labels[0]).toBe('step 1');
    expect(remapped[1].labels[0]).toBe('step 2');
    expect(remapped[2].labels[0]).toBe('step 3');
  });

  it('skips steps with unknown module IDs', () => {
    const ancestorMap = new Map<number, number>();
    ancestorMap.set(1, 1);
    // Module 999 not in ancestor map

    const steps: DagFlowStep[] = [step(1, 999, 'unknown target')];

    const remapped = remapSteps(steps, ancestorMap);
    expect(remapped).toHaveLength(0);
  });

  it('uses fallback label when semantic and toDefName are null', () => {
    const ancestorMap = new Map<number, number>([
      [1, 1],
      [2, 2],
    ]);

    const steps: DagFlowStep[] = [
      { interactionId: null, fromModuleId: 1, toModuleId: 2, semantic: null, fromDefName: null, toDefName: null },
    ];

    const remapped = remapSteps(steps, ancestorMap);
    expect(remapped[0].labels[0]).toBe('Step 1');
  });
});

describe('getRemappedLabel', () => {
  it('returns single label as-is', () => {
    const rs: RemappedStep = {
      fromVisibleId: 1,
      toVisibleId: 2,
      originalIndices: [0],
      labels: ['login request'],
    };
    expect(getRemappedLabel(rs)).toBe('login request');
  });

  it('returns first label with count for multiple steps', () => {
    const rs: RemappedStep = {
      fromVisibleId: 1,
      toVisibleId: 2,
      originalIndices: [0, 1],
      labels: ['login', 'signup'],
    };
    expect(getRemappedLabel(rs)).toBe('login (+1 more)');
  });

  it('shows correct count for many merged steps', () => {
    const rs: RemappedStep = {
      fromVisibleId: 1,
      toVisibleId: 2,
      originalIndices: [0, 1, 2, 3],
      labels: ['a', 'b', 'c', 'd'],
    };
    expect(getRemappedLabel(rs)).toBe('a (+3 more)');
  });
});

describe('buildVisibleToExpandedParent', () => {
  it('returns empty map when nothing is expanded', () => {
    const root = buildTestTree();
    const visible = getSelectiveVisibleModules(root, new Set());
    const nodeIndex = buildNodeIndex(root);
    const result = buildVisibleToExpandedParent(visible, new Set(), nodeIndex);

    expect(result.size).toBe(0);
  });

  it('maps children to their expanded parent', () => {
    const root = buildTestTree();
    const expanded = new Set([2]); // Backend expanded
    const visible = getSelectiveVisibleModules(root, expanded);
    const nodeIndex = buildNodeIndex(root);
    const result = buildVisibleToExpandedParent(visible, expanded, nodeIndex);

    // AuthService and UserService should map to Backend (2)
    expect(result.get(6)).toBe(2);
    expect(result.get(7)).toBe(2);

    // Frontend and Database are not children of an expanded node
    expect(result.has(1)).toBe(false);
    expect(result.has(3)).toBe(false);
  });

  it('maps deeply nested children to nearest expanded ancestor', () => {
    const root = buildTestTree();
    const expanded = new Set([2, 6]); // Backend + AuthService expanded
    const visible = getSelectiveVisibleModules(root, expanded);
    const nodeIndex = buildNodeIndex(root);
    const result = buildVisibleToExpandedParent(visible, expanded, nodeIndex);

    // TokenValidator -> AuthService (nearest expanded ancestor)
    expect(result.get(8)).toBe(6);
    // UserService -> Backend
    expect(result.get(7)).toBe(2);
  });
});
