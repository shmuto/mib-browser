import { describe, test, expect } from 'bun:test';
import { parseMibModule, flattenTree } from '../src/lib/mib-parser';
import { MibTreeBuilder } from '../src/lib/mib-tree-builder';
import type { MibNode, ParsedModule } from '../src/types/mib';

const BASE = `BASE-MIB DEFINITIONS ::= BEGIN
IMPORTS MODULE-IDENTITY, OBJECT-TYPE, enterprises FROM SNMPv2-SMI;
baseMIB MODULE-IDENTITY
    LAST-UPDATED "202601010000Z"
    ORGANIZATION "test"
    CONTACT-INFO "test"
    DESCRIPTION  "base"
    ::= { enterprises 99999 }
anchor OBJECT IDENTIFIER ::= { baseMIB 1 }
baseLeaf OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "a leaf"
    ::= { anchor 1 }
END`;

const EXTENSION = `EXT-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE FROM SNMPv2-SMI  anchor FROM BASE-MIB;
extLeaf OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "hangs off an imported anchor"
    ::= { anchor 2 }
END`;

const parse = (content: string, fileName: string) => parseMibModule(content, fileName);
const build = (modules: ParsedModule[]) => new MibTreeBuilder().buildTree(modules);

const byName = (tree: MibNode[]) => {
  const map = new Map<string, MibNode>();
  for (const node of flattenTree(tree)) map.set(node.name, node);
  return map;
};

describe('OID computation', () => {
  test('computes absolute OIDs down from the seed hierarchy', () => {
    const nodes = byName(build([parse(BASE, 'base.txt')]));

    expect(nodes.get('enterprises')?.oid).toBe('1.3.6.1.4.1');
    expect(nodes.get('baseMIB')?.oid).toBe('1.3.6.1.4.1.99999');
    expect(nodes.get('anchor')?.oid).toBe('1.3.6.1.4.1.99999.1');
    expect(nodes.get('baseLeaf')?.oid).toBe('1.3.6.1.4.1.99999.1.1');
  });

  test('records the parent as the parent OID', () => {
    const nodes = byName(build([parse(BASE, 'base.txt')]));
    expect(nodes.get('baseLeaf')?.parent).toBe('1.3.6.1.4.1.99999.1');
  });

  test('every node reachable from the root has an OID under its parent', () => {
    const tree = build([parse(BASE, 'base.txt'), parse(EXTENSION, 'ext.txt')]);

    const check = (nodes: MibNode[], parentOid: string | null) => {
      for (const node of nodes) {
        expect(node.oid).not.toBe('');
        if (parentOid !== null) expect(node.oid.startsWith(`${parentOid}.`)).toBe(true);
        check(node.children, node.oid);
      }
    };
    check(tree, null);
  });

  test('handles multi sub-identifier assignments', () => {
    const content = `MULTI-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
deep OBJECT IDENTIFIER ::= { enterprises 3011 7124 3282 }
END`;
    const nodes = byName(build([parse(content, 'multi.txt')]));
    expect(nodes.get('deep')?.oid).toBe('1.3.6.1.4.1.3011.7124.3282');
  });

  test('handles the named-number form', () => {
    const content = `NAMED-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
named OBJECT IDENTIFIER ::= { enterprises ieee(111) lan-man-stds(802) 1 }
END`;
    const nodes = byName(build([parse(content, 'named.txt')]));
    expect(nodes.get('named')?.oid).toBe('1.3.6.1.4.1.111.802.1');
  });

  test('the intermediate levels of a multi-subid assignment get no node', () => {
    const content = `MULTI-MIB DEFINITIONS ::= BEGIN
IMPORTS enterprises FROM SNMPv2-SMI;
deep OBJECT IDENTIFIER ::= { enterprises 3011 7124 3282 }
END`;
    const oids = flattenTree(build([parse(content, 'multi.txt')])).map(n => n.oid);
    expect(oids).toContain('1.3.6.1.4.1.3011.7124.3282');
    expect(oids).not.toContain('1.3.6.1.4.1.3011');
  });
});

describe('cross-module resolution', () => {
  test('resolves a parent imported from another module', () => {
    const nodes = byName(build([parse(BASE, 'base.txt'), parse(EXTENSION, 'ext.txt')]));
    expect(nodes.get('extLeaf')?.oid).toBe('1.3.6.1.4.1.99999.1.2');
  });

  test('does not depend on the order the modules are given in', () => {
    const forwards = byName(build([parse(BASE, 'base.txt'), parse(EXTENSION, 'ext.txt')]));
    const backwards = byName(build([parse(EXTENSION, 'ext.txt'), parse(BASE, 'base.txt')]));
    expect(backwards.get('extLeaf')?.oid).toBe(forwards.get('extLeaf')?.oid);
  });

  test('reports the module a missing dependency would come from', () => {
    const content = `ORPHAN-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE FROM SNMPv2-SMI  absentAnchor FROM ABSENT-MIB;
orphan OBJECT IDENTIFIER ::= { absentAnchor 1 }
END`;
    expect(() => build([parse(content, 'orphan.txt')]))
      .toThrow(/Missing MIB dependencies: ABSENT-MIB/);
  });

  test('a module defining nothing contributes no nodes and breaks nothing', () => {
    const empty = parse('EMPTY-MIB DEFINITIONS ::= BEGIN\n-- nothing\nEND', 'empty.txt');
    const withEmpty = flattenTree(build([parse(BASE, 'base.txt'), empty]));
    const without = flattenTree(build([parse(BASE, 'base.txt')]));
    expect(withEmpty).toHaveLength(without.length);
  });
});

