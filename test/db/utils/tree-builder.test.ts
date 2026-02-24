import { describe, expect, it } from 'vitest';
import { type TreeNode, buildSingleRootTree, buildTree } from '../../../src/db/utils/tree-builder.js';

describe('tree-builder', () => {
  interface TestNode extends TreeNode {
    name: string;
  }

  interface TestTreeNode extends TestNode {
    children: TestTreeNode[];
  }

  const createTestNode = (node: TestNode): TestTreeNode => ({
    ...node,
    children: [],
  });

  describe('buildTree', () => {
    it('builds a tree with a single root', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'child1' },
        { id: 3, parentId: 1, name: 'child2' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('root');
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].name).toBe('child1');
      expect(result[0].children[1].name).toBe('child2');
    });

    it('builds a tree with multiple roots', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root1' },
        { id: 2, parentId: null, name: 'root2' },
        { id: 3, parentId: 1, name: 'child1' },
        { id: 4, parentId: 2, name: 'child2' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('root1');
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].name).toBe('child1');
      expect(result[1].name).toBe('root2');
      expect(result[1].children).toHaveLength(1);
      expect(result[1].children[0].name).toBe('child2');
    });

    it('handles deep nesting', () => {
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

    it('handles empty input', () => {
      const nodes: TestNode[] = [];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(0);
    });

    it('handles orphan nodes (parentId points to non-existent node)', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 999, name: 'orphan' }, // Parent doesn't exist
        { id: 3, parentId: 1, name: 'validChild' },
      ];

      const result = buildTree(nodes, createTestNode);

      // The root should have only the valid child, orphan is skipped
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('root');
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].name).toBe('validChild');
    });

    it('handles siblings correctly', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'sibling1' },
        { id: 3, parentId: 1, name: 'sibling2' },
        { id: 4, parentId: 1, name: 'sibling3' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(1);
      expect(result[0].children).toHaveLength(3);
      expect(result[0].children.map((c) => c.name)).toEqual(['sibling1', 'sibling2', 'sibling3']);
    });

    it('builds complex tree with mixed levels', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'branch1' },
        { id: 3, parentId: 1, name: 'branch2' },
        { id: 4, parentId: 2, name: 'branch1-child1' },
        { id: 5, parentId: 2, name: 'branch1-child2' },
        { id: 6, parentId: 3, name: 'branch2-child1' },
        { id: 7, parentId: 4, name: 'branch1-child1-grandchild' },
      ];

      const result = buildTree(nodes, createTestNode);

      expect(result).toHaveLength(1);
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].children).toHaveLength(2);
      expect(result[0].children[1].children).toHaveLength(1);
      expect(result[0].children[0].children[0].children).toHaveLength(1);
    });
  });

  describe('buildSingleRootTree', () => {
    it('returns the single root node', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'child' },
      ];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('root');
      expect(result?.children).toHaveLength(1);
    });

    it('returns null when there are no nodes', () => {
      const nodes: TestNode[] = [];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).toBeNull();
    });

    it('returns the first root when multiple roots exist', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root1' },
        { id: 2, parentId: null, name: 'root2' },
      ];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('root1');
    });

    it('handles deeply nested tree', () => {
      const nodes: TestNode[] = [
        { id: 1, parentId: null, name: 'root' },
        { id: 2, parentId: 1, name: 'level1' },
        { id: 3, parentId: 2, name: 'level2' },
        { id: 4, parentId: 3, name: 'level3' },
        { id: 5, parentId: 4, name: 'level4' },
      ];

      const result = buildSingleRootTree(nodes, createTestNode);

      expect(result).not.toBeNull();
      expect(result?.children[0].children[0].children[0].children).toHaveLength(1);
      expect(result?.children[0].children[0].children[0].children[0].name).toBe('level4');
    });
  });
});
