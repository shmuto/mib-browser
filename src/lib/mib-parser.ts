/**
 * Simple MIB Parser
 * Not a complete SMI/ASN.1 parser, but extracts basic OBJECT-TYPE and OID definitions
 */

import type { MibNode } from '../types/mib';

/**
 * Extract the MIB module name from content that has already had comments removed.
 *
 * Callers strip comments first because the module name and DEFINITIONS are
 * often separated by one, as in
 *   FROGFOOT-RESOURCES-MIB
 *   -- -*- mib -*-
 *   DEFINITIONS ::= BEGIN
 */
function extractMibNameFromCleaned(cleanedContent: string): string | null {
  // Look for pattern like "IF-MIB DEFINITIONS ::= BEGIN".
  // ASN.1 allows a tagging clause between the two, so those keywords are
  // spelled out. They are spelled out rather than skipped with something like
  // `[^;]*?`, which would make this quadratic in the length of a file that
  // never matches - and the file comes from the user.
  // The leading indent is matched with [ \t]* rather than \s*: with `m`, `^`
  // already matches at every line start, so \s* bought nothing - but it could
  // run across every blank line in the file from each of those starts, which is
  // quadratic on a file that is all comments (they become blank lines here) and
  // never matches. That file comes from the user.
  const definitionsMatch = cleanedContent.match(
    /^[ \t]*([A-Z][A-Za-z0-9-]*)\s+DEFINITIONS(?:\s+(?:AUTOMATIC|IMPLICIT|EXPLICIT)\s+TAGS)?(?:\s+EXTENSIBILITY\s+IMPLIED)?\s*::=/m
  );
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
  // Checks run against the comment-stripped text, so a keyword that only
  // appears in a comment does not make a file look like a MIB
  const cleanedContent = removeComments(content);

  // Check 1: Must have MIB module definition (MODULE-NAME DEFINITIONS ::= BEGIN)
  const mibName = extractMibNameFromCleaned(cleanedContent);
  if (!mibName) {
    return {
      isValid: false,
      error: 'Invalid MIB file: Missing module definition (MODULE-NAME DEFINITIONS ::= BEGIN)',
    };
  }

  // Check 2: Must have BEGIN keyword
  if (!/\bBEGIN\b/i.test(cleanedContent)) {
    return {
      isValid: false,
      error: 'Invalid MIB file: Missing BEGIN keyword',
    };
  }

  // Check 3: Must have END keyword
  if (!/\bEND\b/i.test(cleanedContent)) {
    return {
      isValid: false,
      error: 'Invalid MIB file: Missing END keyword',
    };
  }

  // There is deliberately no "must define something" check. A module that
  // defines nothing is still a module: RFC-1212 as shipped in most MIB
  // collections has its whole body commented out, and macro-only modules
  // define constructs this parser does not model. Such a file contributes no
  // nodes and shows a node count of 0, which says everything a rejection would
  // - without making a bulk upload of a standard MIB directory look broken.

  return { isValid: true };
}

/**
 * Extract identifiers and source MIBs from IMPORTS block
 * @param content MIB file content
 * @returns Map of imported identifiers to their source MIB names
 */
function extractImports(content: string): Map<string, string> {
  const imports = new Map<string, string>();

  // Find IMPORTS block
  const clause = findImportsClause(content);
  if (!clause) return imports;

  const importsBlock = clause.body;

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
 * Whether every double quote in the text is matched by a closing one.
 *
 * The scanners below track string literals so that MIB text is not mistaken
 * for syntax. A file with an odd number of quotes would leave them stuck
 * inside a string for the rest of the file, so they fall back to the older,
 * quote-blind behaviour instead - a malformed file should parse no worse
 * than it did before.
 */
function hasBalancedQuotes(content: string): boolean {
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 34 /* " */) count++;
  }
  return count % 2 === 0;
}

