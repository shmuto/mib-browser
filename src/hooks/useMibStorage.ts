/**
 * Custom hook for MIB storage (IndexedDB version)
 */

import { useState, useEffect, useCallback } from 'react';
import type { StoredMibData, StorageInfo, UploadResult, MibConflict, MibNode } from '../types/mib';
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
  saveMergedTree,
  loadMergedTree,
  clearMergedTree,
} from '../lib/indexeddb';
import { generateId, isValidStoredMibData } from '../lib/storage';
import { flattenTree, parseMibModule, validateMibContent } from '../lib/mib-parser';
import { MibTreeBuilder } from '../lib/mib-tree-builder';

interface UseMibStorageOptions {
  onNotification?: (type: 'error' | 'warning' | 'success' | 'info', title: string, details?: string[]) => void;
}

export function useMibStorage(options: UseMibStorageOptions = {}) {
  const { onNotification } = options;
  const [mibs, setMibs] = useState<StoredMibData[]>([]);
  const [mergedTree, setMergedTree] = useState<MibNode[]>([]);
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
      const tree = await loadMergedTree();
      setMergedTree(tree);

      // Get storage info (reuse the MIBs already read above)
      const info = await getStorageInfo(loadedMibs);
      setStorageInfo(info);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Rebuild all MIBs using 3-pass approach
  const rebuildAllTrees = useCallback(async (): Promise<void> => {
    try {
      // Step 1: Get content of all MIBs
      const allMibs = await getAllMibs();

      // Step 2: Convert all to ParsedModule format
      const allModules = allMibs.map(mib => {
        try {
          return parseMibModule(mib.content, mib.fileName);
        } catch (error) {
          console.error(`Failed to parse ${mib.fileName}:`, error);
          return null;
        }
      }).filter((m): m is NonNullable<typeof m> => m !== null);

      // Step 3: Build tree with MibTreeBuilder (retry on error)
      let tree;
      let modules = [...allModules];
      const errorFiles = new Set<string>();
      let lastMissingMibs: string[] = [];

      // MIB records mutated below; written back in a single batch at the end
      // instead of one IndexedDB transaction per file.
      const dirtyMibs = new Set<StoredMibData>();

      // Look up MIB records by file name (avoids scanning allMibs repeatedly)
      const mibsByFileName = new Map(allMibs.map(mib => [mib.fileName, mib]));

      // Max retry count (prevent infinite loop if dependencies cannot be resolved)
      const maxRetries = 10;
      let retryCount = 0;

      while (retryCount < maxRetries) {
        const builder = new MibTreeBuilder();
        try {
          tree = builder.buildTree(modules);
          break; // Exit loop on success
        } catch (buildError) {
          // If tree build fails, identify missing MIBs
          const errorMessage = buildError instanceof Error ? buildError.message : 'Unknown error';
          const match = errorMessage.match(/Missing MIB dependencies: ([^.]+)/);

          if (match) {
            const missingMibs = match[1].split(',').map(s => s.trim());

            // Exit if looping on same missing MIBs
            if (JSON.stringify(missingMibs.sort()) === JSON.stringify(lastMissingMibs.sort())) {
              break;
            }
            lastMissingMibs = missingMibs;

            // Identify and exclude modules depending on missing MIBs
            const modulesToRemove: string[] = [];
            for (const module of modules) {
              const dependsOnMissing = missingMibs.filter(missingMib =>
                Array.from(module.imports.values()).includes(missingMib)
              );

              if (dependsOnMissing.length > 0) {
                modulesToRemove.push(module.fileName);
                errorFiles.add(module.fileName);

                // Save error info to affected MIB
                const mib = mibsByFileName.get(module.fileName);
                if (mib) {
                  mib.error = `Missing MIB dependencies: ${dependsOnMissing.join(', ')}`;
                  mib.missingDependencies = dependsOnMissing;
                  mib.nodeCount = 0; // Node count is 0
                  dirtyMibs.add(mib);
                }
              }
            }

            // Exclude error files and retry
            if (modulesToRemove.length > 0) {
              modules = modules.filter(m => !modulesToRemove.includes(m.fileName));
              retryCount++;
              continue;
            }
          }

          // Exit if other error or no files to exclude
          break;
        }
      }

      // If tree build completely failed (no modules remaining)
      if (!tree || modules.length === 0) {
        // Persist the error info collected above
        await saveMibs(Array.from(dirtyMibs));
        await clearMergedTree();
        return;
      }

      // Step 4: Flatten tree
      const flatTree = flattenTree(tree);

      // Step 5: Save merged tree once
      await saveMergedTree(tree);

      // Calculate nodeCount for each MIB (nodes belonging to that MIB)
      const nodeCountByFile = new Map<string, number>();
      for (const node of flatTree) {
        if (node.fileName) {
          nodeCountByFile.set(node.fileName, (nodeCountByFile.get(node.fileName) || 0) + 1);
        }
      }

      // Step 6: Detect MIB files with same module name and compare node-level differences
      // Exclude error files
      const validMibs = allMibs.filter(mib => !errorFiles.has(mib.fileName));
      const parsedModuleMap = new Map(modules.map(m => [m.fileName, m]));

      // Index tree nodes by "module::name" so conflict reporting can look up a
      // node's OID directly instead of scanning the whole flat tree each time.
      const nodeByModuleAndName = new Map<string, MibNode>();
      for (const node of flatTree) {
        const key = `${node.mibName}::${node.name}`;
        if (!nodeByModuleAndName.has(key)) {
          nodeByModuleAndName.set(key, node);
        }
      }

      // Group files by module name (exclude error files)
      const mibNameMap = new Map<string, StoredMibData[]>();
      for (const mib of validMibs) {
        if (!mibNameMap.has(mib.mibName!)) {
          mibNameMap.set(mib.mibName!, []);
        }
        mibNameMap.get(mib.mibName!)!.push(mib);
      }

      // Step 7: Detect conflicts and save (exclude error files)
      for (const mib of validMibs) {
        const conflicts: MibConflict[] = [];

        // Compare at node level with other files having same module name
        const sameModuleMibs = mibNameMap.get(mib.mibName!);
        if (sameModuleMibs && sameModuleMibs.length > 1) {
          const moduleName = mib.mibName!;
          const otherDuplicates = sameModuleMibs.filter(m => m.id !== mib.id);

          // Get parse result for this file
          const thisModule = parsedModuleMap.get(mib.fileName);
          if (thisModule) {
            // Compare at node level with each duplicate file
            for (const otherMib of otherDuplicates) {
              const otherModule = parsedModuleMap.get(otherMib.fileName);
              if (!otherModule) continue;

              // Create map by object name
              const thisObjects = new Map(thisModule.objects.map(o => [o.name, o]));
              const otherObjects = new Map(otherModule.objects.map(o => [o.name, o]));

              // Compare objects that exist in both
              for (const [name, thisObj] of thisObjects) {
                const otherObj = otherObjects.get(name);
                if (!otherObj) continue;

                const differences: { field: string; existingValue: string; newValue: string }[] = [];

                // Compare fields
                const fieldsToCheck: (keyof typeof thisObj)[] = ['type', 'syntax', 'access', 'status', 'description'];
                for (const field of fieldsToCheck) {
                  const thisValue = String(thisObj[field] || '');
                  const otherValue = String(otherObj[field] || '');

                  if (thisValue && otherValue && thisValue !== otherValue) {
                    differences.push({
                      field,
                      existingValue: otherValue.length > 200 ? otherValue.substring(0, 200) + '...' : otherValue,
                      newValue: thisValue.length > 200 ? thisValue.substring(0, 200) + '...' : thisValue,
                    });
                  }
                }

                if (differences.length > 0) {
                  const treeNode = nodeByModuleAndName.get(`${moduleName}::${name}`);
                  conflicts.push({
                    oid: treeNode?.oid || 'unknown',
                    name,
                    existingFile: otherMib.fileName,
                    newFile: mib.fileName,
                    differences,
                  });
                }
              }
            }
          }
        }

        mib.conflicts = conflicts.length > 0 ? conflicts : undefined;
        mib.error = undefined;
        mib.missingDependencies = undefined;
        mib.nodeCount = nodeCountByFile.get(mib.fileName) || 0;

        dirtyMibs.add(mib);
      }

      // Write every changed MIB record in a single transaction
      await saveMibs(Array.from(dirtyMibs));

      // Notify if there are error files
      if (errorFiles.size > 0 && onNotification) {
        const errorDetails = allMibs
          .filter(mib => errorFiles.has(mib.fileName))
          .map(mib => `${mib.fileName}: ${mib.error || 'Unknown error'}`);

        onNotification('warning', `${errorFiles.size} file(s) have missing dependencies`, errorDetails);
      }
    } catch (error) {
      console.error('Failed to rebuild trees:', error);
      throw error;
    }
  }, [onNotification]);

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

      // Rebuild all MIBs (only if skipReload is false)
      if (!skipReload) {
        try {
          await rebuildAllTrees();
          await loadData();
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
          await rebuildAllTrees();
        } catch {
          // Ignore tree build errors (e.g., missing MIBs)
        }
      } else {
        // Clear tree if no MIBs remain
        await clearMergedTree();
      }
      await loadData();
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
          await rebuildAllTrees();
        } catch {
          // Ignore tree build errors (e.g., missing MIBs)
        }
      } else {
        // Clear tree if no MIBs remain
        await clearMergedTree();
      }
      await loadData();
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

      // Rebuild all MIBs
      if (!skipReload) {
        try {
          await rebuildAllTrees();
          await loadData();
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
      await rebuildAllTrees();
      await loadData();
    } catch (error) {
      console.error('Failed to rebuild tree:', error);
      await loadData(); // Reload to show any error states
      throw error;
    }
  }, [rebuildAllTrees, loadData]);

  return {
    mibs,
    mergedTree,
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
