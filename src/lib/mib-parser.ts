/**
 * Simple MIB Parser
 * Not a complete SMI/ASN.1 parser, but extracts basic OBJECT-TYPE and OID definitions
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
 * Validate if content is a valid MIB file
 * @param content File content to validate
 * @returns Object with isValid flag and error message if invalid
 */
export function validateMibContent(content: string): { isValid: boolean; error?: string } {
  // Check 1: Must have MIB module definition (MODULE-NAME DEFINITIONS ::= BEGIN)
  const mibName = extractMibName(content);
  if (!mibName) {
    return {
      isValid: false,
      error: 'Invalid MIB file: Missing module definition (MODULE-NAME DEFINITIONS ::= BEGIN)',
    };
  }

  // Check 2: Must have BEGIN keyword
  if (!/\bBEGIN\b/i.test(content)) {
    return {
      isValid: false,
      error: 'Invalid MIB file: Missing BEGIN keyword',
    };
  }

  // Check 3: Must have END keyword
  if (!/\bEND\b/i.test(content)) {
    return {
      isValid: false,
      error: 'Invalid MIB file: Missing END keyword',
    };
  }

  // Check 4: Should have at least one of: OBJECT-TYPE, OBJECT IDENTIFIER, MODULE-IDENTITY, OBJECT-IDENTITY, NOTIFICATION-TYPE
  const hasObjectType = /OBJECT-TYPE/i.test(content);
  const hasObjectIdentifier = /OBJECT\s+IDENTIFIER/i.test(content);
  const hasModuleIdentity = /MODULE-IDENTITY/i.test(content);
  const hasObjectIdentity = /OBJECT-IDENTITY/i.test(content);
  const hasNotificationType = /NOTIFICATION-TYPE/i.test(content);

  if (!hasObjectType && !hasObjectIdentifier && !hasModuleIdentity && !hasObjectIdentity && !hasNotificationType) {
    return {
      isValid: false,
      error: 'Invalid MIB file: No OBJECT-TYPE, OBJECT IDENTIFIER, MODULE-IDENTITY, OBJECT-IDENTITY, or NOTIFICATION-TYPE definitions found',
    };
  }

  return { isValid: true };
}

/**
 * Parse MIB file
 * @param content MIB file content
 * @param externalOidMap OID map from other MIB files (optional)
 * @returns Parse result (including mibName)
 */
