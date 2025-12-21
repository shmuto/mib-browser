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
import { parseMibFile, buildTree, flattenTree } from '../lib/mib-parser';

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
    const newNodes = flattenTree(newTree);

    // 新しいファイルの各ノードについて、既存のMIBと比較
    newNodes.forEach(newNode => {
      // OBJECT IDENTIFIERとMODULE-IDENTITYは参照用の定義なので競合チェックをスキップ
      if (newNode.type === 'OBJECT IDENTIFIER' || newNode.type === 'MODULE-IDENTITY') {
        return;
      }

      existingMibs.forEach(existingMib => {
        const existingNodes = flattenTree(existingMib.parsedData);
        const matchingNode = existingNodes.find(n => n.oid === newNode.oid);

        if (matchingNode) {
          // 既存ノードもOBJECT IDENTIFIERまたはMODULE-IDENTITYの場合はスキップ
          if (matchingNode.type === 'OBJECT IDENTIFIER' || matchingNode.type === 'MODULE-IDENTITY') {
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

  // 既存のMIBファイルからグローバルOIDマップを構築
  const buildGlobalOidMap = useCallback((mibs: StoredMibData[]): Map<string, string> => {
    const oidMap = new Map<string, string>();

    const addNodeToMap = (node: MibNode) => {
      // OBJECT IDENTIFIERとMODULE-IDENTITYの定義をマップに追加
      if (node.type === 'OBJECT IDENTIFIER' || node.type === 'MODULE-IDENTITY') {
        oidMap.set(node.name, node.oid);
      }
      // 子ノードも処理
      node.children.forEach(addNodeToMap);
    };

    mibs.forEach(mib => {
      mib.parsedData.forEach(addNodeToMap);
    });

    return oidMap;
  }, []);

  // MIBファイルをアップロード
  const uploadMib = useCallback(async (file: File, _forceUpload = false, skipReload = false): Promise<UploadResult> => {
    try {
      const content = await file.text();

      // 既存MIBを取得
      const existingMibs = await getAllMibs();

      // グローバルOIDマップを構築
      const globalOidMap = buildGlobalOidMap(existingMibs);

      // パース（グローバルOIDマップを渡す）
      const parseResult = parseMibFile(content, globalOidMap);

      if (!parseResult.success || parseResult.nodes.length === 0) {
        console.error('Parse failed:', parseResult.errors);
        return {
          success: false,
          error: 'Failed to parse MIB file',
        };
      }

      // ツリーを構築
      const tree = buildTree(parseResult.nodes);
      const existingMib = existingMibs.find(mib => mib.fileName === file.name);

      // 競合検出（同じファイル名でない既存MIBとの競合をチェック）
      const otherMibs = existingMibs.filter(mib => mib.fileName !== file.name);
      const conflicts = detectConflicts(tree, file.name, otherMibs);

      // 競合があってもアップロードし、競合情報を保存
      const mibData: StoredMibData = {
        id: existingMib ? existingMib.id : generateId(), // 既存があればそのIDを再利用
        fileName: file.name,
        content,
        parsedData: tree,
        uploadedAt: existingMib ? existingMib.uploadedAt : Date.now(), // 既存があれば元のアップロード日時を保持
        lastAccessedAt: Date.now(),
        size: file.size,
        mibName: parseResult.mibName || undefined,
        conflicts: conflicts.length > 0 ? conflicts : undefined, // 競合情報を保存
      };

      await saveMib(mibData);

      // skipReloadがfalseの場合のみ再読み込み
      if (!skipReload) {
        await loadData();
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to upload MIB:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }, [loadData, detectConflicts]);

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
