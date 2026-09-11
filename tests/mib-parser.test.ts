import { describe, test, expect } from 'bun:test';
import {
  validateMibContent,
  parseSyntaxValues,
  parseMibModule,
  filterTreeByQuery,
  filterTreeToNotifications,
  isNotificationNode,
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

describe('parseMibModule: MIB text is not mistaken for syntax', () => {
  const withDescription = (description: string) => `TXT-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
txtRoot OBJECT IDENTIFIER ::= { enterprises 4243 }
txtOne OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION ${description}
    ::= { txtRoot 1 }
txtTwo OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "second"
    ::= { txtRoot 2 }
END`;

  // Regression: `--` starts a comment only outside a string. A dash pair in
  // prose used to cut the line short, taking the closing quote with it, and
  // the description was lost.
  test('keeps a description containing a dash pair', () => {
    const parsed = parseMibModule(withDescription('"Counts things -- see RFC 1213 -- for details."'), 't.txt');

    expect(parsed.objects.map(o => o.name)).toContain('txtTwo');
    expect(parsed.objects.find(o => o.name === 'txtOne')!.description)
      .toBe('Counts things -- see RFC 1213 -- for details.');
  });

  // Regression: a row of dashes drawing a table inside a DESCRIPTION is the
  // same bug, and is how real vendor MIBs lay out value tables.
  test('keeps a description containing a rule of dashes', () => {
    const parsed = parseMibModule(
      withDescription('"Format:\n         ------------\n         value | meaning\n         ------------"'),
      't.txt'
    );

    const description = parsed.objects.find(o => o.name === 'txtOne')!.description;
    expect(description).toContain('value | meaning');
    expect(parsed.objects.map(o => o.name)).toContain('txtTwo');
  });

  // Regression: braces in a DESCRIPTION are not the OBJECT-TYPE's braces. A
  // lone one used to leave the block open and swallow every later definition.
  test('keeps objects whose description contains an unbalanced brace', () => {
    const parsed = parseMibModule(withDescription('"Values are wrapped in { braces."'), 't.txt');

    expect(parsed.objects.map(o => o.name)).toEqual(
      expect.arrayContaining(['txtRoot', 'txtOne', 'txtTwo'])
    );
  });

  // Regression: the IMPORTS clause was matched case-insensitively anywhere in
  // the file, so the word "imports" in a description deleted everything from
  // there to the next semicolon - silently dropping the objects in between.
  test('does not treat the word "imports" in a description as the IMPORTS clause', () => {
    // The semicolon that used to end the bogus clause is in a *later*
    // description, so everything defined in between disappeared.
    const content = `IMP-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
impRoot OBJECT IDENTIFIER ::= { enterprises 4246 }
impOne OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "Number of imports processed by the agent."
    ::= { impRoot 1 }
impTwo OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "Second object; note the semicolon."
    ::= { impRoot 2 }
impThree OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "third"
    ::= { impRoot 3 }
END`;
    const parsed = parseMibModule(content, 'imp.txt');

    expect(parsed.objects.map(o => o.name)).toEqual(
      expect.arrayContaining(['impRoot', 'impOne', 'impTwo', 'impThree'])
    );
    expect(parsed.imports.get('enterprises')).toBe('SNMPv2-SMI');
  });

  // A quote inside a comment is not the start of a string: the comment is
  // dropped whole, before any string tracking sees it.
  test('ignores quotes that appear inside a comment', () => {
    const content = `Q-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
qRoot OBJECT IDENTIFIER ::= { enterprises 4244 }
-- the agent reports a "best effort" value
qOne OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "first"
    ::= { qRoot 1 }
END`;
    const parsed = parseMibModule(content, 'q.txt');

    expect(parsed.objects.find(o => o.name === 'qOne')!.description).toBe('first');
  });

  // A file with an odd number of quotes cannot be tracked; it must parse no
  // worse than it did before string tracking existed.
  test('still parses a module with an unbalanced quote', () => {
    const content = `BAD-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
badRoot OBJECT IDENTIFIER ::= { enterprises 4245 }
badOne OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "unterminated
    ::= { badRoot 1 }
END`;
    const parsed = parseMibModule(content, 'bad.txt');

    expect(parsed.moduleName).toBe('BAD-MIB');
    expect(parsed.objects.map(o => o.name)).toContain('badRoot');
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

describe('filterTreeToNotifications', () => {
  const tree = new MibTreeBuilder().buildTree([
    parseMibModule(
      `TRAP-MIB DEFINITIONS ::= BEGIN
IMPORTS NOTIFICATION-TYPE, OBJECT-TYPE, enterprises FROM SNMPv2-SMI;
trapRoot OBJECT IDENTIFIER ::= { enterprises 5151 }
trapObjects OBJECT IDENTIFIER ::= { trapRoot 1 }
plainLeaf OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "not a trap"
    ::= { trapObjects 1 }
trapEvents OBJECT IDENTIFIER ::= { trapRoot 2 }
linkWentDown NOTIFICATION-TYPE
    OBJECTS     { plainLeaf }
    STATUS      current
    DESCRIPTION "a trap"
    ::= { trapEvents 1 }
linkCameBack NOTIFICATION-TYPE
    OBJECTS     { plainLeaf }
    STATUS      current
    DESCRIPTION "another trap"
    ::= { trapEvents 2 }
END`,
      'trap.txt'
    ),
  ]);

  const names = (nodes: MibNode[]) => flattenTree(nodes).map(n => n.name);

  test('recognises NOTIFICATION-TYPE nodes', () => {
    const byName = new Map(flattenTree(tree).map(n => [n.name, n]));
    expect(isNotificationNode(byName.get('linkWentDown')!)).toBe(true);
    expect(isNotificationNode(byName.get('plainLeaf')!)).toBe(false);
    expect(isNotificationNode(byName.get('trapEvents')!)).toBe(false);
  });

  test('keeps notifications and the branches leading to them', () => {
    const kept = names(filterTreeToNotifications(tree));
    expect(kept).toContain('linkWentDown');
    expect(kept).toContain('linkCameBack');
    expect(kept).toContain('trapEvents');
    expect(kept).toContain('trapRoot');
    expect(kept).toContain('iso');
  });

  test('drops branches with no notification under them', () => {
    const kept = names(filterTreeToNotifications(tree));
    expect(kept).not.toContain('plainLeaf');
    expect(kept).not.toContain('trapObjects');
  });

  test('composes with the search filter', () => {
    const kept = names(filterTreeByQuery(filterTreeToNotifications(tree), 'linkWentDown'));
    expect(kept).toContain('linkWentDown');
    expect(kept).not.toContain('linkCameBack');
  });

  test('returns nothing for a tree without notifications', () => {
    const plain = new MibTreeBuilder().buildTree([parseMibModule(MINIMAL, 'MIN-MIB.txt')]);
    expect(filterTreeToNotifications(plain)).toHaveLength(0);
  });

  test('does not modify the tree it filters', () => {
    const before = countTreeNodes(tree);
    filterTreeToNotifications(tree);
    expect(countTreeNodes(tree)).toBe(before);
  });

  test('countTreeNodes counts only the nodes a predicate accepts', () => {
    expect(countTreeNodes(filterTreeToNotifications(tree), isNotificationNode)).toBe(2);
  });
});

describe('SMIv1 TRAP-TYPE', () => {
  const V1_TRAPS = `V1-TRAP-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE, enterprises FROM RFC1155-SMI
        TRAP-TYPE FROM RFC-1215;
v1Root OBJECT IDENTIFIER ::= { enterprises 5252 }
v1Reason OBJECT-TYPE
    SYNTAX      INTEGER
    ACCESS      read-only
    STATUS      mandatory
    DESCRIPTION "why it happened"
    ::= { v1Root 1 }
cardPulled TRAP-TYPE
    ENTERPRISE  v1Root
    VARIABLES   { v1Reason }
    DESCRIPTION "a card was pulled"
    ::= 3
cardPushedBack TRAP-TYPE
    ENTERPRISE  v1Root
    DESCRIPTION "a card came back"
    ::= 4
END`;

  const module = parseMibModule(V1_TRAPS, 'v1-trap.txt');
  const tree = new MibTreeBuilder().buildTree([module]);
  const byName = new Map(flattenTree(tree).map(n => [n.name, n]));

  test('places a trap at enterprise.0.specific', () => {
    // RFC 3584 3.1: the ENTERPRISE node, a 0, then the specific-trap number
    expect(byName.get('cardPulled')!.oid).toBe('1.3.6.1.4.1.5252.0.3');
    expect(byName.get('cardPushedBack')!.oid).toBe('1.3.6.1.4.1.5252.0.4');
  });

  test('keeps the type and the description', () => {
    const trap = byName.get('cardPulled')!;
    expect(trap.type).toBe('TRAP-TYPE');
    expect(trap.description).toBe('a card was pulled');
  });

  test('records the VARIABLES a trap carries', () => {
    expect(byName.get('cardPulled')!.variables).toEqual(['v1Reason']);
    expect(byName.get('cardPushedBack')!.variables).toBeUndefined();
  });

  test('counts as a notification', () => {
    expect(isNotificationNode(byName.get('cardPulled')!)).toBe(true);
    expect(isNotificationNode(byName.get('v1Reason')!)).toBe(false);

    const kept = flattenTree(filterTreeToNotifications(tree)).map(n => n.name);
    expect(kept).toContain('cardPulled');
    expect(kept).toContain('cardPushedBack');
    expect(kept).not.toContain('v1Reason');
  });

  test('leaves the rest of the module alone', () => {
    expect(byName.get('v1Reason')!.oid).toBe('1.3.6.1.4.1.5252.1');
    expect(byName.get('v1Reason')!.access).toBe('read-only');
  });

  test('skips a trap with no ENTERPRISE without losing the next one', () => {
    const parsed = parseMibModule(
      `BROKEN-TRAP-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM RFC1155-SMI TRAP-TYPE FROM RFC-1215;
brokenRoot OBJECT IDENTIFIER ::= { enterprises 5253 }
noEnterprise TRAP-TYPE
    DESCRIPTION "nowhere to hang this"
    ::= 1
stillParsed TRAP-TYPE
    ENTERPRISE  brokenRoot
    DESCRIPTION "reached all the same"
    ::= 2
END`,
      'broken.txt'
    );

    const names = parsed.objects.map(o => o.name);
    expect(names).not.toContain('noEnterprise');
    expect(names).toContain('stillParsed');
  });

  test('reads the assignment, not a ::= inside the DESCRIPTION', () => {
    const parsed = parseMibModule(
      `PROSE-TRAP-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM RFC1155-SMI TRAP-TYPE FROM RFC-1215;
proseRoot OBJECT IDENTIFIER ::= { enterprises 5256 }
fanFailed TRAP-TYPE
    ENTERPRISE  proseRoot
    DESCRIPTION
        "Sent on failure. The older form of this trap was ::= 99, which is
         prose here and not an assignment."
    REFERENCE   "hardware guide"
    ::= 17
laterObject OBJECT-TYPE
    SYNTAX      INTEGER
    ACCESS      read-only
    STATUS      mandatory
    DESCRIPTION "defined after the trap"
    ::= { proseRoot 1 }
END`,
      'prose.txt'
    );

    const trap = parsed.objects.find(o => o.name === 'fanFailed')!;
    expect(trap.subid).toEqual([0, 17]);
  });

  test('does not borrow clauses from the definition that follows it', () => {
    const parsed = parseMibModule(
      `FOLLOWED-TRAP-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM RFC1155-SMI TRAP-TYPE FROM RFC-1215;
followedRoot OBJECT IDENTIFIER ::= { enterprises 5257 }
bareTrap TRAP-TYPE
    ENTERPRISE  followedRoot
    ::= 1
laterObject OBJECT-TYPE
    SYNTAX      INTEGER
    ACCESS      read-only
    STATUS      mandatory
    DESCRIPTION "belongs to the object, not to the trap"
    ::= { followedRoot 1 }
END`,
      'followed.txt'
    );

    const trap = parsed.objects.find(o => o.name === 'bareTrap')!;
    expect(trap.description).toBe('');
    expect(trap.status).toBe('');
    expect(parsed.objects.find(o => o.name === 'laterObject')?.description)
      .toBe('belongs to the object, not to the trap');
  });

  test('ignores a TRAP-TYPE that only appears in the IMPORTS clause', () => {
    const parsed = parseMibModule(
      `IMPORT-ONLY-MIB DEFINITIONS ::= BEGIN
IMPORTS TRAP-TYPE FROM RFC-1215
        enterprises FROM RFC1155-SMI;
importOnlyRoot OBJECT IDENTIFIER ::= { enterprises 5254 }
END`,
      'import-only.txt'
    );

    expect(parsed.objects.map(o => o.type)).not.toContain('TRAP-TYPE');
  });

  test('reports the module a missing ENTERPRISE node comes from', () => {
    const parsed = parseMibModule(
      `DANGLING-TRAP-MIB DEFINITIONS ::= BEGIN
IMPORTS absentAnchor FROM TEST-ABSENT-MIB
        TRAP-TYPE FROM RFC-1215;
dangling TRAP-TYPE
    ENTERPRISE  absentAnchor
    DESCRIPTION "its anchor is not loaded"
    ::= 1
END`,
      'dangling.txt'
    );

    expect(() => new MibTreeBuilder().buildTree([parsed])).toThrow(/TEST-ABSENT-MIB/);
  });
});

describe('NOTIFICATION-TYPE OBJECTS', () => {
  test('records the varbinds a notification carries', () => {
    const parsed = parseMibModule(
      `OBJECTS-MIB DEFINITIONS ::= BEGIN
IMPORTS NOTIFICATION-TYPE, OBJECT-TYPE, enterprises FROM SNMPv2-SMI;
objRoot OBJECT IDENTIFIER ::= { enterprises 5255 }
objReason OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "why"
    ::= { objRoot 1 }
objWhen OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "when"
    ::= { objRoot 2 }
somethingHappened NOTIFICATION-TYPE
    OBJECTS     { objReason, objWhen }
    STATUS      current
    DESCRIPTION "it happened"
    ::= { objRoot 3 }
END`,
      'objects.txt'
    );

    const notification = parsed.objects.find(o => o.name === 'somethingHappened')!;
    expect(notification.variables).toEqual(['objReason', 'objWhen']);
  });
});

describe('SYNTAX clauses', () => {
  const SYNTAX_MIB = `SYNTAX-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE, Integer32, Gauge32, enterprises FROM SNMPv2-SMI
        TEXTUAL-CONVENTION, DisplayString FROM SNMPv2-TC;

SynState ::= TEXTUAL-CONVENTION
    STATUS      current
    DESCRIPTION "A convention whose labels read like clause keywords."
    SYNTAX      INTEGER {
                    status(1),
                    description(2),
                    reference(3)
                }

synRoot OBJECT IDENTIFIER ::= { enterprises 5258 }

synState OBJECT-TYPE
    SYNTAX      INTEGER {
                    up(1),
                    down(2),
                    testing(3)
                }
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "An inline enumeration, spread over several lines."
    ::= { synRoot 1 }

synSize OBJECT-TYPE
    SYNTAX      Integer32 (0..65535)
    UNITS       "bytes"
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "A ranged type."
    ::= { synRoot 2 }

synLabel OBJECT-TYPE
    SYNTAX      DisplayString (SIZE (0..255))
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "A size constraint."
    ::= { synRoot 3 }

synRate OBJECT-TYPE
    SYNTAX      Gauge32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "A plain type."
    ::= { synRoot 4 }

synTable OBJECT-TYPE
    SYNTAX      SEQUENCE OF SynEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "A table."
    ::= { synRoot 5 }

synTricky OBJECT-TYPE
    SYNTAX      INTEGER { status(1), description(2), index(3) }
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "Enumeration labels that read like clause keywords."
    ::= { synRoot 6 }
END`;

  const objects = new Map(parseMibModule(SYNTAX_MIB, 'syntax.txt').objects.map(o => [o.name, o]));

  test.each([
    ['synState', 'INTEGER { up(1), down(2), testing(3) }'],
    ['synSize', 'Integer32 (0..65535)'],
    ['synLabel', 'DisplayString (SIZE (0..255))'],
    ['synRate', 'Gauge32'],
    ['synTable', 'SEQUENCE OF SynEntry'],
    ['synTricky', 'INTEGER { status(1), description(2), index(3) }'],
  ])('%s keeps its whole SYNTAX', (name, syntax) => {
    expect(objects.get(name)?.syntax).toBe(syntax);
  });

  test('the clause after SYNTAX is not swallowed', () => {
    expect(objects.get('synSize')?.access).toBe('read-write');
    expect(objects.get('synState')?.description).toBe('An inline enumeration, spread over several lines.');
  });

  test('a TEXTUAL-CONVENTION enumeration survives keyword-shaped labels', () => {
    const tcs = parseMibModule(SYNTAX_MIB, 'syntax.txt').textualConventions!;
    const state = tcs.find(tc => tc.name === 'SynState')!;
    expect(state.syntax).toBe('INTEGER');
    expect(state.enumValues).toEqual([
      { name: 'status', value: 1 },
      { name: 'description', value: 2 },
      { name: 'reference', value: 3 },
    ]);
  });

  test('parseSyntaxValues splits a type from its values', () => {
    expect(parseSyntaxValues('INTEGER { up(1), down(2) }')).toEqual({
      syntax: 'INTEGER',
      enumValues: [
        { name: 'up', value: 1 },
        { name: 'down', value: 2 },
      ],
      ranges: undefined,
    });

    expect(parseSyntaxValues('Integer32 (0..65535)')).toEqual({
      syntax: 'Integer32',
      enumValues: undefined,
      ranges: [{ min: 0, max: 65535 }],
    });

    expect(parseSyntaxValues('DisplayString (SIZE (0..255))')).toEqual({
      syntax: 'DisplayString',
      enumValues: undefined,
      ranges: [{ min: 0, max: 255 }],
    });

    expect(parseSyntaxValues('Gauge32')).toEqual({
      syntax: 'Gauge32',
      enumValues: undefined,
      ranges: undefined,
    });
  });

  test('negative and hyphenated enumeration entries are read', () => {
    expect(parseSyntaxValues('INTEGER { not-available(-1), ok(0) }').enumValues).toEqual([
      { name: 'not-available', value: -1 },
      { name: 'ok', value: 0 },
    ]);
  });
});
