import type { StoredMibData, MibNode } from '../types/mib';

const DB_NAME = 'mib-browser-db';
const DB_VERSION = 2;
const STORE_NAME = 'mibs';
const TREE_STORE_NAME = 'mergedTree';

// Open IndexedDB database
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create MIBs store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        objectStore.createIndex('fileName', 'fileName', { unique: false });
        objectStore.createIndex('uploadedAt', 'uploadedAt', { unique: false });
      }

      // Create merged tree store (single entry)
      if (!db.objectStoreNames.contains(TREE_STORE_NAME)) {
        db.createObjectStore(TREE_STORE_NAME, { keyPath: 'id' });
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
  // Sum up actual stored MIB sizes (more accurate)
  const mibs = await getAllMibs();
  const used = mibs.reduce((acc, mib) => acc + mib.size, 0);

  // Get browser storage quota
  let quota = 50 * 1024 * 1024; // Default: 50MB
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    quota = estimate.quota || quota;
  }

  return {
    used,
    available: quota - used,
    percentage: quota > 0 ? (used / quota) * 100 : 0,
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

// Save merged tree (single instance)
const TREE_KEY = 'merged-tree';

export async function saveMergedTree(tree: MibNode[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TREE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(TREE_STORE_NAME);
    const request = store.put({ id: TREE_KEY, tree });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Load merged tree
export async function loadMergedTree(): Promise<MibNode[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TREE_STORE_NAME, 'readonly');
    const store = transaction.objectStore(TREE_STORE_NAME);
    const request = store.get(TREE_KEY);

    request.onsuccess = () => {
      const result = request.result;
      resolve(result?.tree || []);
    };
    request.onerror = () => reject(request.error);
  });
}

// Clear merged tree
export async function clearMergedTree(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TREE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(TREE_STORE_NAME);
    const request = store.delete(TREE_KEY);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
