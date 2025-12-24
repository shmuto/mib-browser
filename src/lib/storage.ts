/**
 * LocalStorage管理モジュール
 */

import type { StoredMibData, StorageInfo } from '../types/mib';

const STORAGE_KEY = 'mib-browser-data';
const MAX_STORAGE_SIZE = 5 * 1024 * 1024; // 5MB（LocalStorageの一般的な制限）

/**
 * MIBデータをLocalStorageに保存
 * @param data 保存するMIBデータ
 * @returns 成功した場合true
 */
export function saveMib(data: StoredMibData): boolean {
  try {
    const existingMibs = loadMibs();

    // 既存のMIBを更新または新規追加
    const index = existingMibs.findIndex(mib => mib.id === data.id);
    if (index !== -1) {
      existingMibs[index] = data;
    } else {
      existingMibs.push(data);
    }

    // LocalStorageに保存
    const jsonData = JSON.stringify(existingMibs);

    // サイズチェック
    const size = new Blob([jsonData]).size;
    if (size > MAX_STORAGE_SIZE) {
      console.error('Storage size exceeded');
      return false;
    }

    localStorage.setItem(STORAGE_KEY, jsonData);
    return true;
  } catch (error) {
    console.error('Failed to save MIB:', error);
    return false;
  }
}

/**
 * 保存済みMIBをすべて読み込み
 * @returns MIBデータの配列
 */
export function loadMibs(): StoredMibData[] {
  try {
    const jsonData = localStorage.getItem(STORAGE_KEY);
    if (!jsonData) return [];

    const mibs = JSON.parse(jsonData) as StoredMibData[];
    return mibs;
  } catch (error) {
    console.error('Failed to load MIBs:', error);
    return [];
  }
}

/**
 * MIBを削除
 * @param id MIB ID
 * @returns 成功した場合true
 */
export function deleteMib(id: string): boolean {
  try {
    const mibs = loadMibs();
    const filtered = mibs.filter(mib => mib.id !== id);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    return true;
  } catch (error) {
    console.error('Failed to delete MIB:', error);
    return false;
  }
}

/**
 * 特定のMIBを取得
 * @param id MIB ID
 * @returns MIBデータ、または null
 */
export function getMib(id: string): StoredMibData | null {
  try {
    const mibs = loadMibs();
    const mib = mibs.find(m => m.id === id);

    if (mib) {
      // 最終アクセス日時を更新
      mib.lastAccessedAt = Date.now();
      saveMib(mib);
    }

    return mib || null;
  } catch (error) {
    console.error('Failed to get MIB:', error);
    return null;
  }
}

/**
 * すべてのMIBをJSON形式でエクスポート
 * @returns JSON文字列
 */
export function exportMibs(): string {
  const mibs = loadMibs();
  return JSON.stringify(mibs, null, 2);
}

/**
 * JSONからMIBをインポート
 * @param json JSON文字列
 * @returns 成功した場合true
 */
export function importMibs(json: string): boolean {
  try {
    const importedMibs = JSON.parse(json) as StoredMibData[];

    // バリデーション
    if (!Array.isArray(importedMibs)) {
      console.error('Invalid import data: not an array');
      return false;
    }

    // 既存のMIBとマージ
    const existingMibs = loadMibs();
    const mergedMibs = [...existingMibs];

    importedMibs.forEach(imported => {
      const index = mergedMibs.findIndex(mib => mib.id === imported.id);
      if (index !== -1) {
        // 既存のMIBを更新
        mergedMibs[index] = imported;
      } else {
        // 新規追加
        mergedMibs.push(imported);
      }
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedMibs));
    return true;
  } catch (error) {
    console.error('Failed to import MIBs:', error);
    return false;
  }
}

/**
 * すべてのMIBを削除
 * @returns 成功した場合true
 */
export function clearAllMibs(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (error) {
    console.error('Failed to clear MIBs:', error);
    return false;
  }
}

/**
 * ストレージ使用量を取得
 * @returns ストレージ情報
 */
export function getStorageInfo(): StorageInfo {
  try {
    const jsonData = localStorage.getItem(STORAGE_KEY) || '';
    const used = new Blob([jsonData]).size;
    const available = MAX_STORAGE_SIZE;
    const percentage = (used / available) * 100;

    return {
      used,
      available,
      percentage,
    };
  } catch (error) {
    console.error('Failed to get storage info:', error);
    return {
      used: 0,
      available: MAX_STORAGE_SIZE,
      percentage: 0,
    };
  }
}

/**
 * UUIDを生成（簡易版）
 * @returns UUID文字列
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * ファイル名をサニタイズ（パストラバーサル対策、XSS対策）
 * @param fileName 元のファイル名
 * @returns サニタイズされたファイル名
 */
export function sanitizeFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    return 'unnamed';
  }

  // パストラバーサル文字を除去
  let sanitized = fileName
    .replace(/\.\./g, '')           // .. を除去
    .replace(/[\/\\]/g, '_')        // / と \ を _ に置換
    .replace(/[\x00-\x1f\x7f]/g, '') // 制御文字を除去
    .replace(/[<>:"|?*]/g, '_')     // Windows禁止文字を _ に置換
    .trim();

  // 空になった場合のフォールバック
  if (!sanitized) {
    return 'unnamed';
  }

  // 最大長制限（255バイト）
  if (sanitized.length > 255) {
    const ext = sanitized.lastIndexOf('.');
    if (ext > 0 && ext > sanitized.length - 10) {
      // 拡張子を保持
      const extension = sanitized.substring(ext);
      sanitized = sanitized.substring(0, 255 - extension.length) + extension;
    } else {
      sanitized = sanitized.substring(0, 255);
    }
  }

  return sanitized;
}

/**
 * StoredMibDataの構造を検証
 * @param data 検証するデータ
 * @returns 有効な場合true
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
 * ファイルサイズを人間が読みやすい形式に変換
 * @param bytes バイト数
 * @returns フォーマットされた文字列
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Math.round(bytes / Math.pow(k, i) * 100) / 100} ${sizes[i]}`;
}

/**
 * 日時を人間が読みやすい形式に変換
 * @param timestamp タイムスタンプ
 * @returns フォーマットされた文字列
 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
