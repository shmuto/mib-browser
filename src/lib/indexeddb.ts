import type { StoredMibData } from '../types/mib';

const DB_NAME = 'mib-browser-db';
const DB_VERSION = 1;
const STORE_NAME = 'mibs';

// Open IndexedDB database
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create object store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        objectStore.createIndex('fileName', 'fileName', { unique: false });
        objectStore.createIndex('uploadedAt', 'uploadedAt', { unique: false });
      }
    };
  });
}

// Get all MIBs
export async function getAllMibs(): Promise<StoredMibData[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Get a single MIB by ID
export async function getMib(id: string): Promise<StoredMibData | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

// Save or update a MIB
export async function saveMib(mib: StoredMibData): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(mib);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Delete a MIB by ID
export async function deleteMib(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Delete multiple MIBs by IDs
export async function deleteMibs(ids: string[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    let completed = 0;
    const errors: Error[] = [];

    ids.forEach(id => {
      const request = store.delete(id);
      request.onsuccess = () => {
        completed++;
        if (completed === ids.length) {
          if (errors.length > 0) {
            reject(errors[0]);
          } else {
            resolve();
          }
        }
      };
      request.onerror = () => {
        errors.push(request.error as Error);
        completed++;
        if (completed === ids.length) {
          reject(errors[0]);
        }
      };
    });
  });
}

// Clear all MIBs
export async function clearAllMibs(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Get storage size estimate (IndexedDB quota)
export async function getStorageInfo(): Promise<{ used: number; available: number; percentage: number }> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    const used = estimate.usage || 0;
    const quota = estimate.quota || 0;
    const percentage = quota > 0 ? (used / quota) * 100 : 0;

    return {
      used,
      available: quota - used,
      percentage,
    };
  }

  // Fallback: calculate from stored data
  const mibs = await getAllMibs();
  const used = mibs.reduce((acc, mib) => acc + mib.size, 0);
  const quota = 50 * 1024 * 1024; // Estimate 50MB

  return {
    used,
    available: quota - used,
    percentage: (used / quota) * 100,
  };
}

// Migrate from localStorage to IndexedDB
export async function migrateFromLocalStorage(): Promise<number> {
  const STORAGE_KEY = 'mib-browser-mibs';

  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return 0;

    const mibs: StoredMibData[] = JSON.parse(data);

    // Save all MIBs to IndexedDB
    for (const mib of mibs) {
      await saveMib(mib);
    }

    // Remove from localStorage after successful migration
    localStorage.removeItem(STORAGE_KEY);

    return mibs.length;
  } catch (error) {
    console.error('Migration from localStorage failed:', error);
    return 0;
  }
}
