import { describe, test, expect } from 'bun:test';
import {
  validateMibContent,
  parseMibModule,
  filterTreeByQuery,
  countTreeNodes,
  flattenTree,
} from '../src/lib/mib-parser';
import { MibTreeBuilder } from '../src/lib/mib-tree-builder';
import type { MibNode } from '../src/types/mib';

const MINIMAL = `MIN-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
minRoot OBJECT IDENTIFIER ::= { enterprises 4242 }
minLeaf OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "leaf"
    ::= { minRoot 1 }
END`;

describe('validateMibContent', () => {
  test('accepts an ordinary module', () => {
    expect(validateMibContent(MINIMAL).isValid).toBe(true);
  });

  // Regression: IPV6-TC (RFC 2465) defines nothing but textual conventions.
  // Rejecting it stopped a dependency of other modules from being loaded.
  test('accepts a module that defines only TEXTUAL-CONVENTIONs', () => {
    const content = `TC-ONLY-MIB DEFINITIONS ::= BEGIN
IMPORTS TEXTUAL-CONVENTION FROM SNMPv2-TC;
SomeType ::= TEXTUAL-CONVENTION
    STATUS      current
    DESCRIPTION "a type"
    SYNTAX      OCTET STRING (SIZE (6))
END`;
    expect(validateMibContent(content).isValid).toBe(true);
  });

  // Regression: RFC-1212 ships with its whole body commented out, so after
  // comment stripping it defines nothing at all. It is still a valid module.
  test('accepts a module whose body is entirely commented out', () => {
    const content = `RFC-1212 DEFINITIONS ::= BEGIN
--  OBJECT-TYPE MACRO ::=
--  BEGIN
--      TYPE NOTATION ::= "SYNTAX" type(ObjectSyntax)
--  END
END`;
    expect(validateMibContent(content).isValid).toBe(true);
  });

  test.each([
    ['plain text', 'hello world, not a mib at all'],
    ['json', '{"name":"foo","values":[1,2,3]}'],
    ['html mentioning the keywords', '<html><body>OBJECT-TYPE BEGIN END</body></html>'],
    ['a module header with no END', 'FOO-MIB DEFINITIONS ::= BEGIN\nfoo OBJECT IDENTIFIER ::= { iso 1 }'],
    ['an empty file', ''],
  ])('rejects %s', (_label, content) => {
    expect(validateMibContent(content).isValid).toBe(false);
  });

  // The header only appears inside a comment, so this is not a module
  test('rejects a file whose module header is commented out', () => {
    expect(validateMibContent('-- FOO-MIB DEFINITIONS ::= BEGIN\n-- END').isValid).toBe(false);
  });

  test('reports why a file was rejected', () => {
    const result = validateMibContent('nothing here');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('module definition');
  });
});

describe('parseMibModule: module name', () => {
  test('reads the name from a plain header', () => {
    expect(parseMibModule(MINIMAL, 'MIN-MIB.txt').moduleName).toBe('MIN-MIB');
  });

  // Regression: FROGFOOT-RESOURCES-MIB puts a comment between the name and
  // DEFINITIONS. Matching against the raw text missed it, and the module was
  // labelled UNKNOWN even when it parsed.
  test('reads the name across comments and blank lines', () => {
    const content = `FROGFOOT-RESOURCES-MIB

-- -*- mib -*-

DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
frogfoot OBJECT IDENTIFIER ::= { enterprises 10002 }
END`;
    expect(parseMibModule(content, 'f.txt').moduleName).toBe('FROGFOOT-RESOURCES-MIB');
  });

  test.each([
    ['IMPLICIT TAGS', 'FOO-MIB DEFINITIONS IMPLICIT TAGS ::= BEGIN\nEND'],
    ['EXPLICIT TAGS', 'FOO-MIB DEFINITIONS EXPLICIT TAGS ::= BEGIN\nEND'],
    ['AUTOMATIC TAGS', 'FOO-MIB DEFINITIONS AUTOMATIC TAGS ::= BEGIN\nEND'],
    ['EXTENSIBILITY IMPLIED', 'FOO-MIB DEFINITIONS AUTOMATIC TAGS EXTENSIBILITY IMPLIED ::= BEGIN\nEND'],
  ])('reads the name through an ASN.1 tagging clause: %s', (_label, content) => {
    expect(parseMibModule(content, 'f.txt').moduleName).toBe('FOO-MIB');
    expect(validateMibContent(content).isValid).toBe(true);
  });

  // The header pattern once used `[^;]*?` to skip to `::=`, which made a
  // failed match quadratic in file length - on a file the user supplies.
  test('the header match stays linear on input that never matches', () => {
    const timeFor = (lines: number) => {
      const input = 'A DEFINITIONS x\n'.repeat(lines);
      const start = performance.now();
      validateMibContent(input);
      return performance.now() - start;
    };

    timeFor(4000); // warm up
    const small = Math.max(timeFor(8000), 0.05);
    const large = timeFor(32000);

    // 4x the input. Linear would be ~4x; quadratic would be ~16x.
    expect(large / small).toBeLessThan(8);
  });
});

