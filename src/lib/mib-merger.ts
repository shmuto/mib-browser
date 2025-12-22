/**
 * Utility for merging multiple MIB trees into one
 */

import type { MibNode, StoredMibData } from '../types/mib';
import { flattenTree, buildTree } from './mib-parser';
import type { FlatMibNode } from '../types/mib';

/**
 * Merge multiple MIB files into one unified tree
 * @param mibs Array of stored MIB data
 * @returns Merged tree
 */
export function mergeMibs(mibs: StoredMibData[]): MibNode[] {
  if (mibs.length === 0) return [];

  // If all MIBs have the same tree (already merged by rebuildAllTrees),
  // just return the first one's tree directly
  if (mibs.length > 0 && mibs[0].parsedData.length > 0) {
    // Check if this looks like an integrated tree (has root nodes like 'iso')
    const hasIsoRoot = mibs[0].parsedData.some(node => node.name === 'iso');
    if (hasIsoRoot) {
      console.log('[mergeMibs] Using pre-built integrated tree from storage');
      return mibs[0].parsedData;
    }
  }

  // Fallback: merge individual MIB trees (legacy support)
  console.log('[mergeMibs] Merging individual MIB trees');
  const allNodes: FlatMibNode[] = [];
  const nodeMap = new Map<string, FlatMibNode>();

  mibs.forEach((mib) => {
    const flatNodes = flattenTree(mib.parsedData);

    flatNodes.forEach(node => {
      // Check for duplicates (keep only one node per OID)
      if (!nodeMap.has(node.oid)) {
        const flatNode: FlatMibNode = {
          oid: node.oid,
          name: node.name,
          parent: node.parent,
          type: node.type,
          syntax: node.syntax,
          access: node.access,
          status: node.status,
          description: node.description,
          mibName: node.mibName || mib.mibName,
        };
        nodeMap.set(node.oid, flatNode);
        allNodes.push(flatNode);
      } else {
        // Merge information with existing node (fill in empty fields)
        const existing = nodeMap.get(node.oid)!;
        if (!existing.description && node.description) {
          existing.description = node.description;
        }
        if (!existing.syntax && node.syntax) {
          existing.syntax = node.syntax;
        }
        if (!existing.access && node.access) {
          existing.access = node.access;
        }
        if (!existing.status && node.status) {
          existing.status = node.status;
        }
        if (!existing.mibName && (node.mibName || mib.mibName)) {
          existing.mibName = node.mibName || mib.mibName;
        }
      }
    });
  });

  // Rebuild tree from merged flat node list
  return buildTree(allNodes);
}

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
