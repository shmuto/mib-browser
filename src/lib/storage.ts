/**
 * Storage utility functions
 */

import type { StoredMibData } from '../types/mib';

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
 * Validate StoredMibData structure
 * @param data Data to validate
 * @returns true if valid
 */
export function isValidStoredMibData(data: unknown): data is StoredMibData {
  if (!data || typeof data !== 'object') return false;

  const mib = data as Record<string, unknown>;

  return (
    typeof mib.id === 'string' &&
    typeof mib.fileName === 'string' &&
    typeof mib.content === 'string' &&
    typeof mib.nodeCount === 'number' &&
    typeof mib.uploadedAt === 'number' &&
    typeof mib.lastAccessedAt === 'number' &&
    typeof mib.size === 'number'
  );
}

/**
 * Format file size to human-readable format
 * @param bytes Byte count
 * @returns Formatted string
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Math.round(bytes / Math.pow(k, i) * 100) / 100} ${sizes[i]}`;
}
