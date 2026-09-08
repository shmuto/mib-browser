/**
 * Utility functions for OID (Object Identifier) operations
 */

/**
 * Convert OID string to number array
 * @param oid OID string (e.g., "1.3.6.1.2.1.1")
 * @returns Number array (e.g., [1, 3, 6, 1, 2, 1, 1])
 */
function parseOid(oid: string): number[] {
  return oid.split('.').filter(Boolean).map(Number);
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
    path.push(parts.slice(0, i).join('.'));
  }

  return path;
}
