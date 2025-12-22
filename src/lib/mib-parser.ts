/**
 * 簡易MIBパーサー
 * 完全なSMI/ASN.1パーサーではなく、基本的なOBJECT-TYPEとOID定義を抽出
 */

import type { FlatMibNode, MibNode, ParseResult, ParseError } from '../types/mib';
import { getParentOid } from './oid-utils';

/**
 * Extract MIB module name from content
 * @param content MIB file content
 * @returns MIB module name or null
 */
function extractMibName(content: string): string | null {
  // Look for pattern like "IF-MIB DEFINITIONS ::= BEGIN"
  const definitionsMatch = content.match(/^\s*([A-Z][A-Za-z0-9-]*)\s+DEFINITIONS\s*::=/m);
  if (definitionsMatch) {
    return definitionsMatch[1];
  }
  return null;
}

/**
 * MIBファイルをパース
 * @param content MIBファイルの内容
 * @param externalOidMap 他のMIBファイルで定義されたOIDマップ（オプション）
 * @returns パース結果（mibNameを含む）
 */
export function parseMibFile(
  content: string,
  externalOidMap?: Map<string, string>
): ParseResult & { mibName: string | null } {
  const errors: ParseError[] = [];
  const nodes: FlatMibNode[] = [];
  const oidMap: Map<string, string> = new Map(); // 名前 -> OID のマッピング
  const mibName = extractMibName(content);

  // 外部OIDマップをマージ（他のMIBファイルで定義されたOID）
  if (externalOidMap) {
    externalOidMap.forEach((oid, name) => {
      oidMap.set(name, oid);
    });
  }

  try {
    // コメントを削除
    let cleanedContent = removeComments(content);

    // IMPORTSブロックを解析して、インポートされた識別子を取得
    const imports = extractImports(cleanedContent);

    // インポートされた識別子のOIDをexternalOidMapから解決
    if (externalOidMap) {
      imports.forEach((_sourceMib, identifier) => {
        // externalOidMapから識別子のOIDを検索
        const resolvedOid = externalOidMap.get(identifier);
        if (resolvedOid) {
          oidMap.set(identifier, resolvedOid);
        }
      });
    }

    // IMPORTSブロックを削除（パース干渉を防ぐため）
    cleanedContent = cleanedContent.replace(/IMPORTS[\s\S]*?;/gi, '');

    // OBJECT IDENTIFIER定義を抽出（現在のoidMapを渡して参照できるようにする）
    const oidAssignments = extractOidAssignments(cleanedContent, oidMap);
    oidAssignments.forEach(({ name, oid }) => {
      oidMap.set(name, oid);
    });

    // OBJECT-TYPE定義を抽出
    const objectTypes = extractObjectTypes(cleanedContent);

    // 各OBJECT-TYPEをパース
    objectTypes.forEach((objType, index) => {
      try {
        const node = parseObjectType(objType, oidMap);
        if (node) {
          // Set MIB name for each node
          node.mibName = mibName || undefined;
          nodes.push(node);
          // Add to oidMap so subsequent OBJECT-TYPEs can reference it
          oidMap.set(node.name, node.oid);
        }
      } catch (error) {
        errors.push({
          line: index,
          message: `Failed to parse OBJECT-TYPE: ${error instanceof Error ? error.message : String(error)}`,
          context: objType.substring(0, 100),
        });
      }
    });

    // OBJECT IDENTIFIER定義もノードとして追加
    oidAssignments.forEach(({ name, oid, description, type }) => {
      // すでにOBJECT-TYPEとして存在しない場合のみ追加
      if (!nodes.find(n => n.name === name)) {
        nodes.push({
          oid,
          name,
          parent: getParentOid(oid),
          type: type || 'OBJECT IDENTIFIER',
          syntax: '',
          access: '',
          status: '',
          description: description || '',
          mibName: mibName || undefined,
        });
      }
    });

  } catch (error) {
    errors.push({
      line: 0,
      message: `Fatal parsing error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return {
    success: errors.length === 0 || nodes.length > 0,
    nodes,
    errors,
    mibName,
  };
}

/**
 * フラットなノードリストからツリー構造を構築
 * @param flatNodes フラットなノードリスト
 * @returns ツリー構造のルートノード配列
 */
export function buildTree(flatNodes: FlatMibNode[]): MibNode[] {
  // ノードをOIDでソート
  const sortedNodes = [...flatNodes].sort((a, b) => {
    const aLen = a.oid.split('.').length;
    const bLen = b.oid.split('.').length;
    if (aLen !== bLen) return aLen - bLen;
    return a.oid.localeCompare(b.oid);
  });

  // OIDをキーとしたマップを作成
  const nodeMap: Map<string, MibNode> = new Map();

  sortedNodes.forEach(flat => {
    nodeMap.set(flat.oid, {
      ...flat,
      children: [],
      isExpanded: false,
    });
  });

  const rootNodes: MibNode[] = [];

  // 親子関係を構築
  sortedNodes.forEach(flat => {
    const node = nodeMap.get(flat.oid);
    if (!node) return;

    if (!flat.parent) {
      // ルートノード
      rootNodes.push(node);
    } else {
      // 親ノードを探す
      const parentNode = nodeMap.get(flat.parent);
      if (parentNode) {
        parentNode.children.push(node);
      } else {
        // 親が見つからない場合はルートに追加
        rootNodes.push(node);
      }
    }
  });

  return rootNodes;
}

/**
 * IMPORTSブロックから識別子とソースMIBを抽出
 * @param content MIBファイルの内容
 * @returns インポートされた識別子とそのソースMIB名のマップ
 */
function extractImports(content: string): Map<string, string> {
  const imports = new Map<string, string>();

  // IMPORTSブロックを見つける
  const importsMatch = content.match(/IMPORTS([\s\S]*?);/i);
  if (!importsMatch) return imports;

  const importsBlock = importsMatch[1];

  // "FROM module-name" のパターンで分割
  // 例: "aristaProducts FROM ARISTA-SMI-MIB"
  const fromPattern = /FROM\s+([\w\-]+)/gi;

  // FROM の位置を特定し、その前の識別子とセットにする
  let currentPos = 0;
  let match;

  while ((match = fromPattern.exec(importsBlock)) !== null) {
    const moduleName = match[1];
    const endPos = match.index;

    // 前回のFROMの終わりから今回のFROMの前までの部分を取得
    const identifiersText = importsBlock.substring(currentPos, endPos);

    // 識別子を抽出（カンマと改行で分割、空白を除去）
    const identifiers = identifiersText
      .split(/[,\n]/)
      .map(id => id.trim())
      .filter(id => id && id !== 'FROM' && !/^[\s\n]*$/.test(id));

    // 各識別子にソースMIB名を関連付け
    identifiers.forEach(identifier => {
      imports.set(identifier, moduleName);
    });

    // 次の検索開始位置を更新（FROM module-nameの後）
    currentPos = match.index + match[0].length;
  }

  return imports;
}

/**
 * コメントを削除
 */
function removeComments(content: string): string {
  // -- で始まる行末までのコメントを削除
  return content.replace(/--[^\n]*/g, '');
}

/**
 * OBJECT IDENTIFIER定義を抽出
 */
function extractOidAssignments(
  content: string,
  externalOidMap?: Map<string, string>
): Array<{ name: string; oid: string; description?: string; type?: string }> {
  const assignments: Array<{ name: string; oid: string; description?: string; type?: string }> = [];

  // パターン1: identifier OBJECT IDENTIFIER ::= { parent child1 child2 ... }
  // 複数の番号に対応（例: { aristaProducts 3011 7124 3282 }）
  const pattern1 = /(\w+)\s+OBJECT\s+IDENTIFIER\s*::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\}/gi;

  let match;
  while ((match = pattern1.exec(content)) !== null) {
    const name = match[1];
    const parent = match[2];
    const childNumbers = match[3].trim().split(/\s+/); // 複数の番号をスペースで分割

    // 親OIDに全ての子番号を追加
    const oid = `${parent}.${childNumbers.join('.')}`;

    assignments.push({
      name,
      oid, // 相対OID（後で解決）
    });
  }

  // パターン2: identifier MODULE-IDENTITY ... ::= { parent child1 child2 ... }
  // IMPORTSブロックを除外するため、より厳密なパターンを使用
  const pattern2 = /^\s*(\w+)\s+MODULE-IDENTITY[\s\S]*?::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\}/gim;

  while ((match = pattern2.exec(content)) !== null) {
    const name = match[1];
    // IMPORTS は除外
    if (name === 'IMPORTS') continue;

    const parent = match[2];
    const childNumbers = match[3].trim().split(/\s+/); // 複数の番号をスペースで分割

    // DESCRIPTIONを抽出
    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    // 親OIDに全ての子番号を追加
    const oid = `${parent}.${childNumbers.join('.')}`;

    assignments.push({
      name,
      oid, // 相対OID（後で解決）
      description,
      type: 'MODULE-IDENTITY',
    });
  }

  // パターン3: identifier OBJECT-IDENTITY ... ::= { parent child1 child2 ... }
  const pattern3 = /^\s*(\w+)\s+OBJECT-IDENTITY[\s\S]*?::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\}/gim;

  while ((match = pattern3.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parent = match[2];
    const childNumbers = match[3].trim().split(/\s+/);

    // DESCRIPTIONを抽出
    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    const oid = `${parent}.${childNumbers.join('.')}`;

    assignments.push({
      name,
      oid,
      description,
      type: 'OBJECT-IDENTITY',
    });
  }

  // 既知のルートOID（SMI標準定義 + IANA Enterprise Numbers）
  // ベンダー固有の製品OIDはIMPORTS解析で動的に解決する
  const knownRoots: Array<{ name: string; oid: string }> = [
    // ISO標準ルート
    { name: 'iso', oid: '1' },
    { name: 'org', oid: '1.3' },
    { name: 'dod', oid: '1.3.6' },
    { name: 'internet', oid: '1.3.6.1' },

    // Internet標準ブランチ
    { name: 'directory', oid: '1.3.6.1.1' },
    { name: 'mgmt', oid: '1.3.6.1.2' },
    { name: 'experimental', oid: '1.3.6.1.3' },
    { name: 'private', oid: '1.3.6.1.4' },
    { name: 'enterprises', oid: '1.3.6.1.4.1' },

    // MIB-2標準グループ（RFC 1213）
    { name: 'mib-2', oid: '1.3.6.1.2.1' },
    { name: 'system', oid: '1.3.6.1.2.1.1' },
    { name: 'interfaces', oid: '1.3.6.1.2.1.2' },
    { name: 'at', oid: '1.3.6.1.2.1.3' },
    { name: 'ip', oid: '1.3.6.1.2.1.4' },
    { name: 'icmp', oid: '1.3.6.1.2.1.5' },
    { name: 'tcp', oid: '1.3.6.1.2.1.6' },
    { name: 'udp', oid: '1.3.6.1.2.1.7' },
    { name: 'egp', oid: '1.3.6.1.2.1.8' },
    { name: 'snmp', oid: '1.3.6.1.2.1.11' },
 ];

  const oidMap = new Map<string, string>();

  // 外部OIDマップをマージ（他のMIBファイルで定義されたOID）
  if (externalOidMap) {
    externalOidMap.forEach((oid, name) => {
      oidMap.set(name, oid);
    });
  }

  // 既知のルートを追加
  knownRoots.forEach(({ name, oid }) => {
    oidMap.set(name, oid);
  });

  // 相対OIDを絶対OIDに解決
  const resolved: Array<{ name: string; oid: string; description?: string; type?: string }> = [];
  const unresolved: Array<{ name: string; oid: string; description?: string; type?: string }> = [];
  let changed = true;
  const maxIterations = 10;
  let iteration = 0;

  while (changed && iteration < maxIterations) {
    changed = false;
    iteration++;

    assignments.forEach(({ name, oid, description, type }) => {
      if (!resolved.find(r => r.name === name) && !unresolved.find(u => u.name === name)) {
        const resolvedOid = resolveOid(oid, oidMap);
        if (resolvedOid && /^[\d.]+$/.test(resolvedOid)) {
          // 絶対OIDに解決できた
          oidMap.set(name, resolvedOid);
          resolved.push({ name, oid: resolvedOid, description, type });
          changed = true;
        } else if (iteration === maxIterations) {
          // 最終イテレーションで解決できなかった相対OIDを保持
          unresolved.push({ name, oid, description, type });
        }
      }
    });
  }

  // 解決できなかった相対OIDも追加（他のMIBファイルで解決される可能性がある）
  unresolved.forEach(item => {
    resolved.push(item);
  });

  // 既知のルートも追加
  knownRoots.forEach(root => {
    if (!resolved.find(r => r.name === root.name)) {
      resolved.push(root);
    }
  });

  return resolved;
}

/**
 * OBJECT-TYPE定義を抽出
 */
function extractObjectTypes(content: string): string[] {
  const objectTypes: string[] = [];

  // OBJECT-TYPE blocks can contain nested braces (e.g., INDEX { ifIndex })
  // We need to carefully track braces to handle nested structures
  const lines = content.split('\n');
  let currentBlock = '';
  let inObjectType = false;
  let foundAssignment = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for start of new OBJECT-TYPE (only when not already in one)
    if (!inObjectType && /^\s*\w+\s+OBJECT-TYPE/i.test(line)) {
      inObjectType = true;
      foundAssignment = false;
      braceDepth = 0;
      currentBlock = line + '\n';
      continue;
    }

    if (inObjectType) {
      currentBlock += line + '\n';

      // Check if this line has the ::= assignment
      if (/::=\s*\{/.test(line)) {
        foundAssignment = true;
      }

      // Count braces to track nesting depth
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }

      // If we found the assignment and all braces are balanced, we're done
      if (foundAssignment && braceDepth === 0) {
        objectTypes.push(currentBlock.trim());
        inObjectType = false;
        currentBlock = '';
        foundAssignment = false;
      }
    }
  }

  return objectTypes;
}

/**
 * OBJECT-TYPE定義をパース
 */
function parseObjectType(content: string, oidMap: Map<string, string>): FlatMibNode | null {
  // 名前を抽出
  const nameMatch = content.match(/^(\w+)\s+OBJECT-TYPE/);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  // SYNTAX を抽出
  const syntaxMatch = content.match(/SYNTAX\s+([\w\-\s()]+?)(?=\s+(?:ACCESS|MAX-ACCESS|STATUS))/i);
  const syntax = syntaxMatch ? syntaxMatch[1].trim() : '';

  // ACCESS を抽出
  const accessMatch = content.match(/(?:ACCESS|MAX-ACCESS)\s+([\w\-]+)/i);
  const access = accessMatch ? accessMatch[1].trim() : '';

  // STATUS を抽出
  const statusMatch = content.match(/STATUS\s+([\w\-]+)/i);
  const status = statusMatch ? statusMatch[1].trim() : '';

  // DESCRIPTION を抽出（複数行対応）
  const descMatch = content.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
  const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

  // OID を抽出 ::= { parent child }
  const oidMatch = content.match(/::=\s*\{\s*([\w\-]+)\s+(\d+)\s*\}/);
  if (!oidMatch) return null;

  const parentName = oidMatch[1];
  const childNum = oidMatch[2];

  // 親のOIDを解決
  const parentOid = oidMap.get(parentName);
  if (!parentOid) {
    console.warn(`Parent OID not found for ${parentName}`);
    return null;
  }

  const oid = `${parentOid}.${childNum}`;

  return {
    oid,
    name,
    parent: parentOid,
    type: 'OBJECT-TYPE',
    syntax,
    access,
    status,
    description,
  };
}

/**
 * 相対OIDを絶対OIDに解決
 */
function resolveOid(oid: string, oidMap: Map<string, string>): string {
  // すでに数値のみの場合はそのまま返す
  if (/^[\d.]+$/.test(oid)) {
    return oid;
  }

  // "parent.child" 形式を解決
  const parts = oid.split('.');
  const resolved: string[] = [];

  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      resolved.push(part);
    } else {
      const mappedOid = oidMap.get(part);
      if (mappedOid) {
        resolved.push(mappedOid);
      } else {
        return oid; // 解決できない
      }
    }
  }

  return resolved.join('.');
}

/**
 * ツリーを検索（名前またはOIDで）
 * @param tree MIBツリー
 * @param query 検索クエリ
 * @returns マッチしたノードの配列
 */
export function searchTree(tree: MibNode[], query: string): MibNode[] {
  const results: MibNode[] = [];
  const lowerQuery = query.toLowerCase();

  function search(nodes: MibNode[]) {
    for (const node of nodes) {
      if (
        node.name.toLowerCase().includes(lowerQuery) ||
        node.oid.includes(query) ||
        node.description.toLowerCase().includes(lowerQuery)
      ) {
        results.push(node);
      }
      if (node.children.length > 0) {
        search(node.children);
      }
    }
  }

  search(tree);
  return results;
}

/**
 * Filter tree to show only matching nodes and their ancestors
 * @param tree MIB tree
 * @param query Search query
 * @returns Filtered tree
 */
export function filterTreeByQuery(tree: MibNode[], query: string): MibNode[] {
  if (!query) return tree;

  const lowerQuery = query.toLowerCase();

  // Check if a node or any of its descendants match the query
  function hasMatch(node: MibNode): boolean {
    // Check current node
    if (
      node.name.toLowerCase().includes(lowerQuery) ||
      node.oid.includes(query) ||
      node.description.toLowerCase().includes(lowerQuery)
    ) {
      return true;
    }

    // Check children recursively
    return node.children.some(child => hasMatch(child));
  }

  // Filter tree recursively, keeping nodes that match or have matching descendants
  function filterNodes(nodes: MibNode[]): MibNode[] {
    return nodes
      .filter(node => hasMatch(node))
      .map(node => ({
        ...node,
        children: node.children.length > 0 ? filterNodes(node.children) : []
      }));
  }

  return filterNodes(tree);
}

/**
 * ツリーをフラット化
 * @param tree MIBツリー
 * @returns フラットなノード配列
 */
export function flattenTree(tree: MibNode[]): MibNode[] {
  const result: MibNode[] = [];

  function flatten(nodes: MibNode[]) {
    for (const node of nodes) {
      result.push(node);
      if (node.children.length > 0) {
        flatten(node.children);
      }
    }
  }

  flatten(tree);
  return result;
}

// === 3-pass approach functions ===

/**
 * Parse MIB file into ParsedModule format (for 3-pass tree building)
 * Does not resolve OIDs - returns raw parent names and SubIDs
 * @param content MIB file content
 * @param fileName Source file name (optional)
 * @returns ParsedModule
 */
export function parseMibModule(content: string, fileName?: string): import('../types/mib').ParsedModule {
  const mibName = extractMibName(content) || 'UNKNOWN';
  const cleanedContent = removeComments(content);

  // Extract IMPORTS before removing IMPORTS block
  const imports = extractImports(cleanedContent);

  // Convert Map<identifier, sourceMib> to Map<identifier, sourceMib> for ParsedModule
  const importsMap = new Map(
    Array.from(imports.entries()).map(([identifier, sourceMib]) => [identifier, sourceMib])
  );

  // Remove IMPORTS block to prevent parsing interference
  const cleanedWithoutImports = cleanedContent.replace(/IMPORTS[\s\S]*?;/gi, '');

  // Extract OID assignments (OBJECT IDENTIFIER, MODULE-IDENTITY, OBJECT-IDENTITY)
  // Pass empty map to prevent OID resolution
  const oidAssignments = extractOidAssignmentsRaw(cleanedWithoutImports);

  // Extract OBJECT-TYPE definitions
  const objectTypes = extractObjectTypes(cleanedWithoutImports);

  const objects: import('../types/mib').RawMibObject[] = [];

  // Add OID assignments (OBJECT IDENTIFIER, MODULE-IDENTITY, OBJECT-IDENTITY)
  oidAssignments.forEach(({ name, parent, subids, description, type }) => {
    objects.push({
      name,
      parentName: parent,
      subid: subids.length === 1 ? subids[0] : subids,
      type: type || 'OBJECT IDENTIFIER',
      description,
      fileName,
    });
  });

  // Add OBJECT-TYPEs
  objectTypes.forEach(objType => {
    const parsed = parseObjectTypeRaw(objType);
    if (parsed) {
      objects.push({
        ...parsed,
        fileName,
      });
    }
  });

  return {
    moduleName: mibName,
    fileName: fileName || '',
    imports: importsMap,
    objects,
  };
}

/**
 * Extract OID assignments in raw format (without resolution)
 * Returns parent name and SubIDs as-is
 */
function extractOidAssignmentsRaw(
  content: string
): Array<{ name: string; parent: string; subids: number[]; description?: string; type?: string }> {
  const assignments: Array<{ name: string; parent: string; subids: number[]; description?: string; type?: string }> = [];

  // Pattern 1: identifier OBJECT IDENTIFIER ::= { parent child1 child2 ... }
  const pattern1 = /(\w+)\s+OBJECT\s+IDENTIFIER\s*::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\}/gi;

  let match;
  while ((match = pattern1.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parent = match[2];
    const subids = match[3].trim().split(/\s+/).map(Number);

    assignments.push({
      name,
      parent,
      subids,
      type: 'OBJECT IDENTIFIER',
    });
  }

  // Pattern 2: identifier MODULE-IDENTITY ... ::= { parent child1 child2 ... }
  const pattern2 = /^\s*(\w+)\s+MODULE-IDENTITY[\s\S]*?::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\}/gim;

  while ((match = pattern2.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parent = match[2];
    const subids = match[3].trim().split(/\s+/).map(Number);

    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    assignments.push({
      name,
      parent,
      subids,
      description,
      type: 'MODULE-IDENTITY',
    });
  }

  // Pattern 3: identifier OBJECT-IDENTITY ... ::= { parent child1 child2 ... }
  const pattern3 = /^\s*(\w+)\s+OBJECT-IDENTITY[\s\S]*?::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\}/gim;

  while ((match = pattern3.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parent = match[2];
    const subids = match[3].trim().split(/\s+/).map(Number);

    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    assignments.push({
      name,
      parent,
      subids,
      description,
      type: 'OBJECT-IDENTITY',
    });
  }

  return assignments;
}

/**
 * Parse OBJECT-TYPE definition in raw format (without OID resolution)
 * Returns parent name and SubID as-is
 */
function parseObjectTypeRaw(content: string): import('../types/mib').RawMibObject | null {
  const nameMatch = content.match(/^(\w+)\s+OBJECT-TYPE/);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  // Extract SYNTAX
  const syntaxMatch = content.match(/SYNTAX\s+([\w\-\s(){}]+?)(?=\s+(?:UNITS|MAX-ACCESS|ACCESS|STATUS|DESCRIPTION))/i);
  const syntax = syntaxMatch ? syntaxMatch[1].trim() : '';

  // Extract ACCESS or MAX-ACCESS
  const accessMatch = content.match(/(?:ACCESS|MAX-ACCESS)\s+([\w\-]+)/i);
  const access = accessMatch ? accessMatch[1].trim() : '';

  // Extract STATUS
  const statusMatch = content.match(/STATUS\s+([\w\-]+)/i);
  const status = statusMatch ? statusMatch[1].trim() : '';

  // Extract DESCRIPTION
  const descMatch = content.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
  const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

  // Extract OID assignment (parent name and SubID only, no resolution)
  const oidMatch = content.match(/::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\s*\}/);
  if (!oidMatch) return null;

  const parentName = oidMatch[1];
  const subids = oidMatch[2].trim().split(/\s+/).map(Number);

  return {
    name,
    parentName,
    subid: subids.length === 1 ? subids[0] : subids,
    type: 'OBJECT-TYPE',
    syntax,
    access,
    status,
    description,
  };
}
