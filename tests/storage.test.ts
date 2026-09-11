import { describe, test, expect } from 'bun:test';
import { formatFileSize, sanitizeFileName } from '../src/lib/storage';
import { getStorageInfo } from '../src/lib/indexeddb';
import type { StoredMibData } from '../src/types/mib';

describe('formatFileSize', () => {
  test.each([
    [0, '0 Bytes'],
    [512, '512 Bytes'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1 MB'],
    [1024 * 1024 * 1024, '1 GB'],
  ])('formats %p as %p', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });

  // Regression: the unit index was taken straight from a logarithm, so a size
  // below one byte indexed off the front of the unit list and a size past the
  // last unit off the end - both rendered as "undefined"
  test('never renders a size as "undefined"', () => {
    for (const bytes of [0.5, 1024 ** 4, 1024 ** 5, Number.MAX_SAFE_INTEGER, -1, NaN]) {
      expect(formatFileSize(bytes)).not.toContain('undefined');
    }
  });

  test('a terabyte reads as TB', () => {
    expect(formatFileSize(1024 ** 4)).toBe('1 TB');
  });
});

describe('sanitizeFileName', () => {
  test('strips path separators and traversal', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('__etc_passwd');
  });

  test('falls back to a name when nothing survives', () => {
    expect(sanitizeFileName('..')).toBe('unnamed');
    expect(sanitizeFileName('')).toBe('unnamed');
  });

  test('keeps an ordinary MIB file name intact', () => {
    expect(sanitizeFileName('IF-MIB.txt')).toBe('IF-MIB.txt');
  });

  test('caps the length', () => {
    expect(sanitizeFileName('a'.repeat(400) + '.txt').length).toBeLessThanOrEqual(255);
  });
});

describe('getStorageInfo', () => {
  const originalNavigator = globalThis.navigator;

  const withNavigator = async (value: unknown, run: () => Promise<void>) => {
    Object.defineProperty(globalThis, 'navigator', { value, writable: true, configurable: true });
    try {
      await run();
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        writable: true,
        configurable: true,
      });
    }
  };

  const mib = (size: number): StoredMibData => ({
    id: `${size}`,
    fileName: `${size}.txt`,
    content: '',
    nodeCount: 0,
    uploadedAt: 0,
    lastAccessedAt: 0,
    size,
  });

  // The gauge is labelled "IndexedDB", and IndexedDB holds the merged tree as
  // well as the files - usually the largest record of the lot. Summing the file
  // sizes reported a fraction of what the browser counts against the quota.
  test('reports what the browser says is stored, not just the file sizes', async () => {
    await withNavigator(
      { storage: { estimate: async () => ({ usage: 9_000_000, quota: 100_000_000 }) } },
      async () => {
        const info = await getStorageInfo([mib(1000), mib(2000)]);
        expect(info.used).toBe(9_000_000);
        expect(info.available).toBe(91_000_000);
        expect(info.percentage).toBeCloseTo(9, 5);
      }
    );
  });

  test('falls back to the stored file sizes when there is no estimate', async () => {
    await withNavigator({}, async () => {
      const info = await getStorageInfo([mib(1000), mib(2000)]);
      expect(info.used).toBe(3000);
    });
  });

  test('falls back when the estimate throws or reports nothing', async () => {
    await withNavigator(
      { storage: { estimate: async () => { throw new Error('denied'); } } },
      async () => {
        expect((await getStorageInfo([mib(1500)])).used).toBe(1500);
      }
    );

    await withNavigator({ storage: { estimate: async () => ({ quota: 1000 }) } }, async () => {
      expect((await getStorageInfo([mib(1500)])).used).toBe(1500);
    });
  });

  test('never reports more than the quota as available or as a percentage', async () => {
    await withNavigator(
      { storage: { estimate: async () => ({ usage: 200, quota: 100 }) } },
      async () => {
        const info = await getStorageInfo([]);
        expect(info.available).toBe(0);
        expect(info.percentage).toBe(100);
      }
    );
  });
});
