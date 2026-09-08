import { describe, test, expect } from 'bun:test';
import { getOidPath } from '../src/lib/oid-utils';

describe('getOidPath', () => {
  test('lists every prefix from the root to the OID itself', () => {
    expect(getOidPath('1.3.6.1')).toEqual(['1', '1.3', '1.3.6', '1.3.6.1']);
  });

  test('a single sub-identifier is its own path', () => {
    expect(getOidPath('1')).toEqual(['1']);
  });

  test('an empty OID has no path', () => {
    expect(getOidPath('')).toEqual([]);
  });

  // The tree can hand back an OID written with a leading dot; the path still
  // has to start at the root sub-identifier
  test('tolerates a leading dot', () => {
    expect(getOidPath('.1.3.6')).toEqual(['1', '1.3', '1.3.6']);
  });
});
