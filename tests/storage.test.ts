import { describe, test, expect } from 'bun:test';
import { formatFileSize, sanitizeFileName } from '../src/lib/storage';

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
