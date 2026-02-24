import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../../../src/db/utils/tree-builder.js';
import { buildSingleRootTree, buildTree } from '../../../src/db/utils/tree-builder.js';

interface TestNode extends TreeNode {
  id: number;
  parentId: number | null;
  name: string;
}

interface TestTreeNode extends TestNode {
  children: TestTreeNode[];
}

describe('tree-builder', () => {
  function createTestNode(node: TestNode): TestTreeNode {
    return {
      ...node,
      children: [],
    };
  }

  describe('buildTree', () => {
    it('builds basic tree with single root', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'child1' },
        { id: 3, parentId: 1, name: 'child2' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
      expect(result[0].name).toBe('root');
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].name).toBe('child1');
      expect(result[0].children[1].name).toBe('child2');
    });

    it('builds tree with multiple roots', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root1' },
        { id: 2, parentId: null, name: 'root2' },
        { id: 3, parentId: 1, name: 'child1' },
        { id: 4, parentId: 2, name: 'child2' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('root1');
      expect(result[1].name).toBe('root2');
      expect(result[0].children).toHaveLength(1);
      expect(result[1].children).toHaveLength(1);
      expect(result[0].children[0].name).toBe('child1');
      expect(result[1].children[0].name).toBe('child2');
    });

    it('builds tree with multiple levels', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'level1' },
        { id: 3, parentId: 2, name: 'level2' },
        { id: 4, parentId: 3, name: 'level3' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('root');
      expect(result[0].children[0].name).toBe('level1');
      expect(result[0].children[0].children[0].name).toBe('level2');
      expect(result[0].children[0].children[0].children[0].name).toBe('level3');
    });

    it('handles empty node list', () => {
      const nodes: TestNode[] = [];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(0);
    });

    it('handles single node', () => {
      const nodes: TestNode[] = [{ id: 1, parentId: null, name: 'root' }];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('root');
      expect(result[0].children).toHaveLength(0);
    });

    it('handles orphan nodes with missing parent', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 999, name: 'orphan' }, // parent 999 doesn't exist
      ];

      const result = buildTree(nodes, createTestNode);

      // Orphan should not be attached anywhere
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('root');
      expect(result[0].children).toHaveLength(0);
    });

    it('builds tree with siblings at different levels', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'child1' },
        { id: 3, parentId: 1, name: 'child2' },
        { id: 4, parentId: 2, name: 'grandchild1' },
        { id: 5, parentId: 2, name: 'grandchild2' },
        { id: 6, parentId: 3, name: 'grandchild3' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(1);
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].children).toHaveLength(2);
      expect(result[0].children[1].children).toHaveLength(1);
    });

    it('preserves node properties in tree', () => {
      const nodes: TestNode[] = [
        { id: 42, parentId: null, name: 'root' },
        { id: 99, parentId: 42, name: 'child' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result[0].id).toBe(42);
      expect(result[0].parentId).toBeNull();
      expect(result[0].name).toBe('root');
      expect(result[0].children[0].id).toBe(99);
      expect(result[0].children[0].parentId).toBe(42);
      expect(result[0].children[0].name).toBe('child');
    });
  });

  describe('buildSingleRootTree', () => {
    it('returns first root when multiple roots exist', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root1' },
        { id: 2, parentId: null, name: 'root2' },
        { id: 3, parentId: 1, name: 'child1' },
      ];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).not.toBeNull();
      expect(result!.name).toBe('root1');
      expect(result!.children).toHaveLength(1);
    });

    it('returns null for empty list', () => {
      const nodes: TestNode[] = [];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).toBeNull();
    });

    it('returns single root with its tree', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'child1' },
        { id: 3, parentId: 1, name: 'child2' },
        { id: 4, parentId: 2, name: 'grandchild' },
      ];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).not.toBeNull();
      expect(result!.name).toBe('root');
      expect(result!.children).toHaveLength(2);
      expect(result!.children[0].children).toHaveLength(1);
    });

    it('returns null when no roots exist (only orphans)', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: 999, name: 'orphan1' },
        { id: 2, parentId: 998, name: 'orphan2' },
      ];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).toBeNull();
    });

    it('handles single node', () => {
      const nodes: TestNode[] = [{ id: 1, parentId: null, name: 'root' }];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).not.toBeNull();
      expect(result!.name).toBe('root');
      expect(result!.children).toHaveLength(0);
    });
  });
});
