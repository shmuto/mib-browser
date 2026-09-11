/**
 * The rebuild pipeline: what it works out about each file.
 *
 * IndexedDB does not exist here, so the two writes the pipeline performs are
 * stubbed out. Everything else - parsing, building, per-file bookkeeping - is
 * the real thing.
 */

import { describe, test, expect, mock, beforeAll } from 'bun:test';
import { join } from 'path';

const savedTrees: unknown[] = [];

beforeAll(() => {
  mock.module(join(import.meta.dir, '..', 'src', 'lib', 'indexeddb.ts'), () => ({
    saveMergedTree: async (tree: unknown) => { savedTrees.push(tree); },
    clearMergedTree: async () => {},
  }));
});

const { runRebuild } = await import('../src/lib/rebuild');

const BASE = `RB-BASE-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE, enterprises FROM SNMPv2-SMI;
rbBase   OBJECT IDENTIFIER ::= { enterprises 7777 }
rbAnchor OBJECT IDENTIFIER ::= { rbBase 1 }
rbLeaf OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "a leaf"
    ::= { rbAnchor 1 }
END`;

// One definition lands, one has an anchor nothing defines
const PARTIAL = `RB-PARTIAL-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE FROM SNMPv2-SMI
        rbAnchor FROM RB-BASE-MIB;
rbPlaced OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "lands under the imported anchor"
    ::= { rbAnchor 2 }
rbUnplaced OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "nothing defines rbNowhere, and nothing imports it either"
    ::= { rbNowhere 1 }
END`;

describe('runRebuild', () => {
  test('builds a tree and counts what each file contributed', async () => {
    const result = await runRebuild({
      mibs: [{ id: 'base', fileName: 'rb-base.txt', mibName: 'RB-BASE-MIB', content: BASE }],
    });

    expect(result.ok).toBe(true);
    expect(result.files.find(f => f.id === 'base')?.nodeCount).toBe(3);
    expect(result.errorFiles).toEqual([]);
    expect(result.unplacedFiles).toBeUndefined();
  });

  test('names the file whose definitions could not be placed', async () => {
    const result = await runRebuild({
      mibs: [
        { id: 'base2', fileName: 'rb-base2.txt', mibName: 'RB-BASE-MIB', content: BASE },
        { id: 'partial', fileName: 'rb-partial.txt', mibName: 'RB-PARTIAL-MIB', content: PARTIAL },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.unplacedFiles).toEqual(['rb-partial.txt']);

    const partial = result.files.find(f => f.id === 'partial');
    // The definition that did resolve is still counted
    expect(partial?.nodeCount).toBe(1);
    expect(partial?.error).toContain('rbNowhere');
    expect(partial?.error).toContain('1 definition');

    // The file that resolved cleanly is left unmarked
    expect(result.files.find(f => f.id === 'base2')?.error).toBeUndefined();
  });

  test('excludes a file whose imported module is missing and says which', async () => {
    const needsMissing = `RB-NEEDS-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE FROM SNMPv2-SMI
        absentAnchor FROM RB-ABSENT-MIB;
rbNeeds OBJECT-TYPE
    SYNTAX      INTEGER
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "its anchor lives in a file that is not loaded"
    ::= { absentAnchor 1 }
END`;

    const result = await runRebuild({
      mibs: [
        { id: 'base3', fileName: 'rb-base3.txt', mibName: 'RB-BASE-MIB', content: BASE },
        { id: 'needs', fileName: 'rb-needs.txt', mibName: 'RB-NEEDS-MIB', content: needsMissing },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.errorFiles).toEqual(['rb-needs.txt']);

    const needs = result.files.find(f => f.id === 'needs');
    expect(needs?.missingDependencies).toEqual(['RB-ABSENT-MIB']);
    expect(needs?.nodeCount).toBe(0);
  });
});