/**
 * Remove comments
 *
 * Per RFC 2578 a comment starts at `--` and ends at the next `--` or at the end
 * of the line, whichever comes first - so `SYNTAX INTEGER -- seconds -- (0..60)`
 * is a type with a comment in the middle of it, not a type with its constraint
 * commented away.
 *
 * Two things that look like comment markers are not treated as a closing pair:
 *
 * - `--` inside a quoted string. DESCRIPTION text regularly contains one,
 *   either as a dash in prose or as a row of them drawing a table, and cutting
 *   the line there would take the closing quote with it and swallow the rest of
 *   the definition.
 * - A run of three or more hyphens, which opens a comment that runs to the end
 *   of the line. Strict ASN.1 would pair the hyphens off two at a time and read
 *   whatever follows as code - which turns `---- someObject OBJECT-TYPE`, the
 *   ordinary way of commenting a block out, back into a definition, and leaves
 *   the text of a `-------- Section --------` banner in the token stream.
 */
function removeComments(content: string): string {
  if (!hasBalancedQuotes(content)) {
    // Unbalanced quotes: strip comments the old way rather than treat the
    // remainder of the file as one long string
    return content.replace(/--[^\n]*/g, '');
  }

  let result = '';
  let copiedFrom = 0;
  let inString = false;

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);

    if (inString) {
      if (code === 34 /* " */) inString = false;
      continue;
    }

    if (code === 34 /* " */) {
      inString = true;
      continue;
    }

    if (code === 45 /* - */ && content.charCodeAt(i + 1) === 45) {
      let lineEnd = content.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = content.length;

      // A run of three or more hyphens comments out the rest of the line
      let hyphens = 2;
      while (content.charCodeAt(i + hyphens) === 45) hyphens++;

      let end = lineEnd;
      if (hyphens === 2) {
        // Closing pair, if there is one before the line ends
        const closing = content.indexOf('--', i + 2);
        if (closing !== -1 && closing < lineEnd) {
          end = closing + 2;
        }
      }

      result += content.slice(copiedFrom, i);
      copiedFrom = end;
      // The newline is kept when the comment ran to the end of the line
      i = end - 1;
    }
  }

  return copiedFrom === 0 ? content : result + content.slice(copiedFrom);
}

/**
 * Locate the module's IMPORTS clause: the keyword through the semicolon that
 * ends it.
 *
 * The keyword is matched case-sensitively and only at the start of a line, so
 * that the word "imports" in a DESCRIPTION is not mistaken for the clause -
 * which used to delete everything from that description to the next semicolon,
 * silently dropping whatever objects were defined in between.
 */
function findImportsClause(content: string): { start: number; end: number; body: string } | null {
  const match = /^[ \t]*IMPORTS\b/m.exec(content);
  if (!match) return null;

  const bodyStart = match.index + match[0].length;
  const semicolon = content.indexOf(';', bodyStart);
  if (semicolon === -1) return null;

  return {
    start: match.index,
    end: semicolon + 1,
    body: content.slice(bodyStart, semicolon),
  };
}

/**
 * Remove the IMPORTS clause so its identifiers are not read as definitions
 */
function removeImportsClause(content: string): string {
  const clause = findImportsClause(content);
  if (!clause) return content;
  return content.slice(0, clause.start) + content.slice(clause.end);
}

/**
 * Cheap pre-check before running one of the expensive block patterns.
 * Those patterns scan the whole file with a lazy `[\s\S]*?`, so skipping the
 * ones whose keyword does not appear at all saves a full scan each.
 */
function containsKeyword(content: string, keyword: RegExp): boolean {
  return keyword.test(content);
}

// Keyword pre-checks (kept non-global so `test` has no lastIndex state)
const HAS_MODULE_IDENTITY = /MODULE-IDENTITY/i;
const HAS_OBJECT_IDENTITY = /OBJECT-IDENTITY/i;
const HAS_NOTIFICATION_TYPE = /NOTIFICATION-TYPE/i;
const HAS_MODULE_COMPLIANCE = /MODULE-COMPLIANCE/i;
const HAS_OBJECT_GROUP = /OBJECT-GROUP/i;
const HAS_NOTIFICATION_GROUP = /NOTIFICATION-GROUP/i;
const HAS_TEXTUAL_CONVENTION = /TEXTUAL-CONVENTION/i;
const HAS_TRAP_TYPE = /TRAP-TYPE/i;