export function parseMibFile(
  content: string,
  externalOidMap?: Map<string, string>
): ParseResult & { mibName: string | null } {
  const errors: ParseError[] = [];
  const nodes: FlatMibNode[] = [];
  const oidMap: Map<string, string> = new Map(); // name -> OID mapping
  const mibName = extractMibName(content);

  // Merge external OID map (OIDs defined in other MIB files)
  if (externalOidMap) {
    externalOidMap.forEach((oid, name) => {
      oidMap.set(name, oid);
    });
  }

  try {
    // Remove comments
    let cleanedContent = removeComments(content);

    // Parse IMPORTS block to get imported identifiers
    const imports = extractImports(cleanedContent);

    // Resolve imported identifier OIDs from externalOidMap
    if (externalOidMap) {
      imports.forEach((_sourceMib, identifier) => {
        // Look up identifier OID from externalOidMap
        const resolvedOid = externalOidMap.get(identifier);
        if (resolvedOid) {
          oidMap.set(identifier, resolvedOid);
        }
      });
    }

    // Remove IMPORTS block (to prevent parsing interference)
    cleanedContent = cleanedContent.replace(/IMPORTS[\s\S]*?;/gi, '');

    // Extract OBJECT IDENTIFIER definitions (pass current oidMap for reference)
    const oidAssignments = extractOidAssignments(cleanedContent, oidMap);
    oidAssignments.forEach(({ name, oid }) => {
      oidMap.set(name, oid);
    });

    // Extract OBJECT-TYPE definitions
    const objectTypes = extractObjectTypes(cleanedContent);

    // Parse each OBJECT-TYPE
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

    // Add OBJECT IDENTIFIER definitions as nodes
    oidAssignments.forEach(({ name, oid, description, type }) => {
      // Only add if not already exists as OBJECT-TYPE
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
 * Build tree structure from flat node list
 * @param flatNodes Flat node list
 * @returns Array of root nodes in tree structure
 */
export function buildTree(flatNodes: FlatMibNode[]): MibNode[] {
  // Sort nodes by OID
  const sortedNodes = [...flatNodes].sort((a, b) => {
    const aLen = a.oid.split('.').length;
    const bLen = b.oid.split('.').length;
    if (aLen !== bLen) return aLen - bLen;
    return a.oid.localeCompare(b.oid);
  });

  // Create map with OID as key
  const nodeMap: Map<string, MibNode> = new Map();

  sortedNodes.forEach(flat => {
    nodeMap.set(flat.oid, {
      ...flat,
      children: [],
      isExpanded: false,
    });
  });

  const rootNodes: MibNode[] = [];

  // Build parent-child relationships
  sortedNodes.forEach(flat => {
    const node = nodeMap.get(flat.oid);
    if (!node) return;

    if (!flat.parent) {
      // Root node
      rootNodes.push(node);
    } else {
      // Find parent node
      const parentNode = nodeMap.get(flat.parent);
      if (parentNode) {
        parentNode.children.push(node);
      } else {
        // Add to root if parent not found
        rootNodes.push(node);
      }
    }
  });

  return rootNodes;
}

/**
 * Extract identifiers and source MIBs from IMPORTS block
 * @param content MIB file content
 * @returns Map of imported identifiers to their source MIB names
 */
function extractImports(content: string): Map<string, string> {
  const imports = new Map<string, string>();

  // Find IMPORTS block
  const importsMatch = content.match(/IMPORTS([\s\S]*?);/i);
  if (!importsMatch) return imports;

  const importsBlock = importsMatch[1];

  // Split by "FROM module-name" pattern
  // Example: "aristaProducts FROM ARISTA-SMI-MIB"
  const fromPattern = /FROM\s+([\w\-]+)/gi;

  // Identify FROM positions and pair with preceding identifiers
  let currentPos = 0;
  let match;

  while ((match = fromPattern.exec(importsBlock)) !== null) {
    const moduleName = match[1];
    const endPos = match.index;

    // Get text from end of last FROM to current FROM
    const identifiersText = importsBlock.substring(currentPos, endPos);

    // Extract identifiers (split by comma and newline, remove whitespace)
    const identifiers = identifiersText
      .split(/[,\n]/)
      .map(id => id.trim())
      .filter(id => id && id !== 'FROM' && !/^[\s\n]*$/.test(id));

    // Associate each identifier with source MIB name
    identifiers.forEach(identifier => {
      imports.set(identifier, moduleName);
    });

    // Update next search start position (after FROM module-name)
    currentPos = match.index + match[0].length;
  }

  return imports;
}

/**
 * Remove comments
 */
function removeComments(content: string): string {
  // Remove comments starting with -- to end of line
  return content.replace(/--[^\n]*/g, '');
}

/**
 * Extract OBJECT IDENTIFIER definitions
 */
function extractOidAssignments(
  content: string,
  externalOidMap?: Map<string, string>
): Array<{ name: string; oid: string; description?: string; type?: string }> {
  const assignments: Array<{ name: string; oid: string; description?: string; type?: string }> = [];

  // Pattern 1: identifier OBJECT IDENTIFIER ::= { parent child1 child2 ... }
  // Supports multiple numbers (e.g., { aristaProducts 3011 7124 3282 })
  const pattern1 = /(\w+)\s+OBJECT\s+IDENTIFIER\s*::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\}/gi;

  let match;
  while ((match = pattern1.exec(content)) !== null) {
    const name = match[1];
    const parent = match[2];
    const childNumbers = match[3].trim().split(/\s+/); // Split multiple numbers by space

    // Append all child numbers to parent OID
    const oid = `${parent}.${childNumbers.join('.')}`;

    assignments.push({
      name,
      oid, // Relative OID (resolved later)
    });
  }

  // Pattern 2: identifier MODULE-IDENTITY ... ::= { parent child1 child2 ... }
  // Use stricter pattern to exclude IMPORTS block
  const pattern2 = /^\s*(\w+)\s+MODULE-IDENTITY[\s\S]*?::=\s*\{\s*([\w\-]+)\s+([\d\s]+)\}/gim;

  while ((match = pattern2.exec(content)) !== null) {
    const name = match[1];
    // Exclude IMPORTS
    if (name === 'IMPORTS') continue;

    const parent = match[2];
    const childNumbers = match[3].trim().split(/\s+/); // Split multiple numbers by space

    // Extract DESCRIPTION
    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    // Add all child numbers to parent OID
    const oid = `${parent}.${childNumbers.join('.')}`;

    assignments.push({
      name,
      oid, // Relative OID (resolved later)
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
    const childNumbers = match[3].trim().split(/\s+/);

    // Extract DESCRIPTION
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

  // Known root OIDs (SMI standard definitions + IANA Enterprise Numbers)
  // Vendor-specific product OIDs are dynamically resolved via IMPORTS parsing
  const knownRoots: Array<{ name: string; oid: string }> = [
    // ISO standard roots
    { name: 'iso', oid: '1' },
    { name: 'org', oid: '1.3' },
    { name: 'dod', oid: '1.3.6' },
    { name: 'internet', oid: '1.3.6.1' },

    // Internet standard branches
    { name: 'directory', oid: '1.3.6.1.1' },
    { name: 'mgmt', oid: '1.3.6.1.2' },
    { name: 'experimental', oid: '1.3.6.1.3' },
    { name: 'private', oid: '1.3.6.1.4' },
    { name: 'enterprises', oid: '1.3.6.1.4.1' },

    // MIB-2 standard groups (RFC 1213)
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

  // Merge external OID map (OIDs defined in other MIB files)
  if (externalOidMap) {
    externalOidMap.forEach((oid, name) => {
      oidMap.set(name, oid);
    });
  }

  // Add known roots
  knownRoots.forEach(({ name, oid }) => {
    oidMap.set(name, oid);
  });

  // Resolve relative OIDs to absolute OIDs
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
          // Successfully resolved to absolute OID
          oidMap.set(name, resolvedOid);
          resolved.push({ name, oid: resolvedOid, description, type });
          changed = true;
        } else if (iteration === maxIterations) {
          // Keep unresolved relative OIDs from final iteration
          unresolved.push({ name, oid, description, type });
        }
      }
    });
  }

  // Add unresolved relative OIDs (may be resolved by other MIB files)
  unresolved.forEach(item => {
    resolved.push(item);
  });

  // Add known roots
  knownRoots.forEach(root => {
    if (!resolved.find(r => r.name === root.name)) {
      resolved.push(root);
    }
  });

  return resolved;
}

/**
 * Extract OBJECT-TYPE definitions
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
 * Extract TEXTUAL-CONVENTION definitions from MIB content
 */
function extractTextualConventions(content: string): import('../types/mib').TextualConvention[] {
  const conventions: import('../types/mib').TextualConvention[] = [];

  // Pattern: name ::= TEXTUAL-CONVENTION ... SYNTAX ...
  const pattern = /(\w+)\s*::=\s*TEXTUAL-CONVENTION([\s\S]*?)(?=\n\s*\w+\s*(?:::=|OBJECT-TYPE|OBJECT-IDENTITY|MODULE-IDENTITY|NOTIFICATION-TYPE)|$)/gi;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];

    // Extract STATUS
    const statusMatch = body.match(/STATUS\s+([\w-]+)/i);
    const status = statusMatch ? statusMatch[1].trim() : undefined;

    // Extract DISPLAY-HINT
    const displayHintMatch = body.match(/DISPLAY-HINT\s+"([^"]+)"/i);
    const displayHint = displayHintMatch ? displayHintMatch[1] : undefined;

    // Extract DESCRIPTION
    const descMatch = body.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : undefined;

    // Extract SYNTAX with possible enum values or ranges
    const syntaxMatch = body.match(/SYNTAX\s+([\s\S]*?)(?=STATUS|DESCRIPTION|DISPLAY-HINT|$)/i);
    if (!syntaxMatch) continue;

    let syntaxRaw = syntaxMatch[1].trim();
    let syntax = syntaxRaw;
    let enumValues: Array<{ name: string; value: number }> | undefined;
    let ranges: Array<{ min: number; max: number }> | undefined;

    // Check for enum values: INTEGER { name(value), ... }
    const enumMatch = syntaxRaw.match(/(\w+(?:\s+\w+)*)\s*\{([^}]+)\}/);
    if (enumMatch) {
      syntax = enumMatch[1].trim();
      const enumBody = enumMatch[2];
      enumValues = [];
      const enumPattern = /(\w+)\s*\(\s*(-?\d+)\s*\)/g;
      let enumItem;
      while ((enumItem = enumPattern.exec(enumBody)) !== null) {
        enumValues.push({ name: enumItem[1], value: parseInt(enumItem[2], 10) });
      }
      if (enumValues.length === 0) enumValues = undefined;
    }

    // Check for size/range constraints: (SIZE (min..max)) or (min..max)
    const rangeMatch = syntaxRaw.match(/\(\s*(?:SIZE\s*\()?\s*(\d+)\s*\.\.\s*(\d+)\s*\)?\s*\)/i);
    if (rangeMatch) {
      ranges = [{ min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) }];
      // Clean up syntax
      syntax = syntax.replace(/\s*\(.*\)\s*$/, '').trim();
    }

    conventions.push({
      name,
      status,
      description,
      displayHint,
      syntax,
      enumValues,
      ranges,
    });
  }

  return conventions;
}

