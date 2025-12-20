/**
 * OID（Object Identifier）操作のユーティリティ関数
 */

import type { MibNode } from '../types/mib';

/**
 * OID文字列を数値配列に変換
 * @param oid OID文字列（例: "1.3.6.1.2.1.1"）
 * @returns 数値配列（例: [1, 3, 6, 1, 2, 1, 1]）
 */
export function parseOid(oid: string): number[] {
  return oid.split('.').filter(Boolean).map(Number);
}

/**
 * 数値配列をOID文字列に変換
 * @param parts 数値配列
 * @returns OID文字列
 */
export function formatOid(parts: number[]): string {
  return parts.join('.');
}

/**
 * OIDを比較（辞書順）
 * @param oid1 OID文字列1
 * @param oid2 OID文字列2
 * @returns 負の数（oid1 < oid2）、0（等しい）、正の数（oid1 > oid2）
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
 * OID配列をソート
 * @param oids OID文字列の配列
 * @returns ソートされたOID配列
 */
export function sortOids(oids: string[]): string[] {
  return [...oids].sort(compareOids);
}

/**
 * oid2がoid1の子孫かどうかを判定
 * @param parentOid 親OID
 * @param childOid 子OID候補
 * @returns 子孫の場合true
 */
export function isDescendant(parentOid: string, childOid: string): boolean {
  if (parentOid === childOid) return false;
  return childOid.startsWith(parentOid + '.');
}

/**
 * oid2がoid1の直接の子かどうかを判定
 * @param parentOid 親OID
 * @param childOid 子OID候補
 * @returns 直接の子の場合true
 */
export function isDirectChild(parentOid: string, childOid: string): boolean {
  if (!isDescendant(parentOid, childOid)) return false;

  const parentParts = parseOid(parentOid);
  const childParts = parseOid(childOid);

  return childParts.length === parentParts.length + 1;
}

/**
 * OIDの親を取得
 * @param oid OID文字列
 * @returns 親OID、またはnull（ルートの場合）
 */
export function getParentOid(oid: string): string | null {
  const parts = parseOid(oid);
  if (parts.length <= 1) return null;

  return formatOid(parts.slice(0, -1));
}

/**
 * OIDの深さを取得
 * @param oid OID文字列
 * @returns 深さ（ルートは0）
 */
export function getOidDepth(oid: string): number {
  return parseOid(oid).length - 1;
}

/**
 * OIDのパスを取得（ルートから現在のOIDまで）
 * @param oid OID文字列
 * @returns OIDのパス配列
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
 * OIDが有効かどうかを検証
 * @param oid OID文字列
 * @returns 有効な場合true
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
 * OIDの最後の番号を取得
 * @param oid OID文字列
 * @returns 最後の番号
 */
export function getLastOidNumber(oid: string): number {
  const parts = parseOid(oid);
  return parts[parts.length - 1];
}

/**
 * 2つのOIDの共通の祖先OIDを取得
 * @param oid1 OID文字列1
 * @param oid2 OID文字列2
 * @returns 共通の祖先OID
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
 * OIDを人間が読みやすい形式にフォーマット
 * @param oid OID文字列
 * @param name オブジェクト名（オプション）
 * @returns フォーマットされた文字列
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