/**
 * Extract OBJECT-TYPE definitions
 */
function extractObjectTypes(content: string): string[] {
  const objectTypes: string[] = [];

  // OBJECT-TYPE blocks can contain nested braces (e.g., INDEX { ifIndex })
  // We need to carefully track braces to handle nested structures.
  // Braces inside a quoted string are not syntax - a DESCRIPTION reading
  // "set to { 1 } to enable" is common, and a lone brace in one would
  // otherwise leave the block open and swallow every definition after it.
  const trackStrings = hasBalancedQuotes(content);
  const lines = content.split('\n');
  let currentBlock = '';
  let inObjectType = false;
  let sawAssignment = false;
  let braceOpened = false;
  let braceDepth = 0;
  let inString = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for start of new OBJECT-TYPE (only when not already in one, and
    // not in the middle of a string literal)
    if (!inObjectType && !inString && /^\s*\w+\s+OBJECT-TYPE/i.test(line)) {
      inObjectType = true;
      sawAssignment = false;
      braceOpened = false;
      braceDepth = 0;
      currentBlock = line + '\n';
    } else if (inObjectType) {
      currentBlock += line + '\n';
    }

    // Walk the line once, tracking string state and - inside a block - the
    // brace depth and the ::= assignment
    // (charCodeAt instead of iterating the string: this runs over every line
    // of every file)
    for (let c = 0; c < line.length; c++) {
      const code = line.charCodeAt(c);

      if (trackStrings) {
        if (inString) {
          if (code === 34 /* " */) inString = false;
          continue;
        }
        if (code === 34 /* " */) {
          inString = true;
          continue;
        }
      }

      if (!inObjectType) continue;

      if (code === 123 /* { */) {
        braceDepth++;
        if (sawAssignment) braceOpened = true;
      } else if (code === 125 /* } */) {
        braceDepth--;
      } else if (
        code === 58 /* : */ &&
        line.charCodeAt(c + 1) === 58 &&
        line.charCodeAt(c + 2) === 61 /* = */
      ) {
        // ::= - the OID assignment. Its brace may be on a later line, so the
        // block only ends once that brace has opened and closed again.
        sawAssignment = true;
        c += 2;
      }
    }

    // If the assignment's braces are balanced again, we're done
    if (inObjectType && sawAssignment && braceOpened && braceDepth === 0) {
      objectTypes.push(currentBlock.trim());
      inObjectType = false;
      currentBlock = '';
      sawAssignment = false;
      braceOpened = false;
    }
  }

  return objectTypes;
}

/**
 * The clauses that can follow SYNTAX in an OBJECT-TYPE or a TEXTUAL-CONVENTION.
 * Sticky, so it is tested at one position rather than searched for.
 */
const SYNTAX_TERMINATOR = /(?:UNITS|MAX-ACCESS|ACCESS|STATUS|DESCRIPTION|REFERENCE|DISPLAY-HINT|INDEX|AUGMENTS|DEFVAL|::=)\b/iy;

/**
 * Extract the SYNTAX clause of a definition.
 *
 * The clause ends at the next clause keyword, but only one that is not inside
 * the type itself: an enumeration is free to label a value `status(2)` or
 * `description(4)`, and a size constraint is written with parentheses and dots.
 * So the scan tracks brace, parenthesis and string depth, and only treats a
 * keyword at depth 0 as the end.
 *
 * @param content An OBJECT-TYPE block or a TEXTUAL-CONVENTION body
 * @returns The clause with its whitespace collapsed, or '' when there is none
 */
