import { describe, test, expect } from 'bun:test';
import {
  parseOid,
  formatOid,
  compareOids,
  sortOids,
  isDescendant,
  isDirectChild,
  getParentOid,
  getOidDepth,
  getOidPath,
  isValidOid,
  getLastOidNumber,
  getCommonAncestor,
  buildOidNameMap,
  getOidNamePath,
} from '../src/lib/oid-utils';
import type { MibNode } from '../src/types/mib';

const node = (oid: string, name: string, children: MibNode[] = []): MibNode => ({
  oid, name, parent: null, type: '', syntax: '', access: '', status: '', description: '', children,
});

describe('parsing and formatting', () => {
  test('round-trips an OID', () => {
    expect(parseOid('1.3.6.1.2.1')).toEqual([1, 3, 6, 1, 2, 1]);
    expect(formatOid([1, 3, 6, 1, 2, 1])).toBe('1.3.6.1.2.1');
  });

  test('tolerates a leading dot', () => {
    expect(parseOid('.1.3.6')).toEqual([1, 3, 6]);
  });
});

describe('compareOids', () => {
  test('orders numerically, not lexically', () => {
    // "10" sorts before "9" as a string, but 9 comes first as a sub-identifier
    expect(compareOids('1.9', '1.10')).toBeLessThan(0);
  });

  test('a prefix sorts before what extends it', () => {
    expect(compareOids('1.3.6', '1.3.6.1')).toBeLessThan(0);
  });

  test('equal OIDs compare equal', () => {
    expect(compareOids('1.3.6.1', '1.3.6.1')).toBe(0);
  });

  test('sortOids orders a list and leaves the input alone', () => {
    const input = ['1.10', '1.2', '1.9.1', '1.9'];
    expect(sortOids(input)).toEqual(['1.2', '1.9', '1.9.1', '1.10']);
    expect(input).toEqual(['1.10', '1.2', '1.9.1', '1.9']);
  });
});

describe('ancestry', () => {
  test('isDescendant is true for any depth below, false for itself', () => {
    expect(isDescendant('1.3.6', '1.3.6.1.2')).toBe(true);
    expect(isDescendant('1.3.6', '1.3.6')).toBe(false);
    expect(isDescendant('1.3.6.1', '1.3.6')).toBe(false);
  });

  // A string prefix is not an OID prefix: 1.3.61 is not under 1.3.6
  test('isDescendant does not confuse a string prefix for a subtree', () => {
    expect(isDescendant('1.3.6', '1.3.61')).toBe(false);
  });

  test('isDirectChild is true only one level down', () => {
    expect(isDirectChild('1.3.6', '1.3.6.1')).toBe(true);
    expect(isDirectChild('1.3.6', '1.3.6.1.2')).toBe(false);
  });

  test('getParentOid drops the last sub-identifier and stops at the root', () => {
    expect(getParentOid('1.3.6.1')).toBe('1.3.6');
    expect(getParentOid('1')).toBeNull();
  });

  test('getCommonAncestor returns the shared prefix', () => {
    expect(getCommonAncestor('1.3.6.1.2.1', '1.3.6.1.4.1')).toBe('1.3.6.1');
    expect(getCommonAncestor('1.3.6', '2.5')).toBeNull();
  });
});

describe('getOidPath', () => {
  test('lists every prefix from the root to the OID itself', () => {
    expect(getOidPath('1.3.6.1')).toEqual(['1', '1.3', '1.3.6', '1.3.6.1']);
  });

  test('a single sub-identifier is its own path', () => {
    expect(getOidPath('1')).toEqual(['1']);
  });

  test('agrees with getOidDepth', () => {
    expect(getOidPath('1.3.6.1').length).toBe(getOidDepth('1.3.6.1') + 1);
  });
});

describe('validation and accessors', () => {
  test.each(['1', '1.3.6.1', '0.1'])('accepts %s', oid => {
    expect(isValidOid(oid)).toBe(true);
  });

  test.each(['', 'abc', '1.a.3', '1.-1'])('rejects %p', oid => {
    expect(isValidOid(oid)).toBe(false);
  });

  test('getLastOidNumber returns the final sub-identifier', () => {
    expect(getLastOidNumber('1.3.6.1.4.1.99999')).toBe(99999);
  });
});

describe('name maps', () => {
  const tree = [node('1', 'iso', [node('1.3', 'org', [node('1.3.6', 'dod')])])];

  test('buildOidNameMap covers every node in the tree', () => {
    const map = buildOidNameMap(tree);
    expect(map.get('1')).toBe('iso');
    expect(map.get('1.3.6')).toBe('dod');
    expect(map.size).toBe(3);
  });

  test('getOidNamePath joins the names along the path', () => {
    expect(getOidNamePath('1.3.6', buildOidNameMap(tree))).toBe('iso.org.dod');
  });

  test('getOidNamePath returns null when a level has no name', () => {
    expect(getOidNamePath('1.3.6.1', buildOidNameMap(tree))).toBeNull();
  });
});