/**
 * Parse OBJECT-TYPE definition
 */
function parseObjectType(content: string, oidMap: Map<string, string>): FlatMibNode | null {
  // Extract name
  const nameMatch = content.match(/^(\w+)\s+OBJECT-TYPE/);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  // Extract SYNTAX
  const syntaxMatch = content.match(/SYNTAX\s+([\w\-\s()]+?)(?=\s+(?:ACCESS|MAX-ACCESS|STATUS))/i);
  const syntax = syntaxMatch ? syntaxMatch[1].trim() : '';

  // Extract ACCESS
  const accessMatch = content.match(/(?:ACCESS|MAX-ACCESS)\s+([\w\-]+)/i);
  const access = accessMatch ? accessMatch[1].trim() : '';

  // Extract STATUS
  const statusMatch = content.match(/STATUS\s+([\w\-]+)/i);
  const status = statusMatch ? statusMatch[1].trim() : '';

  // Extract DESCRIPTION (multiline support)
  const descMatch = content.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
  const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

  // Extract OID ::= { parent child }
  const oidMatch = content.match(/::=\s*\{\s*([\w\-]+)\s+(\d+)\s*\}/);
  if (!oidMatch) return null;

  const parentName = oidMatch[1];
  const childNum = oidMatch[2];

  // Resolve parent OID
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
 * Resolve relative OID to absolute OID
 */
function resolveOid(oid: string, oidMap: Map<string, string>): string {
  // Return as-is if already numeric only
  if (/^[\d.]+$/.test(oid)) {
    return oid;
  }

  // Resolve "parent.child" format
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
        return oid; // Cannot resolve
      }
    }
  }

  return resolved.join('.');
}

