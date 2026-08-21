/**
 * Holds the fixtures in test-data/mibs to the behaviour their README promises.
 *
 * Each fixture exists because a real MIB had a shape the parser got wrong, so
 * these are the regression tests for those files. If a fixture is added, its
 * expectation belongs here as well as in test-data/README.md.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { validateMibContent, parseMibModule, flattenTree } from '../src/lib/mib-parser';
import { MibTreeBuilder } from '../src/lib/mib-tree-builder';
import type { MibNode } from '../src/types/mib';

const DIR = join(import.meta.dir, '..', 'test-data', 'mibs');
const fileNames = readdirSync(DIR).filter(name => name.endsWith('.txt')).sort();
const read = (name: string) => readFileSync(join(DIR, name), 'utf-8');

// Everything except the deliberately unresolvable one
const RESOLVABLE = fileNames.filter(name => name !== 'TEST-MISSING-DEP-MIB.txt');

const tree = new MibTreeBuilder().buildTree(RESOLVABLE.map(name => parseMibModule(read(name), name)));
const nodesByName = new Map<string, MibNode>(flattenTree(tree).map(node => [node.name, node]));

test('there are fixtures to check', () => {
  expect(fileNames.length).toBeGreaterThan(0);
});

describe('every fixture', () => {
  test.each(fileNames)('%s is accepted as a MIB', name => {
    const result = validateMibContent(read(name));
    expect(result.error ?? '').toBe('');
    expect(result.isValid).toBe(true);
  });

  test.each(fileNames)('%s parses to a named module', name => {
    const parsed = parseMibModule(read(name), name);
    expect(parsed.moduleName).not.toBe('UNKNOWN');
    expect(parsed.moduleName).not.toBe('');
  });
});

describe('the OIDs the README promises', () => {
  test.each([
    ['deepLeaf', '1.3.6.1.4.1.99999.3.3011.7124.3282.1'],
    ['namedLeaf', '1.3.6.1.4.1.99999.3.111.802.1.1'],
    ['oddCounter', '1.3.6.1.4.1.99998.1'],
    ['testName', '1.3.6.1.4.1.99999.1.1'],
    ['extLabel', '1.3.6.1.4.1.99999.2.1.1.1.2'],
  ])('%s resolves to %s', (name, oid) => {
    expect(nodesByName.get(name)?.oid).toBe(oid);
  });
});

describe('the shapes each fixture stands for', () => {
  // TEST-ODD-HEADER-MIB: name, a comment, then DEFINITIONS IMPLICIT TAGS
  test('a header split across a comment still yields the module name', () => {
    expect(parseMibModule(read('TEST-ODD-HEADER-MIB.txt'), 'x').moduleName).toBe('TEST-ODD-HEADER-MIB');
  });

  // TEST-TC-ONLY-MIB: like IPV6-TC, types but no objects
  test('a type-only module contributes textual conventions and no nodes', () => {
    const parsed = parseMibModule(read('TEST-TC-ONLY-MIB.txt'), 'x');
    expect(parsed.objects).toHaveLength(0);
    expect(parsed.textualConventions?.map(tc => tc.name).sort())
      .toEqual(['TestMacAddress', 'TestPortState']);
  });

  // TEST-EMPTY-MODULE-MIB: like RFC-1212, everything commented out
  test('a module with its body commented out is valid and defines nothing', () => {
    const parsed = parseMibModule(read('TEST-EMPTY-MODULE-MIB.txt'), 'x');
    expect(parsed.moduleName).toBe('TEST-EMPTY-MODULE-MIB');
    expect(parsed.objects).toHaveLength(0);
  });

  // TEST-MISSING-DEP-MIB: names the module it needs
  test('a missing dependency is reported by name', () => {
    expect(() => new MibTreeBuilder().buildTree([
      parseMibModule(read('TEST-MISSING-DEP-MIB.txt'), 'x'),
    ])).toThrow(/Missing MIB dependencies: TEST-ABSENT-MIB/);
  });

  // TEST-CONFLICT-A/B: same module name, definitions that differ
  test('the conflicting pair declares one module name with differing objects', () => {
    const a = parseMibModule(read('TEST-CONFLICT-A.txt'), 'a');
    const b = parseMibModule(read('TEST-CONFLICT-B.txt'), 'b');
    expect(a.moduleName).toBe(b.moduleName);

    const bByName = new Map(b.objects.map(o => [o.name, o]));
    const differing = a.objects.filter(objA => {
      const objB = bByName.get(objA.name);
      if (!objB) return false;
      return (['type', 'syntax', 'access', 'status', 'description'] as const)
        .some(field => {
          const left = String(objA[field] ?? '');
          const right = String(objB[field] ?? '');
          return left && right && left !== right;
        });
    });

    expect(differing.length).toBeGreaterThanOrEqual(3);
  });

  // TEST-EXTENSION-MIB imports its anchor from TEST-BASE-MIB
  test('upload order does not change the resulting OIDs', () => {
    const forwards = RESOLVABLE.map(name => parseMibModule(read(name), name));
    const backwards = [...RESOLVABLE].reverse().map(name => parseMibModule(read(name), name));

    const dump = (modules: typeof forwards) =>
      flattenTree(new MibTreeBuilder().buildTree(modules))
        .map(node => `${node.oid}|${node.name}`)
        .sort()
        .join(',');

    expect(dump(backwards)).toBe(dump(forwards));
  });
});

describe('the tree the fixtures build', () => {
  test('every node has an OID under its parent', () => {
    const check = (nodes: MibNode[], parentOid: string | null) => {
      for (const node of nodes) {
        expect(node.oid).not.toBe('');
        if (parentOid !== null) expect(node.oid.startsWith(`${parentOid}.`)).toBe(true);
        check(node.children, node.oid);
      }
    };
    check(tree, null);
  });

  test('no OID appears twice', () => {
    const oids = flattenTree(tree).map(node => node.oid);
    expect(new Set(oids).size).toBe(oids.length);
  });
});
