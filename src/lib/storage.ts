/**
 * Storage utility functions
 */

/**
 * Read a persisted UI setting.
 *
 * Browsers configured to block site data throw on the `localStorage` accessor
 * itself, not just on read - and these settings are read while rendering, so
 * an unguarded access takes the whole app down with it.
 * @param key Storage key
 * @returns The stored string, or null if absent or unreadable
 */
export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Persist a UI setting, ignoring a storage that refuses to be written to
 * (blocked site data, or a full quota)
 * @param key Storage key
 * @param value Value to store
 */
export function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A setting that cannot be remembered is not worth failing over
  }
}

/**
 * Generate a unique ID
 * @returns UUID string
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Sanitize filename (path traversal prevention, XSS prevention)
 * @param fileName Original filename
 * @returns Sanitized filename
 */
export function sanitizeFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    return 'unnamed';
  }

  // Remove path traversal characters
  let sanitized = fileName
    .replace(/\.\./g, '')           // Remove ..
    .replace(/[\/\\]/g, '_')        // Replace / and \ with _
    .replace(/[\x00-\x1f\x7f]/g, '') // Remove control characters
    .replace(/[<>:"|?*]/g, '_')     // Replace Windows forbidden characters with _
    .trim();

  // Fallback if empty
  if (!sanitized) {
    return 'unnamed';
  }

  // Max length limit (255 bytes)
  if (sanitized.length > 255) {
    const ext = sanitized.lastIndexOf('.');
    if (ext > 0 && ext > sanitized.length - 10) {
      // Preserve extension
      const extension = sanitized.substring(ext);
      sanitized = sanitized.substring(0, 255 - extension.length) + extension;
    } else {
      sanitized = sanitized.substring(0, 255);
    }
  }

  return sanitized;
}

/**
 * Format file size to human-readable format
 * @param bytes Byte count
 * @returns Formatted string
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  // Clamped to the units we have names for: a fractional byte count gives a
  // negative index and anything past the last unit runs off the end, both of
  // which used to render as "undefined"
  const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))));

  return `${Math.round(bytes / Math.pow(k, i) * 100) / 100} ${sizes[i]}`;
}