/**
 * Search tree (by name or OID)
 * @param tree MIB tree
 * @param query Search query
 * @returns Array of matching nodes
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
 * Flatten tree to array
 * @param tree MIB tree
 * @returns Flat array of nodes
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

  // Add OID assignments (OBJECT IDENTIFIER, MODULE-IDENTITY, OBJECT-IDENTITY, NOTIFICATION-TYPE)
  oidAssignments.forEach(({ name, parent, subids, description, type, status }) => {
    objects.push({
      name,
      parentName: parent,
      subid: subids.length === 1 ? subids[0] : subids,
      type: type || 'OBJECT IDENTIFIER',
      description,
      status,
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

  // Extract TEXTUAL-CONVENTIONs
  const textualConventions = extractTextualConventions(cleanedWithoutImports);

  return {
    moduleName: mibName,
    fileName: fileName || '',
    imports: importsMap,
    objects,
    textualConventions: textualConventions.length > 0 ? textualConventions : undefined,
  };
}

/**
 * Parse OID block content like "{ org ieee(111) lan-man-stds(802) 1 }"
 * Handles both simple format "{ parent subid }" and named number format "{ parent name(num) ... }"
 * @returns { parent: string, subids: number[] } or null if parsing fails
 */
function parseOidBlock(blockContent: string): { parent: string; subids: number[] } | null {
  // Remove braces and trim
  const inner = blockContent.replace(/^\s*\{\s*|\s*\}\s*$/g, '').trim();
  if (!inner) return null;

  // Split by whitespace (handling multiline)
  const parts = inner.split(/\s+/).filter(p => p.length > 0);
  if (parts.length < 2) return null;

  const parent = parts[0];
  const subids: number[] = [];

  // Process remaining parts
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    // Check for named number format: name(number)
    const namedMatch = part.match(/^[\w\-]+\((\d+)\)$/);
    if (namedMatch) {
      subids.push(parseInt(namedMatch[1], 10));
    } else if (/^\d+$/.test(part)) {
      // Plain number
      subids.push(parseInt(part, 10));
    }
    // Skip non-matching parts (like identifiers without numbers)
  }

  if (subids.length === 0) return null;
  return { parent, subids };
}

