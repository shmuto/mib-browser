/**
 * Custom hook for MIB storage (IndexedDB version)
 */

import { useState, useEffect, useCallback } from 'react';
import type { StoredMibData, StorageInfo, UploadResult, MibNode, TextualConvention } from '../types/mib';
import {
  getAllMibs,
  getMibByFileName,
  countMibs,
  saveMib,
  saveMibs,
  deleteMib,
  deleteMibs,
  getMib,
  getStorageInfo,
  clearAllMibs,
  migrateFromLocalStorage,
  loadMergedTree,
  clearMergedTree,
} from '../lib/indexeddb';
import { generateId, isValidStoredMibData } from '../lib/storage';
import { parseMibModule, validateMibContent } from '../lib/mib-parser';
import { requestRebuild, noteParsedModule } from '../lib/rebuild-client';
import type { RebuildResult } from '../lib/rebuild';

interface UseMibStorageOptions {
  onNotification?: (type: 'error' | 'warning' | 'success' | 'info', title: string, details?: string[]) => void;
}

export function useMibStorage(options: UseMibStorageOptions = {}) {
  const { onNotification } = options;
  const [mibs, setMibs] = useState<StoredMibData[]>([]);
  const [mergedTree, setMergedTree] = useState<MibNode[]>([]);
  // undefined = not stored with this tree (built before they were persisted)
  const [textualConventions, setTextualConventions] = useState<TextualConvention[] | undefined>(undefined);
  const [storageInfo, setStorageInfo] = useState<StorageInfo>({
    used: 0,
    available: 0,
    percentage: 0,
  });
  const [loading, setLoading] = useState(true);

  // Initial load
  useEffect(() => {
    // Clear data if ?reset=true URL parameter exists
    // Security: Only process whitelisted parameters (currently only 'reset')
    const urlParams = new URLSearchParams(window.location.search);
    const resetParam = urlParams.get('reset');
    if (resetParam === 'true') {
      // Remove reset parameter from URL
      urlParams.delete('reset');
      const newUrl = urlParams.toString()
        ? `${window.location.pathname}?${urlParams.toString()}`
        : window.location.pathname;
      window.history.replaceState({}, '', newUrl);

      // Clear data then load
      clearAllMibs().then(() => clearMergedTree()).then(() => loadData());
    } else {
      loadData();
    }
  }, []);

  // Push freshly built data into React state.
  // Called before the merged tree is persisted so the UI does not wait on the
  // slowest step of a rebuild.
  const publishState = useCallback((
    nextMibs: StoredMibData[],
    nextTree: MibNode[],
    nextTcs: TextualConvention[] | undefined
  ) => {
    setMibs([...nextMibs]);
    setMergedTree(nextTree);
    setTextualConventions(nextTcs);
    getStorageInfo(nextMibs).then(setStorageInfo).catch(() => { /* usage figures are cosmetic */ });
  }, []);

  // Load data
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Attempt migration from LocalStorage
      await migrateFromLocalStorage();

      // Load MIBs from IndexedDB
      const loadedMibs = await getAllMibs();
      setMibs(loadedMibs);

      // Load merged tree
      const { tree, textualConventions: storedTcs } = await loadMergedTree();
      setMergedTree(tree);
      setTextualConventions(storedTcs);

      // Get storage info (reuse the MIBs already read above)
      const info = await getStorageInfo(loadedMibs);
      setStorageInfo(info);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Rebuild the merged tree from every stored MIB.
  // The parse, the tree build and the tree write all happen in a Web Worker, so
  // the main thread only reads the records, applies the per-file bookkeeping the
  // worker sends back, and renders.
  const rebuildAllTrees = useCallback(async (): Promise<void> => {
    const allMibs = await getAllMibs();
    const mibsById = new Map(allMibs.map(mib => [mib.id, mib]));

    // Apply what the rebuild worked out to the records, and show the result
    const applyResult = (result: RebuildResult) => {
      for (const file of result.files) {
        const mib = mibsById.get(file.id);
        if (!mib) continue;
        mib.nodeCount = file.nodeCount;
        mib.conflicts = file.conflicts;
        mib.error = file.error;
        mib.missingDependencies = file.missingDependencies;
      }

      publishState(allMibs, result.tree, result.textualConventions);
    };

    const result = await requestRebuild(allMibs, applyResult);

    // Persist the bookkeeping (the worker has already written the tree)
    const changed = result.files
      .map(file => mibsById.get(file.id))
      .filter((mib): mib is StoredMibData => mib !== undefined);
    await saveMibs(changed);

    // Notify if there are error files
    if (result.errorFiles.length > 0 && onNotification) {
      const errorSet = new Set(result.errorFiles);
      const errorDetails = allMibs
        .filter(mib => errorSet.has(mib.fileName))
        .map(mib => `${mib.fileName}: ${mib.error || 'Unknown error'}`);

      onNotification('warning', `${result.errorFiles.length} file(s) have missing dependencies`, errorDetails);
    }
  }, [onNotification, publishState]);

  // Upload MIB file (using 3-pass approach)
  const uploadMib = useCallback(async (file: File, _forceUpload = false, skipReload = false): Promise<UploadResult> => {
    try {
      const content = await file.text();

      // Check if valid as MIB file
      const validation = validateMibContent(content);
      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      // Parse with parseMibModule() (OID unresolved)
      const parsedModule = parseMibModule(content, file.name);

      // Look up an existing record for this file (indexed lookup, not a full read)
      const existingMib = await getMibByFileName(file.name);

      // Temporarily save as StoredMibData (nodeCount is 0)
      // Updated later by rebuildAllTrees
      const mibData: StoredMibData = {
        id: existingMib ? existingMib.id : generateId(), // Reuse ID if existing
        fileName: file.name,
        content,
        nodeCount: 0, // Updated by rebuildAllTrees
        uploadedAt: existingMib ? existingMib.uploadedAt : Date.now(), // Keep original upload time if existing
        lastAccessedAt: Date.now(),
        size: file.size,
        mibName: parsedModule.moduleName,
        conflicts: undefined, // Updated by rebuildAllTrees
      };

      await saveMib(mibData);

      // The file was just parsed for its module name; hand that result to the
      // rebuild instead of letting it parse the same content again
      noteParsedModule(mibData.id, content, parsedModule);

      // Rebuild all MIBs (only if skipReload is false)
      if (!skipReload) {
        try {
          // rebuildAllTrees publishes the new tree and MIB list itself
          await rebuildAllTrees();
        } catch (error) {
          // If error in rebuildAllTrees (e.g., missing MIBs)
          // rebuildAllTrees already saved error info to affected files
          await loadData(); // Reload
          throw error; // Rethrow error
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to upload MIB:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }, [loadData, rebuildAllTrees]);

  // Delete a single MIB
  const removeMib = useCallback(async (id: string): Promise<void> => {
    try {
      await deleteMib(id);
      // Rebuild tree with remaining MIBs
      const remainingCount = await countMibs();
      if (remainingCount > 0) {
        try {
          // rebuildAllTrees publishes the new tree and MIB list itself
          await rebuildAllTrees();
        } catch {
          // Tree build failed (e.g., missing MIBs) - fall back to a full reload
          await loadData();
        }
      } else {
        // Clear tree if no MIBs remain
        await clearMergedTree();
        await loadData();
      }
    } catch (error) {
      console.error('Failed to delete MIB:', error);
    }
  }, [loadData, rebuildAllTrees]);

  // Delete multiple MIBs
  const removeMibs = useCallback(async (ids: string[]): Promise<void> => {
    try {
      await deleteMibs(ids);
      // Rebuild tree with remaining MIBs
      const remainingCount = await countMibs();
      if (remainingCount > 0) {
        try {
          // rebuildAllTrees publishes the new tree and MIB list itself
          await rebuildAllTrees();
        } catch {
          // Tree build failed (e.g., missing MIBs) - fall back to a full reload
          await loadData();
        }
      } else {
        // Clear tree if no MIBs remain
        await clearMergedTree();
        await loadData();
      }
    } catch (error) {
      console.error('Failed to delete MIBs:', error);
    }
  }, [loadData, rebuildAllTrees]);

  // Get MIB by ID
  const getMibById = useCallback(async (id: string): Promise<StoredMibData | null> => {
    return await getMib(id);
  }, []);

  // Export all MIBs as JSON
  const exportData = useCallback(async (): Promise<string> => {
    const allMibs = await getAllMibs();
    return JSON.stringify(allMibs, null, 2);
  }, []);

  // Import MIBs from JSON
  const importData = useCallback(async (json: string): Promise<boolean> => {
    try {
      const parsed = JSON.parse(json);

      // Security: Validate JSON data structure
      if (!Array.isArray(parsed)) {
        console.error('Invalid import data: expected an array');
        return false;
      }

      // Validate each MIB structure
      const validMibs: StoredMibData[] = [];
      for (const item of parsed) {
        if (isValidStoredMibData(item)) {
          validMibs.push(item);
        } else {
          console.warn('Skipping invalid MIB data:', item);
        }
      }

      if (validMibs.length === 0) {
        console.error('No valid MIB data found in import');
        return false;
      }

      await saveMibs(validMibs);
      await loadData();
      return true;
    } catch (error) {
      console.error('Failed to import data:', error);
      return false;
    }
  }, [loadData]);

  // Upload MIB from text content
  const uploadMibFromText = useCallback(async (content: string, fileName: string, skipReload = false): Promise<UploadResult> => {
    try {
      // Check if valid as MIB file
      const validation = validateMibContent(content);
      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      // Parse with parseMibModule() (OID unresolved)
      const parsedModule = parseMibModule(content, fileName);

      // Look up an existing record for this file (indexed lookup, not a full read)
      const existingMib = await getMibByFileName(fileName);

      // Temporarily save as StoredMibData (nodeCount is 0)
      const mibData: StoredMibData = {
        id: existingMib ? existingMib.id : generateId(),
        fileName,
        content,
        nodeCount: 0, // Updated by rebuildAllTrees
        uploadedAt: existingMib ? existingMib.uploadedAt : Date.now(),
        lastAccessedAt: Date.now(),
        size: new Blob([content]).size,
        mibName: parsedModule.moduleName,
        conflicts: undefined,
      };

      await saveMib(mibData);

      // Reuse the parse the upload already did (see uploadMib)
      noteParsedModule(mibData.id, content, parsedModule);

      // Rebuild all MIBs
      if (!skipReload) {
        try {
          // rebuildAllTrees publishes the new tree and MIB list itself
          await rebuildAllTrees();
        } catch (error) {
          // rebuildAllTrees already saved error info to affected files
          await loadData();
          throw error;
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to upload MIB from text:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }, [loadData, rebuildAllTrees]);

  // Clear all MIBs and tree
  const clearAll = useCallback(async (): Promise<void> => {
    try {
      await clearAllMibs();
      await clearMergedTree();
      await loadData();
    } catch (error) {
      console.error('Failed to clear all MIBs:', error);
    }
  }, [loadData]);

  // Rebuild tree from all MIBs
  const rebuildTree = useCallback(async (): Promise<void> => {
    try {
      // rebuildAllTrees publishes the new tree and MIB list itself
      await rebuildAllTrees();
    } catch (error) {
      console.error('Failed to rebuild tree:', error);
      await loadData(); // Reload to show any error states
      throw error;
    }
  }, [rebuildAllTrees, loadData]);

  return {
    mibs,
    mergedTree,
    textualConventions,
    storageInfo,
    loading,
    uploadMib,
    uploadMibFromText,
    removeMib,
    removeMibs,
    getMibById,
    exportData,
    importData,
    clearAll,
    rebuildTree,
    reload: loadData,
  };
}