function extractSyntaxClause(content: string): string {
  const keyword = content.match(/\bSYNTAX\b/i);
  if (!keyword || keyword.index === undefined) return '';

  const start = keyword.index + keyword[0].length;
  let depth = 0;
  let inString = false;
  let end = content.length;

  for (let i = start; i < content.length; i++) {
    const code = content.charCodeAt(i);

    if (inString) {
      if (code === 34 /* " */) inString = false;
      continue;
    }

    if (code === 34 /* " */) {
      inString = true;
    } else if (code === 123 /* { */ || code === 40 /* ( */) {
      depth++;
    } else if (code === 125 /* } */ || code === 41 /* ) */) {
      if (depth > 0) depth--;
    } else if (depth === 0 && i > start) {
      // A clause keyword only ends the SYNTAX if it starts a word
      const previous = content.charCodeAt(i - 1);
      const isWordStart = previous === 32 || previous === 9 || previous === 10 || previous === 13;
      if (!isWordStart) continue;

      SYNTAX_TERMINATOR.lastIndex = i;
      if (SYNTAX_TERMINATOR.test(content)) {
        end = i;
        break;
      }
    }
  }

  return content.slice(start, end).trim().replace(/\s+/g, ' ');
}

/**
 * Split a SYNTAX clause into its base type and the values it constrains
 *
 * `INTEGER { up(1), down(2) }` gives the type `INTEGER` and two enumerated
 * values; `Integer32 (0..65535)` gives the type `Integer32` and a range.
 * @param syntaxRaw A SYNTAX clause as written in the MIB
 */
export function parseSyntaxValues(syntaxRaw: string): {
  syntax: string;
  enumValues?: Array<{ name: string; value: number }>;
  ranges?: Array<{ min: number; max: number }>;
} {
  let syntax = syntaxRaw.trim();
  let enumValues: Array<{ name: string; value: number }> | undefined;
  let ranges: Array<{ min: number; max: number }> | undefined;

  // Enumerated values: INTEGER { name(value), ... }, and BITS the same way
  const enumMatch = syntax.match(/(\w+(?:\s+\w+)*)\s*\{([^}]+)\}/);
  if (enumMatch) {
    const values: Array<{ name: string; value: number }> = [];
    const enumPattern = /([\w\-]+)\s*\(\s*(-?\d+)\s*\)/g;
    let enumItem;
    while ((enumItem = enumPattern.exec(enumMatch[2])) !== null) {
      values.push({ name: enumItem[1], value: parseInt(enumItem[2], 10) });
    }
    if (values.length > 0) {
      syntax = enumMatch[1].trim();
      enumValues = values;
    }
  }

  // Size or range constraint: (SIZE (min..max)) or (min..max)
  const rangeMatch = syntax.match(/\(\s*(?:SIZE\s*\()?\s*(\d+)\s*\.\.\s*(\d+)\s*\)?\s*\)/i);
  if (rangeMatch) {
    ranges = [{ min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) }];
    syntax = syntax.replace(/\s*\(.*\)\s*$/, '').trim();
  }

  return { syntax, enumValues, ranges };
}

/**
 * Extract TEXTUAL-CONVENTION definitions from MIB content
 */