describe('parseMibModule: contents', () => {
  test('extracts objects with their SYNTAX, ACCESS and STATUS', () => {
    const parsed = parseMibModule(MINIMAL, 'MIN-MIB.txt');
    const leaf = parsed.objects.find(o => o.name === 'minLeaf');

    expect(leaf).toBeDefined();
    expect(leaf!.parentName).toBe('minRoot');
    expect(leaf!.subid).toBe(1);
    expect(leaf!.syntax).toBe('INTEGER');
    expect(leaf!.access).toBe('read-only');
    expect(leaf!.status).toBe('current');
  });

  test('records IMPORTS as symbol -> source module', () => {
    const parsed = parseMibModule(MINIMAL, 'MIN-MIB.txt');
    expect(parsed.imports.get('enterprises')).toBe('SNMPv2-SMI');
  });

  test('extracts TEXTUAL-CONVENTION enumerations', () => {
    const content = `TC-MIB DEFINITIONS ::= BEGIN
IMPORTS TEXTUAL-CONVENTION FROM SNMPv2-TC;
PortState ::= TEXTUAL-CONVENTION
    STATUS      current
    DESCRIPTION "State of a port."
    SYNTAX      INTEGER { up(1), down(2), testing(3) }
END`;
    const tc = parseMibModule(content, 'tc.txt').textualConventions?.[0];

    expect(tc?.name).toBe('PortState');
    expect(tc?.enumValues).toEqual([
      { name: 'up', value: 1 },
      { name: 'down', value: 2 },
      { name: 'testing', value: 3 },
    ]);
  });

  test('a module that defines nothing parses to no objects', () => {
    const parsed = parseMibModule('EMPTY-MIB DEFINITIONS ::= BEGIN\n-- all commented\nEND', 'e.txt');
    expect(parsed.moduleName).toBe('EMPTY-MIB');
    expect(parsed.objects).toHaveLength(0);
  });

  test('does not modify the content it is given', () => {
    const before = MINIMAL;
    parseMibModule(MINIMAL, 'MIN-MIB.txt');
    expect(MINIMAL).toBe(before);
  });
});

describe('filterTreeByQuery', () => {
  const tree = new MibTreeBuilder().buildTree([
    parseMibModule(
      `SEARCH-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
searchRoot OBJECT IDENTIFIER ::= { enterprises 5150 }
alpha OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "the first one"
    ::= { searchRoot 1 }
beta OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "the second one"
    ::= { searchRoot 2 }
END`,
      'search.txt'
    ),
  ]);

  const names = (nodes: MibNode[]) => flattenTree(nodes).map(n => n.name);

  test('returns the tree unchanged for an empty query', () => {
    expect(filterTreeByQuery(tree, '')).toBe(tree);
  });

  test('keeps a match and its ancestors, and drops everything else', () => {
    const result = names(filterTreeByQuery(tree, 'alpha'));
    expect(result).toContain('alpha');
    expect(result).toContain('searchRoot');
    expect(result).toContain('iso');
    expect(result).not.toContain('beta');
  });

  test('matches on OID and on description as well as name', () => {
    expect(names(filterTreeByQuery(tree, '5150.2'))).toContain('beta');
    expect(names(filterTreeByQuery(tree, 'the second'))).toContain('beta');
  });

  test('is case-insensitive on names and descriptions', () => {
    expect(names(filterTreeByQuery(tree, 'ALPHA'))).toContain('alpha');
    expect(names(filterTreeByQuery(tree, 'THE FIRST'))).toContain('alpha');
  });

  test('returns nothing when there is no match', () => {
    expect(filterTreeByQuery(tree, 'zzzz-no-such-thing')).toHaveLength(0);
  });

  // The query goes into a RegExp for description matching, so metacharacters
  // must be escaped rather than interpreted. `.` legitimately matches every
  // OID; `[a-z]` and `.*` must match nothing.
  test.each(['.', '(', '[a-z]', '*', '\\', '.*', '+', '$'])('treats %p as a literal', query => {
    const lower = query.toLowerCase();
    const literalMatches = flattenTree(tree).filter(node =>
      node.name.toLowerCase().includes(lower) ||
      node.oid.includes(query) ||
      node.description.toLowerCase().includes(lower)
    );

    let result: MibNode[] = [];
    expect(() => { result = filterTreeByQuery(tree, query); }).not.toThrow();
    const kept = names(result);

    // Everything matching the query as a plain substring is kept
    for (const node of literalMatches) expect(kept).toContain(node.name);

    // ...and if nothing matches literally, nothing is kept - a query read as a
    // regex would have matched here
    if (literalMatches.length === 0) expect(result).toHaveLength(0);
  });

  test('does not modify the tree it filters', () => {
    const before = countTreeNodes(tree);
    filterTreeByQuery(tree, 'alpha');
    expect(countTreeNodes(tree)).toBe(before);
  });
});

describe('countTreeNodes', () => {
  test('counts every node, not just the roots', () => {
    const tree: MibNode[] = [
      { oid: '1', name: 'a', parent: null, type: '', syntax: '', access: '', status: '', description: '',
        children: [
          { oid: '1.1', name: 'b', parent: '1', type: '', syntax: '', access: '', status: '', description: '', children: [] },
          { oid: '1.2', name: 'c', parent: '1', type: '', syntax: '', access: '', status: '', description: '',
            children: [
              { oid: '1.2.1', name: 'd', parent: '1.2', type: '', syntax: '', access: '', status: '', description: '', children: [] },
            ] },
        ] },
    ];

    expect(countTreeNodes(tree)).toBe(4);
    expect(countTreeNodes([])).toBe(0);
  });

  test('agrees with flattenTree', () => {
    const tree = new MibTreeBuilder().buildTree([parseMibModule(MINIMAL, 'MIN-MIB.txt')]);
    expect(countTreeNodes(tree)).toBe(flattenTree(tree).length);
  });
});
