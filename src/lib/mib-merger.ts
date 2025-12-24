/**
 * Utility functions for working with MIB trees
 */

import type { MibNode } from '../types/mib';

/**
 * Search for a node in the merged tree
 * @param tree Merged tree
 * @param oid OID to search for
 * @returns Found node or null
 */
export function findNodeByOid(tree: MibNode[], oid: string): MibNode | null {
  for (const node of tree) {
    if (node.oid === oid) return node;

    if (node.children.length > 0) {
      const found = findNodeByOid(node.children, oid);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Get statistics for the merged tree
 * @param tree Merged tree
 * @returns Statistics
 */
export function getTreeStats(tree: MibNode[]): {
  totalNodes: number;
  rootNodes: number;
  maxDepth: number;
} {
  let totalNodes = 0;
  let maxDepth = 0;

  function traverse(nodes: MibNode[], depth: number) {
    nodes.forEach(node => {
      totalNodes++;
      maxDepth = Math.max(maxDepth, depth);

      if (node.children.length > 0) {
        traverse(node.children, depth + 1);
      }
    });
  }

  traverse(tree, 0);

  return {
    totalNodes,
    rootNodes: tree.length,
    maxDepth,
  };
}