describe('duplicate definitions', () => {
  const DUP_A = `DUP-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE, enterprises FROM SNMPv2-SMI;
dupRoot OBJECT IDENTIFIER ::= { enterprises 12345 }
dupLeaf OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "revision A"
    ::= { dupRoot 1 }
END`;

  test('the same node defined twice appears once', () => {
    const tree = build([parse(DUP_A, 'a.txt'), parse(DUP_A, 'b.txt')]);
    const leaves = flattenTree(tree).filter(n => n.name === 'dupLeaf');
    expect(leaves).toHaveLength(1);
    expect(leaves[0].oid).toBe('1.3.6.1.4.1.12345.1');
  });

  // Symbols are keyed by "module::name", so two files claiming the same module
  // name collapse onto one node even where they disagree - the last one parsed
  // wins. The disagreement is surfaced by conflict detection, which compares
  // the parsed modules, not by the tree.
  test('the same object in two files claiming one module collapses, last wins', () => {
    const other = DUP_A.replace('::= { dupRoot 1 }', '::= { dupRoot 2 }');
    const leaves = flattenTree(build([parse(DUP_A, 'a.txt'), parse(other, 'b.txt')]))
      .filter(n => n.name === 'dupLeaf');

    expect(leaves).toHaveLength(1);
    expect(leaves[0].oid).toBe('1.3.6.1.4.1.12345.2');
  });

  test('different modules defining different children of one parent both appear', () => {
    const second = `OTHER-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE FROM SNMPv2-SMI  dupRoot FROM DUP-MIB;
otherLeaf OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "a second child"
    ::= { dupRoot 2 }
END`;
    const nodes = byName(build([parse(DUP_A, 'a.txt'), parse(second, 'b.txt')]));

    expect(nodes.get('dupLeaf')?.oid).toBe('1.3.6.1.4.1.12345.1');
    expect(nodes.get('otherLeaf')?.oid).toBe('1.3.6.1.4.1.12345.2');
  });

  test('a node redefining a seed does not duplicate it', () => {
    const content = `SEED-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE FROM SNMPv2-SMI;
mib-2 OBJECT IDENTIFIER ::= { mgmt 1 }
END`;
    const found = flattenTree(build([parse(content, 'seed.txt')])).filter(n => n.name === 'mib-2');
    expect(found).toHaveLength(1);
    expect(found[0].oid).toBe('1.3.6.1.2.1');
  });
});

describe('builder contract', () => {
  test('does not modify the modules it is given', () => {
    const modules = [parse(BASE, 'base.txt')];
    const before = JSON.stringify({
      objects: modules[0].objects,
      imports: [...modules[0].imports.entries()],
    });

    build(modules);

    expect(JSON.stringify({
      objects: modules[0].objects,
      imports: [...modules[0].imports.entries()],
    })).toBe(before);
  });

  test('the same modules build the same tree twice', () => {
    const modules = [parse(BASE, 'base.txt'), parse(EXTENSION, 'ext.txt')];
    const dump = (tree: MibNode[]): string =>
      flattenTree(tree).map(n => `${n.oid}|${n.name}|${n.parent}`).join(',');

    expect(dump(build(modules))).toBe(dump(build(modules)));
  });

  // The builder accumulates state in its maps, so reusing an instance would
  // merge two builds into one
  test('a builder instance is single use', () => {
    const builder = new MibTreeBuilder();
    const first = flattenTree(builder.buildTree([parse(BASE, 'base.txt')])).length;
    const second = flattenTree(builder.buildTree([parse(BASE, 'base.txt')])).length;
    expect(second).toBeGreaterThanOrEqual(first);
    expect(flattenTree(build([parse(BASE, 'base.txt')])).length).toBe(first);
  });

  test('carries the source module and file onto each node', () => {
    const nodes = byName(build([parse(BASE, 'base.txt')]));
    expect(nodes.get('baseLeaf')?.mibName).toBe('BASE-MIB');
    expect(nodes.get('baseLeaf')?.fileName).toBe('base.txt');
  });

  test('an empty module list still yields the standard seed hierarchy', () => {
    const nodes = byName(build([]));
    expect(nodes.get('iso')?.oid).toBe('1');
    expect(nodes.get('mib-2')?.oid).toBe('1.3.6.1.2.1');
    expect(nodes.get('enterprises')?.oid).toBe('1.3.6.1.4.1');
  });
});