function extractTextualConventions(content: string): import('../types/mib').TextualConvention[] {
  const conventions: import('../types/mib').TextualConvention[] = [];

  // Most MIB modules define no TEXTUAL-CONVENTIONs; skip the scan entirely
  if (!containsKeyword(content, HAS_TEXTUAL_CONVENTION)) return conventions;

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
    const syntaxRaw = extractSyntaxClause(body);
    if (!syntaxRaw) continue;

    const { syntax, enumValues, ranges } = parseSyntaxValues(syntaxRaw);

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
 * Escape regex metacharacters in a user-supplied search string
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Filter tree to the nodes a predicate accepts, plus their ancestors
 * @param tree MIB tree
 * @param matches Predicate deciding whether a node is kept on its own merit
 * @returns Filtered tree
 */
function filterTreeBy(tree: MibNode[], matches: (node: MibNode) => boolean): MibNode[] {
  // Single bottom-up pass: each node is visited exactly once.
  // Returns a copy of the node if it matches or has a matching descendant.
  // The children array is only allocated once a child is actually kept.
  function filterNode(node: MibNode): MibNode | null {
    let filteredChildren: MibNode[] | null = null;

    for (const child of node.children) {
      const filteredChild = filterNode(child);
      if (filteredChild) {
        if (!filteredChildren) filteredChildren = [];
        filteredChildren.push(filteredChild);
      }
    }

    if (!filteredChildren && !matches(node)) {
      return null;
    }

    return { ...node, children: filteredChildren ?? [] };
  }

  const result: MibNode[] = [];
  for (const node of tree) {
    const filtered = filterNode(node);
    if (filtered) result.push(filtered);
  }

  return result;
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

  // Descriptions are long, so they are matched with a case-insensitive regex
  // instead of lower-casing a copy of every description in the tree.
  const descriptionPattern = new RegExp(escapeRegExp(query), 'i');

  function matchesSelf(node: MibNode): boolean {
    return (
      node.name.toLowerCase().includes(lowerQuery) ||
      node.oid.includes(query) ||
      (node.description !== '' && descriptionPattern.test(node.description))
    );
  }

  return filterTreeBy(tree, matchesSelf);
}

/**
 * Whether a node is an SNMP notification - a trap or an inform.
 * These are the NOTIFICATION-TYPE definitions of SMIv2 and the TRAP-TYPE
 * definitions of SMIv1.
 * @param node MIB node
 */
export function isNotificationNode(node: MibNode): boolean {
  const type = node.type.toUpperCase();
  return type === 'NOTIFICATION-TYPE' || type === 'TRAP-TYPE';
}

/**
 * Filter tree to show only notifications (traps/informs) and their ancestors
 * @param tree MIB tree
 * @returns Filtered tree
 */
export function filterTreeToNotifications(tree: MibNode[]): MibNode[] {
  return filterTreeBy(tree, isNotificationNode);
}

/**
 * Find a node by its OID.
 *
 * Descends one level per sub-identifier rather than scanning the whole tree.
 * An OID with no node of its own - an intermediate sub-identifier of a
 * multi-subid assignment - is skipped without leaving the level, the same way
 * the breadcrumb walks it.
 *
 * @param tree MIB tree
 * @param oid OID to look for
 * @param name Preferred name, when two modules landed on the same OID
 * @returns The node, or null if the tree has nothing at that OID
 */
export function findNodeByOid(tree: MibNode[], oid: string, name?: string): MibNode | null {
  const parts = oid.split('.').filter(Boolean);
  if (parts.length === 0) return null;

  let level = tree;

  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join('.');
    const isTarget = i === parts.length - 1;

    let chosen: MibNode | null = null;
    for (const node of level) {
      if (node.oid !== prefix) continue;
      // Prefer the node the caller asked for; otherwise the first at this OID
      if (isTarget && name !== undefined && node.name !== name) {
        chosen = chosen ?? node;
        continue;
      }
      chosen = node;
      break;
    }

    if (!chosen) continue; // No node at this sub-identifier - stay at this level
    if (isTarget) return chosen;
    level = chosen.children;
  }

  return null;
}

/**
 * Count all nodes in a tree
 * @param tree MIB tree
 * @param matches Optional predicate; only the nodes it accepts are counted
 * @returns Total node count
 */