/**
 * Extract OID assignments in raw format (without resolution)
 * Returns parent name and SubIDs as-is
 */
function extractOidAssignmentsRaw(
  content: string
): Array<{ name: string; parent: string; subids: number[]; description?: string; type?: string; status?: string }> {
  const assignments: Array<{ name: string; parent: string; subids: number[]; description?: string; type?: string; status?: string }> = [];

  // Pattern 1: identifier OBJECT IDENTIFIER ::= { ... }
  // Now supports both simple and named number formats
  const pattern1 = /(\w+)\s+OBJECT\s+IDENTIFIER\s*::=\s*(\{[^}]+\})/gi;

  let match;
  while ((match = pattern1.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parsed = parseOidBlock(match[2]);
    if (!parsed) continue;

    assignments.push({
      name,
      parent: parsed.parent,
      subids: parsed.subids,
      type: 'OBJECT IDENTIFIER',
    });
  }

  // Pattern 2: identifier MODULE-IDENTITY ... ::= { ... }
  const pattern2 = /^\s*(\w+)\s+MODULE-IDENTITY[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while ((match = pattern2.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parsed = parseOidBlock(match[2]);
    if (!parsed) continue;

    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    assignments.push({
      name,
      parent: parsed.parent,
      subids: parsed.subids,
      description,
      type: 'MODULE-IDENTITY',
    });
  }

  // Pattern 3: identifier OBJECT-IDENTITY ... ::= { ... }
  const pattern3 = /^\s*(\w+)\s+OBJECT-IDENTITY[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while ((match = pattern3.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parsed = parseOidBlock(match[2]);
    if (!parsed) continue;

    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    assignments.push({
      name,
      parent: parsed.parent,
      subids: parsed.subids,
      description,
      type: 'OBJECT-IDENTITY',
    });
  }

  // Pattern 4: identifier NOTIFICATION-TYPE ... ::= { ... }
  const pattern4 = /^\s*(\w+)\s+NOTIFICATION-TYPE[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while ((match = pattern4.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parsed = parseOidBlock(match[2]);
    if (!parsed) continue;

    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    // Extract STATUS
    const statusMatch = fullMatch.match(/STATUS\s+([\w\-]+)/i);
    const status = statusMatch ? statusMatch[1].trim() : '';

    assignments.push({
      name,
      parent: parsed.parent,
      subids: parsed.subids,
      description,
      type: 'NOTIFICATION-TYPE',
      status,
    });
  }

  // Pattern 5: identifier MODULE-COMPLIANCE ... ::= { ... }
  const pattern5 = /^\s*(\w+)\s+MODULE-COMPLIANCE[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while ((match = pattern5.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parsed = parseOidBlock(match[2]);
    if (!parsed) continue;

    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    const statusMatch = fullMatch.match(/STATUS\s+([\w\-]+)/i);
    const status = statusMatch ? statusMatch[1].trim() : '';

    assignments.push({
      name,
      parent: parsed.parent,
      subids: parsed.subids,
      description,
      type: 'MODULE-COMPLIANCE',
      status,
    });
  }

  // Pattern 6: identifier OBJECT-GROUP ... ::= { ... }
  const pattern6 = /^\s*(\w+)\s+OBJECT-GROUP[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while ((match = pattern6.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parsed = parseOidBlock(match[2]);
    if (!parsed) continue;

    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    const statusMatch = fullMatch.match(/STATUS\s+([\w\-]+)/i);
    const status = statusMatch ? statusMatch[1].trim() : '';

    assignments.push({
      name,
      parent: parsed.parent,
      subids: parsed.subids,
      description,
      type: 'OBJECT-GROUP',
      status,
    });
  }

  // Pattern 7: identifier NOTIFICATION-GROUP ... ::= { ... }
  const pattern7 = /^\s*(\w+)\s+NOTIFICATION-GROUP[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while ((match = pattern7.exec(content)) !== null) {
    const name = match[1];
    if (name === 'IMPORTS') continue;

    const parsed = parseOidBlock(match[2]);
    if (!parsed) continue;

    const fullMatch = match[0];
    const descMatch = fullMatch.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    const statusMatch = fullMatch.match(/STATUS\s+([\w\-]+)/i);
    const status = statusMatch ? statusMatch[1].trim() : '';

    assignments.push({
      name,
      parent: parsed.parent,
      subids: parsed.subids,
      description,
      type: 'NOTIFICATION-GROUP',
      status,
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
