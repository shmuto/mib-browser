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

  // 競合検出関数
  const detectConflicts = useCallback((
    newTree: MibNode[],
    newFileName: string,
    existingMibs: StoredMibData[]
  ): MibConflict[] => {
    const conflicts: MibConflict[] = [];
    const allNewNodes = flattenTree(newTree);

    // 新しいファイルに属するノードのみをフィルタリング（mibNameではなくfileNameで）
    const newNodes = allNewNodes.filter(node => node.fileName === newFileName);

    console.log(`[detectConflicts] Checking conflicts for ${newFileName}`);
    console.log(`[detectConflicts] New nodes: ${newNodes.length}, Existing MIBs: ${existingMibs.length}`);

    // デバッグ: aristaAclDpSupportFlagsを探す
    const targetNode = newNodes.find(n => n.name === 'aristaAclDpSupportFlags');
    if (targetNode) {
      console.log(`[detectConflicts] Found aristaAclDpSupportFlags in newNodes`);
      console.log(`[detectConflicts]   Type: ${targetNode.type}, OID: ${targetNode.oid}, fileName: ${targetNode.fileName}`);
    } else {
      console.log(`[detectConflicts] aristaAclDpSupportFlags NOT found in newNodes!`);
      console.log(`[detectConflicts] Sample nodes:`, allNewNodes.slice(0, 5).map(n => ({ name: n.name, fileName: n.fileName })));
    }

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

        // 既存のファイルに属するノードのみをフィルタリング（mibNameではなくfileNameで）
        const existingNodes = allExistingNodes.filter(node => node.fileName === existingMib.fileName);

        console.log(`[detectConflicts] Comparing with ${existingMib.fileName}, nodes: ${existingNodes.length}`);

        const matchingNode = existingNodes.find(n => n.oid === newNode.oid);

        if (matchingNode) {
          console.log(`[detectConflicts] Found matching node: ${newNode.name} (${newNode.oid})`);
          console.log(`[detectConflicts]   New type: ${newNode.type}, Existing type: ${matchingNode.type}`);

          // 既存ノードもOBJECT IDENTIFIER、MODULE-IDENTITY、OBJECT-IDENTITYの場合はスキップ
          if (matchingNode.type === 'OBJECT IDENTIFIER' ||
              matchingNode.type === 'MODULE-IDENTITY' ||
              matchingNode.type === 'OBJECT-IDENTITY') {
            console.log(`[detectConflicts]   Skipping (type: ${matchingNode.type})`);
            return;
          }

          const differences: { field: string; existingValue: string; newValue: string }[] = [];

          // 重要なフィールドの違いをチェック
          const fieldsToCheck: (keyof typeof newNode)[] = ['type', 'syntax', 'access', 'status', 'description'];

          fieldsToCheck.forEach(field => {
            const existingValue = String(matchingNode[field] || '');
            const newValue = String(newNode[field] || '');

            if (field === 'description' && newNode.name === 'aristaAclDpSupportFlags') {
              console.log(`[detectConflicts] Checking description for ${newNode.name}`);
              console.log(`[detectConflicts]   Existing: "${existingValue.substring(0, 100)}..."`);
              console.log(`[detectConflicts]   New: "${newValue.substring(0, 100)}..."`);
              console.log(`[detectConflicts]   Equal: ${existingValue === newValue}`);
            }

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
            console.log(`[detectConflicts] CONFLICT FOUND: ${newNode.name} (${newNode.oid})`);
            console.log(`[detectConflicts]   ${existingMib.fileName} vs ${newFileName}`);
            console.log(`[detectConflicts]   Differences:`, differences);

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

    console.log(`[detectConflicts] Total conflicts found: ${conflicts.length}`);
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

      // Step 6: 競合検出と保存
      for (const mib of allMibs) {
        // 競合検出（他のMIBとの競合をチェック）
        const otherMibs = allMibs.filter(m => m.id !== mib.id);
        const conflicts = detectConflicts(tree, mib.fileName, otherMibs);

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
