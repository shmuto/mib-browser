/**
 * Utility functions for OID (Object Identifier) operations
 */

import type { MibNode } from '../types/mib';

/**
 * Convert OID string to number array
 * @param oid OID string (e.g., "1.3.6.1.2.1.1")
 * @returns Number array (e.g., [1, 3, 6, 1, 2, 1, 1])
 */
export function parseOid(oid: string): number[] {
  return oid.split('.').filter(Boolean).map(Number);
}

/**
 * Convert number array to OID string
 * @param parts Number array
 * @returns OID string
 */
export function formatOid(parts: number[]): string {
  return parts.join('.');
}

/**
 * Compare OIDs (lexicographic order)
 * @param oid1 OID string 1
 * @param oid2 OID string 2
 * @returns Negative (oid1 < oid2), 0 (equal), Positive (oid1 > oid2)
 */
export function compareOids(oid1: string, oid2: string): number {
  const parts1 = parseOid(oid1);
  const parts2 = parseOid(oid2);

  const minLength = Math.min(parts1.length, parts2.length);

  for (let i = 0; i < minLength; i++) {
    if (parts1[i] !== parts2[i]) {
      return parts1[i] - parts2[i];
    }
  }

  return parts1.length - parts2.length;
}

/**
 * Sort OID array
 * @param oids Array of OID strings
 * @returns Sorted OID array
 */
export function sortOids(oids: string[]): string[] {
  return [...oids].sort(compareOids);
}

/**
 * Check if oid2 is a descendant of oid1
 * @param parentOid Parent OID
 * @param childOid Child OID candidate
 * @returns true if descendant
 */
export function isDescendant(parentOid: string, childOid: string): boolean {
  if (parentOid === childOid) return false;
  return childOid.startsWith(parentOid + '.');
}

/**
 * Check if oid2 is a direct child of oid1
 * @param parentOid Parent OID
 * @param childOid Child OID candidate
 * @returns true if direct child
 */
export function isDirectChild(parentOid: string, childOid: string): boolean {
  if (!isDescendant(parentOid, childOid)) return false;

  const parentParts = parseOid(parentOid);
  const childParts = parseOid(childOid);

  return childParts.length === parentParts.length + 1;
}

/**
 * Get parent OID
 * @param oid OID string
 * @returns Parent OID, or null if root
 */
export function getParentOid(oid: string): string | null {
  const parts = parseOid(oid);
  if (parts.length <= 1) return null;

  return formatOid(parts.slice(0, -1));
}

/**
 * Get OID depth
 * @param oid OID string
 * @returns Depth (root is 0)
 */
export function getOidDepth(oid: string): number {
  return parseOid(oid).length - 1;
}

/**
 * Get OID path (from root to current OID)
 * @param oid OID string
 * @returns Array of OID path
 */
export function getOidPath(oid: string): string[] {
  const parts = parseOid(oid);
  const path: string[] = [];

  for (let i = 1; i <= parts.length; i++) {
    path.push(formatOid(parts.slice(0, i)));
  }

  return path;
}

/**
 * Validate if OID is valid
 * @param oid OID string
 * @returns true if valid
 */
export function isValidOid(oid: string): boolean {
  if (!oid || typeof oid !== 'string') return false;

  const parts = oid.split('.');
  if (parts.length === 0) return false;

  return parts.every(part => {
    const num = Number(part);
    return !isNaN(num) && num >= 0 && Number.isInteger(num);
  });
}

/**
 * Get last number of OID
 * @param oid OID string
 * @returns Last number
 */
export function getLastOidNumber(oid: string): number {
  const parts = parseOid(oid);
  return parts[parts.length - 1];
}

/**
 * Get common ancestor OID of two OIDs
 * @param oid1 OID string 1
 * @param oid2 OID string 2
 * @returns Common ancestor OID
 */
export function getCommonAncestor(oid1: string, oid2: string): string | null {
  const parts1 = parseOid(oid1);
  const parts2 = parseOid(oid2);
  const common: number[] = [];

  const minLength = Math.min(parts1.length, parts2.length);
  for (let i = 0; i < minLength; i++) {
    if (parts1[i] === parts2[i]) {
      common.push(parts1[i]);
    } else {
      break;
    }
  }

  return common.length > 0 ? formatOid(common) : null;
}

/**
 * Format OID for human-readable display
 * @param oid OID string
 * @param name Object name (optional)
 * @returns Formatted string
 */
export function formatOidDisplay(oid: string, name?: string): string {
  if (name) {
    return `${name} (${oid})`;
  }
  return oid;
}

/**
 * Build a map of OID to node name from a tree
 * @param tree MIB node tree
 * @returns Map of OID to name
 */
export function buildOidNameMap(tree: MibNode[]): Map<string, string> {
  const map = new Map<string, string>();

  function traverse(nodes: MibNode[]) {
    for (const node of nodes) {
      map.set(node.oid, node.name);
      if (node.children.length > 0) {
        traverse(node.children);
      }
    }
  }

  traverse(tree);
  return map;
}

/**
 * Get OID name path (e.g., "iso.org.dod.internet.mgmt.mib-2.system.sysDescr")
 * @param oid OID string
 * @param oidNameMap Map of OID to name
 * @returns Name path string, or null if any OID in the path is not found
 */
export function getOidNamePath(oid: string, oidNameMap: Map<string, string>): string | null {
  const oidPath = getOidPath(oid);
  const namePath: string[] = [];

  for (const pathOid of oidPath) {
    const name = oidNameMap.get(pathOid);
    if (!name) {
      // If any OID in the path is not found, return null
      return null;
    }
    namePath.push(name);
  }

  return namePath.join('.');
}
