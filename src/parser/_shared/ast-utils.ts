import type { SyntaxNode } from 'tree-sitter';

/**
 * Count the number of non-punctuation arguments in an arguments node.
 * Skips `(`, `)`, and `,` tokens when counting.
 */
export function countArguments(argsNode: SyntaxNode): number {
  let count = 0;
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child) {
      const type = child.type;
      if (type !== '(' && type !== ')' && type !== ',') {
        count++;
      }
    }
  }
  return count;
}
