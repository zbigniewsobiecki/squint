import { describe, it, expect } from 'vitest';
import { classifyRelationship, buildFileHierarchy, buildRelationshipHierarchy } from './hierarchy';
import type { SymbolNode, SymbolEdge } from '../types/api';

describe('hierarchy', () => {
  describe('classifyRelationship', () => {
    it('classifies extends relationships', () => {
      expect(classifyRelationship('extends')).toBe('extends');
      expect(classifyRelationship('EXTENDS')).toBe('extends');
      expect(classifyRelationship('class extends base')).toBe('extends');
    });

    it('classifies implements relationships', () => {
      expect(classifyRelationship('implements')).toBe('implements');
      expect(classifyRelationship('IMPLEMENTS')).toBe('implements');
      expect(classifyRelationship('class implements interface')).toBe('implements');
    });

    it('classifies calls relationships', () => {
      expect(classifyRelationship('calls')).toBe('calls');
      expect(classifyRelationship('CALLS')).toBe('calls');
      expect(classifyRelationship('function calls another')).toBe('calls');
    });

    it('classifies imports relationships', () => {
      expect(classifyRelationship('imports')).toBe('imports');
      expect(classifyRelationship('IMPORTS')).toBe('imports');
      expect(classifyRelationship('module imports from')).toBe('imports');
    });

    it('classifies uses relationships', () => {
      expect(classifyRelationship('uses')).toBe('uses');
      expect(classifyRelationship('USES')).toBe('uses');
      expect(classifyRelationship('function uses helper')).toBe('uses');
    });

    it('defaults to uses for unknown relationships', () => {
      expect(classifyRelationship('')).toBe('uses');
      expect(classifyRelationship('unknown')).toBe('uses');
      expect(classifyRelationship('related to')).toBe('uses');
    });

    it('handles null/undefined-like input', () => {
      expect(classifyRelationship(null as any)).toBe('uses');
      expect(classifyRelationship(undefined as any)).toBe('uses');
    });
  });

  describe('buildFileHierarchy', () => {
    it('returns root with empty children for empty nodes', () => {
      const result = buildFileHierarchy([]);

      expect(result.name).toBe('root');
      expect(result.isRoot).toBe(true);
      expect(result.children).toEqual([]);
    });

    it('creates directory structure from file paths', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'foo', kind: 'function', filePath: 'src/utils/helpers.ts', hasAnnotations: false, lines: 10 },
      ];

      const result = buildFileHierarchy(nodes);

      expect(result.name).toBe('root');
      expect(result.children).toHaveLength(1);

      const srcDir = result.children![0];
      expect(srcDir.name).toBe('src');
      expect(srcDir.isDirectory).toBe(true);

      const utilsDir = srcDir.children![0];
      expect(utilsDir.name).toBe('utils');
      expect(utilsDir.isDirectory).toBe(true);

      const file = utilsDir.children![0];
      expect(file.name).toBe('helpers.ts');
      expect(file.isFile).toBe(true);

      const symbol = file.children![0];
      expect(symbol.name).toBe('foo');
      expect(symbol.data?.id).toBe(1);
    });

    it('groups symbols under same file', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'foo', kind: 'function', filePath: 'src/utils.ts', hasAnnotations: false, lines: 10 },
        { id: 2, name: 'bar', kind: 'function', filePath: 'src/utils.ts', hasAnnotations: false, lines: 20 },
      ];

      const result = buildFileHierarchy(nodes);

      const srcDir = result.children![0];
      const file = srcDir.children![0];
      expect(file.children).toHaveLength(2);
      expect(file.children![0].name).toBe('foo');
      expect(file.children![1].name).toBe('bar');
    });

    it('creates separate branches for different paths', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'a', kind: 'function', filePath: 'src/a.ts', hasAnnotations: false, lines: 10 },
        { id: 2, name: 'b', kind: 'function', filePath: 'lib/b.ts', hasAnnotations: false, lines: 10 },
      ];

      const result = buildFileHierarchy(nodes);

      expect(result.children).toHaveLength(2);
      expect(result.children!.map(c => c.name).sort()).toEqual(['lib', 'src']);
    });

    it('sets value to lines (minimum 1)', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'foo', kind: 'function', filePath: 'test.ts', hasAnnotations: false, lines: 0 },
        { id: 2, name: 'bar', kind: 'function', filePath: 'test.ts', hasAnnotations: false, lines: 50 },
      ];

      const result = buildFileHierarchy(nodes);

      const file = result.children![0];
      expect(file.children![0].value).toBe(1);
      expect(file.children![1].value).toBe(50);
    });

    it('handles deeply nested paths', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'fn', kind: 'function', filePath: 'a/b/c/d/e/file.ts', hasAnnotations: false, lines: 10 },
      ];

      const result = buildFileHierarchy(nodes);

      let current = result.children![0];
      expect(current.name).toBe('a');
      expect(current.isDirectory).toBe(true);

      current = current.children![0];
      expect(current.name).toBe('b');

      current = current.children![0];
      expect(current.name).toBe('c');

      current = current.children![0];
      expect(current.name).toBe('d');

      current = current.children![0];
      expect(current.name).toBe('e');

      const file = current.children![0];
      expect(file.name).toBe('file.ts');
      expect(file.isFile).toBe(true);
    });

    it('assigns depth to directories and files', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'fn', kind: 'function', filePath: 'src/utils/helpers.ts', hasAnnotations: false, lines: 10 },
      ];

      const result = buildFileHierarchy(nodes);

      const srcDir = result.children![0];
      expect(srcDir.depth).toBe(1);

      const utilsDir = srcDir.children![0];
      expect(utilsDir.depth).toBe(2);

      const file = utilsDir.children![0];
      expect(file.depth).toBe(3);
    });
  });

  describe('buildRelationshipHierarchy', () => {
    const baseNodes: SymbolNode[] = [
      { id: 1, name: 'Base', kind: 'class', filePath: 'base.ts', hasAnnotations: false, lines: 50 },
      { id: 2, name: 'Child', kind: 'class', filePath: 'child.ts', hasAnnotations: false, lines: 30 },
      { id: 3, name: 'GrandChild', kind: 'class', filePath: 'grandchild.ts', hasAnnotations: false, lines: 20 },
      { id: 4, name: 'Other', kind: 'class', filePath: 'other.ts', hasAnnotations: false, lines: 10 },
    ];

    it('returns empty result message when no relationships of type exist', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'A', kind: 'class', filePath: 'a.ts', hasAnnotations: false, lines: 10 },
      ];
      const edges: SymbolEdge[] = [];

      const result = buildRelationshipHierarchy(nodes, edges, 'extends');

      expect(result.name).toBe('root');
      expect(result.isRoot).toBe(true);
      expect(result.children).toHaveLength(1);
      expect(result.children![0].name).toContain('No "extends" relationships found');
    });

    it('builds parent-child hierarchy for extends relationships', () => {
      const edges: SymbolEdge[] = [
        { source: 2, target: 1, semantic: 'extends' }, // Child extends Base
      ];

      const result = buildRelationshipHierarchy(baseNodes, edges, 'extends');

      expect(result.name).toBe('root');
      expect(result.children).toHaveLength(1);

      // Base is root of the tree (no parent)
      const baseNode = result.children![0];
      expect(baseNode.name).toBe('Base');
      expect(baseNode.data?.id).toBe(1);

      // Child is under Base
      expect(baseNode.children).toHaveLength(1);
      expect(baseNode.children![0].name).toBe('Child');
    });

    it('builds multi-level hierarchy', () => {
      const edges: SymbolEdge[] = [
        { source: 2, target: 1, semantic: 'extends' }, // Child extends Base
        { source: 3, target: 2, semantic: 'extends' }, // GrandChild extends Child
      ];

      const result = buildRelationshipHierarchy(baseNodes, edges, 'extends');

      const baseNode = result.children![0];
      expect(baseNode.name).toBe('Base');

      const childNode = baseNode.children![0];
      expect(childNode.name).toBe('Child');

      const grandChildNode = childNode.children![0];
      expect(grandChildNode.name).toBe('GrandChild');
    });

    it('filters edges by relationship type', () => {
      const edges: SymbolEdge[] = [
        { source: 2, target: 1, semantic: 'extends' },
        { source: 3, target: 1, semantic: 'calls' }, // Different relationship type
      ];

      const result = buildRelationshipHierarchy(baseNodes, edges, 'extends');

      const baseNode = result.children![0];
      expect(baseNode.children).toHaveLength(1);
      expect(baseNode.children![0].name).toBe('Child');
      // GrandChild not included because it's a 'calls' relationship
    });

    it('handles multiple roots', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'Base1', kind: 'class', filePath: 'a.ts', hasAnnotations: false, lines: 10 },
        { id: 2, name: 'Base2', kind: 'class', filePath: 'b.ts', hasAnnotations: false, lines: 10 },
        { id: 3, name: 'Child1', kind: 'class', filePath: 'c.ts', hasAnnotations: false, lines: 10 },
        { id: 4, name: 'Child2', kind: 'class', filePath: 'd.ts', hasAnnotations: false, lines: 10 },
      ];
      const edges: SymbolEdge[] = [
        { source: 3, target: 1, semantic: 'extends' }, // Child1 extends Base1
        { source: 4, target: 2, semantic: 'extends' }, // Child2 extends Base2
      ];

      const result = buildRelationshipHierarchy(nodes, edges, 'extends');

      expect(result.children).toHaveLength(2);
      const names = result.children!.map(c => c.name).sort();
      expect(names).toEqual(['Base1', 'Base2']);
    });

    it('prevents cycles', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'A', kind: 'class', filePath: 'a.ts', hasAnnotations: false, lines: 10 },
        { id: 2, name: 'B', kind: 'class', filePath: 'b.ts', hasAnnotations: false, lines: 10 },
      ];
      // Circular: A extends B, B extends A
      const edges: SymbolEdge[] = [
        { source: 1, target: 2, semantic: 'extends' },
        { source: 2, target: 1, semantic: 'extends' },
      ];

      // Should not throw or infinite loop
      const result = buildRelationshipHierarchy(nodes, edges, 'extends');

      expect(result.name).toBe('root');
      // At least one node should be in the tree
      expect(result.children!.length).toBeGreaterThan(0);
    });

    it('ignores edges with unknown node IDs', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'A', kind: 'class', filePath: 'a.ts', hasAnnotations: false, lines: 10 },
      ];
      const edges: SymbolEdge[] = [
        { source: 2, target: 1, semantic: 'extends' }, // source 2 doesn't exist - edge skipped
        { source: 1, target: 99, semantic: 'extends' }, // target 99 doesn't exist - edge skipped
      ];

      const result = buildRelationshipHierarchy(nodes, edges, 'extends');

      // Both edges are invalid, so node A appears as a root without children
      // (the code adds nodes to involvedNodes before checking validity)
      expect(result.name).toBe('root');
      expect(result.children).toHaveLength(1);
      expect(result.children![0].name).toBe('A');
      // A has no children since both edges were invalid
      expect(result.children![0].children).toBeUndefined();
    });

    it('sets value based on lines of code', () => {
      const edges: SymbolEdge[] = [
        { source: 2, target: 1, semantic: 'extends' },
      ];

      const result = buildRelationshipHierarchy(baseNodes, edges, 'extends');

      const baseNode = result.children![0];
      expect(baseNode.value).toBe(50);

      const childNode = baseNode.children![0];
      expect(childNode.value).toBe(30);
    });

    it('works with calls relationship type', () => {
      const nodes: SymbolNode[] = [
        { id: 1, name: 'main', kind: 'function', filePath: 'main.ts', hasAnnotations: false, lines: 10 },
        { id: 2, name: 'helper', kind: 'function', filePath: 'helper.ts', hasAnnotations: false, lines: 5 },
      ];
      const edges: SymbolEdge[] = [
        { source: 1, target: 2, semantic: 'calls' }, // main calls helper
      ];

      const result = buildRelationshipHierarchy(nodes, edges, 'calls');

      // helper is the root (things call it)
      const helperNode = result.children![0];
      expect(helperNode.name).toBe('helper');

      // main is child of helper (main depends on helper)
      expect(helperNode.children).toHaveLength(1);
      expect(helperNode.children![0].name).toBe('main');
    });
  });
});
