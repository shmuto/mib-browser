/**
 * MIBストレージ用カスタムフック (IndexedDB版)
 */

import { useState, useEffect, useCallback } from 'react';
import type { StoredMibData, StorageInfo, UploadResult, MibConflict } from '../types/mib';
import {
  getAllMibs,
  saveMib,
  deleteMib,
  deleteMibs,
  getMib,
  getStorageInfo,
  clearAllMibs,
  migrateFromLocalStorage,
} from '../lib/indexeddb';
import { generateId } from '../lib/storage';
import { flattenTree, parseMibModule, validateMibContent } from '../lib/mib-parser';
import { MibTreeBuilder } from '../lib/mib-tree-builder';

export function useMibStorage() {
  const [mibs, setMibs] = useState<StoredMibData[]>([]);
  const [storageInfo, setStorageInfo] = useState<StorageInfo>({
    used: 0,
    available: 0,
    percentage: 0,
  });
  const [loading, setLoading] = useState(true);

  // 初期読み込み
  useEffect(() => {
    loadData();
  }, []);

  // データ読み込み
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // LocalStorageからの移行を試みる
      await migrateFromLocalStorage();

      // IndexedDBからMIBを読み込む
      const loadedMibs = await getAllMibs();
      setMibs(loadedMibs);

      // ストレージ情報を取得
      const info = await getStorageInfo();
      setStorageInfo(info);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // 全MIBを3パスアプローチで再構築
  const rebuildAllTrees = useCallback(async (): Promise<void> => {
    try {
      // Step 1: 全MIBのcontentを取得
      const allMibs = await getAllMibs();

      // Step 2: 全てをParsedModule形式に変換
      const allModules = allMibs.map(mib => {
        try {
          return parseMibModule(mib.content, mib.fileName);
        } catch (error) {
          console.error(`Failed to parse ${mib.fileName}:`, error);
          return null;
        }
      }).filter((m): m is NonNullable<typeof m> => m !== null);

      // Step 3: MibTreeBuilderでツリー構築（エラー時はリトライ）
      let tree;
      let modules = [...allModules];
      const errorFiles = new Set<string>();
      let lastMissingMibs: string[] = [];

      // 最大リトライ回数（依存関係が解決できない場合の無限ループ防止）
      const maxRetries = 10;
      let retryCount = 0;

      while (retryCount < maxRetries) {
        const builder = new MibTreeBuilder();
        try {
          tree = builder.buildTree(modules);
          break; // 成功したらループを抜ける
        } catch (buildError) {
          // ツリー構築に失敗した場合、不足MIBを特定
          const errorMessage = buildError instanceof Error ? buildError.message : 'Unknown error';
          const match = errorMessage.match(/Missing MIB dependencies: ([^.]+)/);

          if (match) {
            const missingMibs = match[1].split(',').map(s => s.trim());

            // 同じ不足MIBでループしている場合は抜ける
            if (JSON.stringify(missingMibs.sort()) === JSON.stringify(lastMissingMibs.sort())) {
              break;
            }
            lastMissingMibs = missingMibs;

            // 不足MIBに依存しているモジュールを特定して除外
            const modulesToRemove: string[] = [];
            for (const module of modules) {
              const dependsOnMissing = missingMibs.filter(missingMib =>
                Array.from(module.imports.values()).includes(missingMib)
              );

              if (dependsOnMissing.length > 0) {
                modulesToRemove.push(module.fileName);
                errorFiles.add(module.fileName);

                // 該当MIBにエラー情報を保存
                const mib = allMibs.find(m => m.fileName === module.fileName);
                if (mib) {
                  mib.error = `Missing MIB dependencies: ${dependsOnMissing.join(', ')}`;
                  mib.missingDependencies = dependsOnMissing;
                  mib.parsedData = []; // ツリーは空
                  await saveMib(mib);
                }
              }
            }

            // エラーファイルを除外して再試行
            if (modulesToRemove.length > 0) {
              modules = modules.filter(m => !modulesToRemove.includes(m.fileName));
              retryCount++;
              continue;
            }
          }

          // 他のエラーまたは除外対象がない場合は抜ける
          break;
        }
      }

      // ツリー構築に完全に失敗した場合（モジュールが残っていない場合）
      if (!tree || modules.length === 0) {
        // 全てのMIBにエラー情報を保存済み
        return;
      }

      // Step 4: ツリーをフラット化
      const flatTree = flattenTree(tree);

      // Step 5: エラーなしのMIBに統合ツリー全体を保存
      for (const mib of allMibs) {
        if (!errorFiles.has(mib.fileName)) {
          mib.parsedData = tree;
        }
      }

      // Step 6: 同じモジュール名のMIBファイルを検出し、ノードレベルで差異を比較
      // エラーファイルを除外
      const validMibs = allMibs.filter(mib => !errorFiles.has(mib.fileName));
      const parsedModuleMap = new Map(modules.map(m => [m.fileName, m]));

      // モジュール名ごとにファイルをグループ化（エラーファイルを除外）
      const mibNameMap = new Map<string, StoredMibData[]>();
      for (const mib of validMibs) {
        if (!mibNameMap.has(mib.mibName!)) {
          mibNameMap.set(mib.mibName!, []);
        }
        mibNameMap.get(mib.mibName!)!.push(mib);
      }

      // 重複するモジュール名を持つファイル群を特定
      const duplicateModules = Array.from(mibNameMap.entries())
        .filter(([_, mibs]) => mibs.length > 1);

      // Step 7: 競合検出と保存（エラーファイルを除外）
      for (const mib of validMibs) {
        const conflicts: MibConflict[] = [];

        // 同じモジュール名を持つ他のファイルとノードレベルで比較
        const duplicateGroup = duplicateModules.find(([name]) => name === mib.mibName);
        if (duplicateGroup) {
          const [moduleName, duplicates] = duplicateGroup;
          const otherDuplicates = duplicates.filter(m => m.id !== mib.id);

          // このファイルのパース結果を取得
          const thisModule = parsedModuleMap.get(mib.fileName);
          if (thisModule) {
            // 各重複ファイルとノードレベルで比較
            for (const otherMib of otherDuplicates) {
              const otherModule = parsedModuleMap.get(otherMib.fileName);
              if (!otherModule) continue;

              // オブジェクト名でマップを作成
              const thisObjects = new Map(thisModule.objects.map(o => [o.name, o]));
              const otherObjects = new Map(otherModule.objects.map(o => [o.name, o]));

              // 両方に存在するオブジェクトを比較
              for (const [name, thisObj] of thisObjects) {
                const otherObj = otherObjects.get(name);
                if (!otherObj) continue;

                const differences: { field: string; existingValue: string; newValue: string }[] = [];

                // フィールドを比較
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
                  const treeNode = flatTree.find(n => n.name === name && n.mibName === moduleName);
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

        await saveMib(mib);
      }
    } catch (error) {
      console.error('Failed to rebuild trees:', error);
      throw error;
    }
  }, []);

  // MIBファイルをアップロード（3パスアプローチ使用）
  const uploadMib = useCallback(async (file: File, _forceUpload = false, skipReload = false): Promise<UploadResult> => {
    try {
      const content = await file.text();

      // MIBファイルとして有効かチェック
      const validation = validateMibContent(content);
      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      // parseMibModule()でパース（OID未解決）
      const parsedModule = parseMibModule(content, file.name);

      // 既存MIBを取得
      const existingMibs = await getAllMibs();
      const existingMib = existingMibs.find(mib => mib.fileName === file.name);

      // 一時的にStoredMibDataとして保存（parsedDataは空配列）
      // 後でrebuildAllTreesで更新される
      const mibData: StoredMibData = {
        id: existingMib ? existingMib.id : generateId(), // 既存があればそのIDを再利用
        fileName: file.name,
        content,
        parsedData: [], // rebuildAllTreesで更新
        uploadedAt: existingMib ? existingMib.uploadedAt : Date.now(), // 既存があれば元のアップロード日時を保持
        lastAccessedAt: Date.now(),
        size: file.size,
        mibName: parsedModule.moduleName,
        conflicts: undefined, // rebuildAllTreesで更新
      };

      await saveMib(mibData);

      // 全MIBを再構築（skipReloadがfalseの場合のみ）
      if (!skipReload) {
        try {
          await rebuildAllTrees();
          await loadData();
        } catch (error) {
          // rebuildAllTreesでエラーが発生した場合（不足MIBなど）
          // rebuildAllTreesが該当ファイルにエラー情報を保存済み
          await loadData(); // リロード
          throw error; // エラーを再スロー
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

  // MIBを削除
  const removeMib = useCallback(async (id: string): Promise<void> => {
    try {
      await deleteMib(id);
      // 残りのMIBでツリーを再構築
      const remainingMibs = await getAllMibs();
      if (remainingMibs.length > 0) {
        try {
          await rebuildAllTrees();
        } catch {
          // ツリー構築エラーは無視（不足MIBなど）
        }
      }
      await loadData();
    } catch (error) {
      console.error('Failed to delete MIB:', error);
    }
  }, [loadData, rebuildAllTrees]);

  // 複数のMIBを削除
  const removeMibs = useCallback(async (ids: string[]): Promise<void> => {
    try {
      await deleteMibs(ids);
      // 残りのMIBでツリーを再構築
      const remainingMibs = await getAllMibs();
      if (remainingMibs.length > 0) {
        try {
          await rebuildAllTrees();
        } catch {
          // ツリー構築エラーは無視（不足MIBなど）
        }
      }
      await loadData();
    } catch (error) {
      console.error('Failed to delete MIBs:', error);
    }
  }, [loadData, rebuildAllTrees]);

  // MIBを取得
  const getMibById = useCallback(async (id: string): Promise<StoredMibData | null> => {
    return await getMib(id);
  }, []);

  // エクスポート
  const exportData = useCallback(async (): Promise<string> => {
    const allMibs = await getAllMibs();
    return JSON.stringify(allMibs, null, 2);
  }, []);

  // インポート
  const importData = useCallback(async (json: string): Promise<boolean> => {
    try {
      const mibs: StoredMibData[] = JSON.parse(json);
      for (const mib of mibs) {
        await saveMib(mib);
      }
      await loadData();
      return true;
    } catch (error) {
      console.error('Failed to import data:', error);
      return false;
    }
  }, [loadData]);

  // テキストからMIBをアップロード
  const uploadMibFromText = useCallback(async (content: string, fileName: string, skipReload = false): Promise<UploadResult> => {
    try {
      // MIBファイルとして有効かチェック
      const validation = validateMibContent(content);
      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      // parseMibModule()でパース（OID未解決）
      const parsedModule = parseMibModule(content, fileName);

      // 既存MIBを取得
      const existingMibs = await getAllMibs();
      const existingMib = existingMibs.find(mib => mib.fileName === fileName);

      // 一時的にStoredMibDataとして保存（parsedDataは空配列）
      const mibData: StoredMibData = {
        id: existingMib ? existingMib.id : generateId(),
        fileName,
        content,
        parsedData: [],
        uploadedAt: existingMib ? existingMib.uploadedAt : Date.now(),
        lastAccessedAt: Date.now(),
        size: new Blob([content]).size,
        mibName: parsedModule.moduleName,
        conflicts: undefined,
      };

      await saveMib(mibData);

      // 全MIBを再構築
      if (!skipReload) {
        try {
          await rebuildAllTrees();
          await loadData();
        } catch (error) {
          // rebuildAllTreesが該当ファイルにエラー情報を保存済み
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

  // すべてクリア
  const clearAll = useCallback(async (): Promise<void> => {
    try {
      await clearAllMibs();
      await loadData();
    } catch (error) {
      console.error('Failed to clear all MIBs:', error);
    }
  }, [loadData]);

  return {
    mibs,
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
    reload: loadData,
  };
}