export function countTreeNodes(tree: MibNode[], matches?: (node: MibNode) => boolean): number {
  let count = 0;

  const stack: MibNode[] = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!matches || matches(node)) count++;
    for (const child of node.children) {
      stack.push(child);
    }
  }

  return count;
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
  const cleanedContent = removeComments(content);
  const mibName = extractMibNameFromCleaned(cleanedContent) || 'UNKNOWN';

  // Extract IMPORTS before removing IMPORTS block
  const imports = extractImports(cleanedContent);

  // Convert Map<identifier, sourceMib> to Map<identifier, sourceMib> for ParsedModule
  const importsMap = new Map(
    Array.from(imports.entries()).map(([identifier, sourceMib]) => [identifier, sourceMib])
  );

  // Remove IMPORTS block to prevent parsing interference
  const cleanedWithoutImports = removeImportsClause(cleanedContent);

  // Extract OID assignments (OBJECT IDENTIFIER, MODULE-IDENTITY, OBJECT-IDENTITY)
  // Pass empty map to prevent OID resolution
  const oidAssignments = extractOidAssignmentsRaw(cleanedWithoutImports);

  // Extract OBJECT-TYPE definitions
  const objectTypes = extractObjectTypes(cleanedWithoutImports);

  const objects: import('../types/mib').RawMibObject[] = [];

  // Add OID assignments (OBJECT IDENTIFIER, MODULE-IDENTITY, OBJECT-IDENTITY, NOTIFICATION-TYPE)
  oidAssignments.forEach(({ name, parent, subids, description, type, status, variables }) => {
    objects.push({
      name,
      parentName: parent,
      subid: subids.length === 1 ? subids[0] : subids,
      type: type || 'OBJECT IDENTIFIER',
      description,
      status,
      variables,
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

  // Add SMIv1 TRAP-TYPEs
  extractTrapTypes(cleanedWithoutImports).forEach(trap => {
    objects.push({
      ...trap,
      fileName,
    });
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
): Array<{ name: string; parent: string; subids: number[]; description?: string; type?: string; status?: string; variables?: string[] }> {
  const assignments: Array<{ name: string; parent: string; subids: number[]; description?: string; type?: string; status?: string; variables?: string[] }> = [];

  // Skip whole-file scans for constructs this module does not use at all
  const hasModuleIdentity = containsKeyword(content, HAS_MODULE_IDENTITY);
  const hasObjectIdentity = containsKeyword(content, HAS_OBJECT_IDENTITY);
  const hasNotificationType = containsKeyword(content, HAS_NOTIFICATION_TYPE);
  const hasModuleCompliance = containsKeyword(content, HAS_MODULE_COMPLIANCE);
  const hasObjectGroup = containsKeyword(content, HAS_OBJECT_GROUP);
  const hasNotificationGroup = containsKeyword(content, HAS_NOTIFICATION_GROUP);

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
  const pattern2 = /^[ \t]*(\w+)\s+MODULE-IDENTITY[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while (hasModuleIdentity && (match = pattern2.exec(content)) !== null) {
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
  const pattern3 = /^[ \t]*(\w+)\s+OBJECT-IDENTITY[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while (hasObjectIdentity && (match = pattern3.exec(content)) !== null) {
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
  const pattern4 = /^[ \t]*(\w+)\s+NOTIFICATION-TYPE[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while (hasNotificationType && (match = pattern4.exec(content)) !== null) {
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

    // The OBJECTS clause lists the varbinds the notification carries
    const variables = parseNameList(fullMatch.match(/\bOBJECTS\s*\{([^}]*)\}/i)?.[1]);

    assignments.push({
      name,
      parent: parsed.parent,
      subids: parsed.subids,
      description,
      type: 'NOTIFICATION-TYPE',
      status,
      variables,
    });
  }

  // Pattern 5: identifier MODULE-COMPLIANCE ... ::= { ... }
  const pattern5 = /^[ \t]*(\w+)\s+MODULE-COMPLIANCE[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while (hasModuleCompliance && (match = pattern5.exec(content)) !== null) {
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
  const pattern6 = /^[ \t]*(\w+)\s+OBJECT-GROUP[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while (hasObjectGroup && (match = pattern6.exec(content)) !== null) {
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
  const pattern7 = /^[ \t]*(\w+)\s+NOTIFICATION-GROUP[\s\S]*?::=\s*(\{[^}]+\})/gim;

  while (hasNotificationGroup && (match = pattern7.exec(content)) !== null) {
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
 * Split a brace list of identifiers - `{ ifIndex, ifAdminStatus }` - into names
 * @param inner The text between the braces, or undefined when there was no clause
 */
function parseNameList(inner: string | undefined): string[] | undefined {
  if (!inner) return undefined;

  const names = inner
    .split(',')
    .map(name => name.trim())
    .filter(name => /^[\w\-]+$/.test(name));

  return names.length > 0 ? names : undefined;
}

/**
 * Find the specific-trap number a TRAP-TYPE block is assigned, skipping any
 * `::=` that appears inside a DESCRIPTION or other string literal
 * @returns The number and where the assignment starts, or null if the block
 *          has no bare numeric assignment
 */
function findTrapValue(
  block: string,
  trackStrings: boolean
): { value: number; index: number } | null {
  let inString = false;

  for (let i = 0; i < block.length; i++) {
    const code = block.charCodeAt(i);

    if (trackStrings) {
      if (inString) {
        if (code === 34 /* " */) inString = false;
        continue;
      }
      if (code === 34 /* " */) {
        inString = true;
        continue;
      }
    }

    if (code !== 58 /* : */) continue;
    if (block.charCodeAt(i + 1) !== 58 || block.charCodeAt(i + 2) !== 61 /* = */) continue;

    const value = block.slice(i + 3).match(/^\s*(\d+)/);
    return value ? { value: parseInt(value[1], 10), index: i } : null;
  }

  return null;
}

/**
 * Extract SMIv1 TRAP-TYPE definitions (RFC 1215).
 *
 * These predate NOTIFICATION-TYPE and are still how most enterprise MIBs
 * declare their traps:
 *
 *   linkDown TRAP-TYPE
 *       ENTERPRISE  acmeProducts
 *       VARIABLES   { ifIndex, ifOperStatus }
 *       DESCRIPTION "..."
 *       ::= 3
 *
 * The value is a bare specific-trap number rather than an OID, so the node is
 * placed the way RFC 3584 section 3.1 maps a trap onto an OID: under the
 * ENTERPRISE node, through a `0` sub-identifier - `acmeProducts.0.3`. (The one
 * exception in that mapping, ENTERPRISE `snmp` for the six generic traps of
 * RFC 1215, is not applied: those live at a fixed OID under `snmpTraps`, which
 * a module declaring its own traps never refers to.)
 */
function extractTrapTypes(content: string): import('../types/mib').RawMibObject[] {
  const traps: import('../types/mib').RawMibObject[] = [];

  if (!containsKeyword(content, HAS_TRAP_TYPE)) return traps;

  // Each definition runs from its own header line to the next one (or to the
  // end of the file), so a malformed block cannot swallow the trap after it.
  const header = /^[ \t]*(\w+)[ \t]+TRAP-TYPE\b/gim;
  const starts: Array<{ name: string; index: number }> = [];

  let match;
  while ((match = header.exec(content)) !== null) {
    starts.push({ name: match[1], index: match.index });
  }

  // A DESCRIPTION explaining syntax can contain a `::=` of its own, so the
  // assignment is only looked for outside string literals - unless the quotes
  // in the file do not pair up, in which case tracking them would be worse
  // than ignoring them.
  const trackStrings = hasBalancedQuotes(content);

  for (let i = 0; i < starts.length; i++) {
    const { name, index } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : content.length;
    const block = content.slice(index, end);

    // ::= <specific-trap number>. A TRAP-TYPE has no braces around its value;
    // anything that does is some other construct and is left alone.
    const assignment = findTrapValue(block, trackStrings);
    if (!assignment) continue;

    // The clauses end at the assignment. The slice above runs to the next
    // TRAP-TYPE, so whatever definitions follow this one are in it too - and
    // their DESCRIPTION and STATUS are not this trap's.
    const clauses = block.slice(0, assignment.index);

    const enterpriseMatch = clauses.match(/\bENTERPRISE\s+([\w\-]+)/i);
    if (!enterpriseMatch) continue; // Nothing to hang the trap off

    const descMatch = clauses.match(/DESCRIPTION\s+"([\s\S]*?)"/i);
    const statusMatch = clauses.match(/\bSTATUS\s+([\w\-]+)/i);

    traps.push({
      name,
      parentName: enterpriseMatch[1],
      subid: [0, assignment.value],
      type: 'TRAP-TYPE',
      description: descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '',
      // STATUS is not part of the RFC 1215 macro, but vendor MIBs add it
      status: statusMatch ? statusMatch[1].trim() : '',
      variables: parseNameList(clauses.match(/\bVARIABLES\s*\{([^}]*)\}/i)?.[1]),
    });
  }

  return traps;
}

/**
 * Parse OBJECT-TYPE definition in raw format (without OID resolution)
 * Returns parent name and SubID as-is
 */
function parseObjectTypeRaw(content: string): import('../types/mib').RawMibObject | null {
  const nameMatch = content.match(/^(\w+)\s+OBJECT-TYPE/);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  // Extract SYNTAX. Kept whole - an enumeration or a size constraint is part
  // of the type, and the details panel reads the values back out of it.
  const syntax = extractSyntaxClause(content);

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
