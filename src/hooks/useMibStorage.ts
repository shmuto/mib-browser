/**
 * MIBストレージ用カスタムフック (IndexedDB版)
 */

import { useState, useEffect, useCallback } from 'react';
import type { StoredMibData, StorageInfo, UploadResult, MibConflict, MibNode } from '../types/mib';
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
import { flattenTree, parseMibModule } from '../lib/mib-parser';
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

  // 競合検出関数（fileNameベース - 異なるモジュール間の競合検出用）
  // 注: 同じモジュール名のファイル間の競合はrebuildAllTreesで別途検出
  const detectConflicts = useCallback((
    newTree: MibNode[],
    newFileName: string,
    existingMibs: StoredMibData[]
  ): MibConflict[] => {
    const conflicts: MibConflict[] = [];
    const allNewNodes = flattenTree(newTree);

    // 新しいファイルに属するノードのみをフィルタリング
    const newNodes = allNewNodes.filter(node => node.fileName === newFileName);

    // 新しいファイルの各ノードについて、既存のMIBと比較
    newNodes.forEach(newNode => {
      // OBJECT IDENTIFIER、MODULE-IDENTITY、OBJECT-IDENTITYは参照用の定義なので競合チェックをスキップ
      if (newNode.type === 'OBJECT IDENTIFIER' ||
          newNode.type === 'MODULE-IDENTITY' ||
          newNode.type === 'OBJECT-IDENTITY') {
        return;
      }

      existingMibs.forEach(existingMib => {
        const allExistingNodes = flattenTree(existingMib.parsedData);

        // 既存のファイルに属するノードのみをフィルタリング
        const existingNodes = allExistingNodes.filter(node => node.fileName === existingMib.fileName);

        const matchingNode = existingNodes.find(n => n.oid === newNode.oid);

        if (matchingNode) {
          // 既存ノードもOBJECT IDENTIFIER、MODULE-IDENTITY、OBJECT-IDENTITYの場合はスキップ
          if (matchingNode.type === 'OBJECT IDENTIFIER' ||
              matchingNode.type === 'MODULE-IDENTITY' ||
              matchingNode.type === 'OBJECT-IDENTITY') {
            return;
          }

          const differences: { field: string; existingValue: string; newValue: string }[] = [];

          // 重要なフィールドの違いをチェック
          const fieldsToCheck: (keyof typeof newNode)[] = ['type', 'syntax', 'access', 'status', 'description'];

          fieldsToCheck.forEach(field => {
            const existingValue = String(matchingNode[field] || '');
            const newValue = String(newNode[field] || '');

            // 両方の値が存在し、かつ異なる場合のみ競合とみなす
            if (existingValue && newValue && existingValue !== newValue) {
              differences.push({
                field,
                existingValue,
                newValue,
              });
            }
          });

          if (differences.length > 0) {
            conflicts.push({
              oid: newNode.oid,
              name: newNode.name,
              existingFile: existingMib.fileName,
              newFile: newFileName,
              differences,
            });
          }
        }
      });
    });

    return conflicts;
  }, []);

  // 全MIBを3パスアプローチで再構築
  const rebuildAllTrees = useCallback(async (): Promise<void> => {
    try {
      console.log('[rebuildAllTrees] Starting tree rebuild...');

      // Step 1: 全MIBのcontentを取得
      const allMibs = await getAllMibs();
      console.log(`[rebuildAllTrees] Processing ${allMibs.length} MIBs`);

      // Step 2: 全てをParsedModule形式に変換
      const modules = allMibs.map(mib => {
        try {
          return parseMibModule(mib.content, mib.fileName);
        } catch (error) {
          console.error(`[rebuildAllTrees] Failed to parse ${mib.fileName}:`, error);
          return null;
        }
      }).filter((m): m is NonNullable<typeof m> => m !== null);

      console.log(`[rebuildAllTrees] Successfully parsed ${modules.length} modules`);

      // Step 3: MibTreeBuilderでツリー構築
      const builder = new MibTreeBuilder();
      const tree = builder.buildTree(modules);

      console.log(`[rebuildAllTrees] Tree built with ${tree.length} root nodes`);

      // Step 4: ツリーをフラット化
      const flatTree = flattenTree(tree);
      console.log(`[rebuildAllTrees] Flattened tree has ${flatTree.length} nodes`);

      // Step 5: すべてのMIBに統合ツリー全体を保存
      // （各MIBは統合ツリーの一部だが、表示時には全体が必要）
      // まず全MIBのparsedDataを更新
      for (const mib of allMibs) {
        mib.parsedData = tree;
      }

      // Step 6: 同じモジュール名のMIBファイルを検出し、ノードレベルで差異を比較
      // 各ファイルのパース結果をマップに保持（ファイル名 -> ParsedModule）
      const parsedModuleMap = new Map(modules.map(m => [m.fileName, m]));

      // モジュール名ごとにファイルをグループ化
      const mibNameMap = new Map<string, StoredMibData[]>();
      for (const mib of allMibs) {
        if (!mibNameMap.has(mib.mibName!)) {
          mibNameMap.set(mib.mibName!, []);
        }
        mibNameMap.get(mib.mibName!)!.push(mib);
      }

      // 重複するモジュール名を持つファイル群を特定
      const duplicateModules = Array.from(mibNameMap.entries())
        .filter(([_, mibs]) => mibs.length > 1);

      console.log(`[rebuildAllTrees] Found ${duplicateModules.length} duplicate MIB modules`);

      // Step 7: 競合検出と保存
      for (const mib of allMibs) {
        const conflicts: MibConflict[] = [];

        // 同じモジュール名を持つ他のファイルとノードレベルで比較
        const duplicateGroup = duplicateModules.find(([name]) => name === mib.mibName);
        if (duplicateGroup) {
          const [moduleName, duplicates] = duplicateGroup;
          const otherDuplicates = duplicates.filter(m => m.id !== mib.id);

          console.log(`[rebuildAllTrees] ${mib.fileName} has ${otherDuplicates.length} duplicate(s) with same module name "${moduleName}"`);

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
                if (!otherObj) continue; // 片方にしか存在しない場合はスキップ

                const differences: { field: string; existingValue: string; newValue: string }[] = [];

                // フィールドを比較
                const fieldsToCheck: (keyof typeof thisObj)[] = ['type', 'syntax', 'access', 'status', 'description'];
                for (const field of fieldsToCheck) {
                  const thisValue = String(thisObj[field] || '');
                  const otherValue = String(otherObj[field] || '');

                  // 両方に値があり、かつ異なる場合のみ記録
                  if (thisValue && otherValue && thisValue !== otherValue) {
                    differences.push({
                      field,
                      existingValue: otherValue.length > 200 ? otherValue.substring(0, 200) + '...' : otherValue,
                      newValue: thisValue.length > 200 ? thisValue.substring(0, 200) + '...' : thisValue,
                    });
                  }
                }

                if (differences.length > 0) {
                  // OIDを統合ツリーから取得
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

        // ツリー構築が成功したので、エラー情報をクリア
        mib.error = undefined;
        mib.missingDependencies = undefined;

        await saveMib(mib);

        // このMIBに属するノード数を計算（ログ用）
        const mibNodeCount = flatTree.filter(node => node.mibName === mib.mibName).length;
        console.log(`[rebuildAllTrees] Updated ${mib.fileName}: ${mibNodeCount} nodes owned, ${conflicts.length} conflicts`);
      }

      console.log('[rebuildAllTrees] Tree rebuild completed');
    } catch (error) {
      console.error('[rebuildAllTrees] Failed to rebuild trees:', error);
      throw error;
    }
  }, [detectConflicts]);

  // MIBファイルをアップロード（3パスアプローチ使用）
  const uploadMib = useCallback(async (file: File, _forceUpload = false, skipReload = false): Promise<UploadResult> => {
    try {
      const content = await file.text();

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
          // アップロードしたMIBは保存されているが、ツリーは構築されていない

          // エラー情報を抽出
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const missingDeps: string[] = [];

          // "Missing MIB dependencies: XXX, YYY" からMIB名を抽出
          const match = errorMessage.match(/Missing MIB dependencies: ([^.]+)/);
          if (match) {
            const depsString = match[1];
            missingDeps.push(...depsString.split(',').map(s => s.trim()));
          }

          // エラー情報をMIBデータに保存
          mibData.error = errorMessage;
          mibData.missingDependencies = missingDeps.length > 0 ? missingDeps : undefined;
          await saveMib(mibData);

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
      await loadData();
    } catch (error) {
      console.error('Failed to delete MIB:', error);
    }
  }, [loadData]);

  // 複数のMIBを削除
  const removeMibs = useCallback(async (ids: string[]): Promise<void> => {
    try {
      await deleteMibs(ids);
      await loadData();
    } catch (error) {
      console.error('Failed to delete MIBs:', error);
    }
  }, [loadData]);

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
    removeMib,
    removeMibs,
    getMibById,
    exportData,
    importData,
    clearAll,
    reload: loadData,
  };
}
