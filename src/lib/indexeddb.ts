import type { StoredMibData, MibNode, TextualConvention } from '../types/mib';

const DB_NAME = 'mib-browser-db';
const DB_VERSION = 2;
const STORE_NAME = 'mibs';
const TREE_STORE_NAME = 'mergedTree';

// Cached connection.
// Opening a new connection for every operation is expensive: a tree rebuild
// performs one write per MIB file, which used to mean one `indexedDB.open()`
// per file. The connection is reused and only dropped when it actually closes.
let dbPromise: Promise<IDBDatabase> | null = null;

// Open IndexedDB database (connection is cached and reused)
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;

      // Drop the cached connection if it goes away (tab closed the DB, or
      // another tab requested a version change) so the next call reopens it.
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };

      resolve(db);
    };

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
  }).catch(error => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

// Wrap an IDBRequest in a promise
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

// Get a single MIB by file name (uses the fileName index)
// Avoids loading every stored MIB just to look one up.
export async function getMibByFileName(fileName: string): Promise<StoredMibData | null> {
  const db = await openDB();
  const transaction = db.transaction(STORE_NAME, 'readonly');
  const index = transaction.objectStore(STORE_NAME).index('fileName');
  const result = await requestToPromise(index.get(fileName));
  return result || null;
}

// Count stored MIBs without reading their contents
export async function countMibs(): Promise<number> {
  const db = await openDB();
  const transaction = db.transaction(STORE_NAME, 'readonly');
  return requestToPromise(transaction.objectStore(STORE_NAME).count());
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

// Save or update multiple MIBs in a single transaction
// Much cheaper than awaiting saveMib() per file, which opens one transaction each.
export async function saveMibs(mibs: StoredMibData[]): Promise<void> {
  if (mibs.length === 0) return;

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);

    mibs.forEach(mib => store.put(mib));
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
// Pass already-loaded MIBs to avoid re-reading every record from IndexedDB.
export async function getStorageInfo(
  knownMibs?: StoredMibData[]
): Promise<{ used: number; available: number; percentage: number }> {
  // Sum up actual stored MIB sizes (more accurate)
  const mibs = knownMibs ?? (await getAllMibs());
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

    // Save all MIBs to IndexedDB (single transaction)
    await saveMibs(mibs);

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

// The TEXTUAL-CONVENTIONs are stored alongside the tree because the rebuild has
// already parsed every module and therefore has them in hand. Without this the
// node details panel would have to re-parse every stored MIB to resolve a
// node's SYNTAX.
export async function saveMergedTree(
  tree: MibNode[],
  textualConventions: TextualConvention[] = []
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TREE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(TREE_STORE_NAME);
    const request = store.put({ id: TREE_KEY, tree, textualConventions });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Load merged tree.
// `textualConventions` is undefined for trees stored before they were persisted,
// which the caller treats as "not available" rather than "none".
export async function loadMergedTree(): Promise<{
  tree: MibNode[];
  textualConventions?: TextualConvention[];
}> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TREE_STORE_NAME, 'readonly');
    const store = transaction.objectStore(TREE_STORE_NAME);
    const request = store.get(TREE_KEY);

    request.onsuccess = () => {
      const result = request.result;
      resolve({
        tree: result?.tree || [],
        textualConventions: result?.textualConventions,
      });
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
