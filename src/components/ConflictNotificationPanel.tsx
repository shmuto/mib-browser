import { useState, useMemo } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { StoredMibData, MibConflict } from '../types/mib';

interface ConflictPair {
  file1: StoredMibData;
  file2: StoredMibData;
  conflicts: MibConflict[];
}

interface ConflictNotificationPanelProps {
  mibs: StoredMibData[];
  onDeleteFile: (id: string) => Promise<void>;
}

export default function ConflictNotificationPanel({ mibs, onDeleteFile }: ConflictNotificationPanelProps) {
  const [selectedConflict, setSelectedConflict] = useState<ConflictPair | null>(null);

  // すべての競合ペアを抽出
  const conflictPairs = useMemo(() => {
    const pairs: ConflictPair[] = [];
    const processedPairs = new Set<string>();

    mibs.forEach(mib => {
      if (!mib.conflicts || mib.conflicts.length === 0) return;

      // この MIB が競合している各ファイルとのペアを作成
      const conflictingFiles = new Set<string>();
      mib.conflicts.forEach(conflict => {
        conflictingFiles.add(conflict.existingFile);
      });

      conflictingFiles.forEach(fileName => {
        const otherMib = mibs.find(m => m.fileName === fileName);
        if (!otherMib) return;

        // ペアのユニークキーを作成（アルファベット順でソート）
        const pairKey = [mib.fileName, otherMib.fileName].sort().join('|');
        if (processedPairs.has(pairKey)) return;

        processedPairs.add(pairKey);

        // この2つのファイル間の競合を抽出
        const pairConflicts = mib.conflicts!.filter(
          c => c.existingFile === otherMib.fileName || c.newFile === otherMib.fileName
        );

        if (pairConflicts.length > 0) {
          pairs.push({
            file1: otherMib,  // 既存のファイル (existingValue に対応)
            file2: mib,       // 新しいファイル (newValue に対応)
            conflicts: pairConflicts,
          });
        }
      });
    });

    return pairs;
  }, [mibs]);

  if (conflictPairs.length === 0) return null;

  return (
    <>
      {/* 通知バー */}
      <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-3">
        <div className="flex items-center gap-3">
          <AlertTriangle size={20} className="text-yellow-600 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-yellow-800">
              {conflictPairs.length} Conflict{conflictPairs.length > 1 ? 's' : ''} Detected
            </h3>
            <p className="text-xs text-yellow-700 mt-0.5">
              Click to view and resolve conflicts between MIB files
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {conflictPairs.map((pair, index) => (
              <button
                key={index}
                onClick={() => setSelectedConflict(pair)}
                className="px-3 py-1.5 bg-yellow-100 hover:bg-yellow-200 rounded text-xs font-medium text-yellow-800 transition-colors border border-yellow-300"
              >
                {pair.file1.fileName} ⇄ {pair.file2.fileName}
                <span className="ml-1.5 text-yellow-600">({pair.conflicts.length})</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 競合詳細ダイアログ */}
      {selectedConflict && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
            {/* ヘッダー */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <AlertTriangle size={20} className="text-yellow-600" />
                <h2 className="text-lg font-semibold text-gray-800">Conflict Details</h2>
              </div>
              <button
                onClick={() => setSelectedConflict(null)}
                className="p-2 hover:bg-gray-100 rounded transition-colors"
              >
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            {/* ファイル情報 */}
            <div className="p-4 bg-gray-50 border-b border-gray-200">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-1">File 1</h3>
                  <p className="text-sm text-gray-900 font-medium">{selectedConflict.file1.fileName}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {selectedConflict.file1.parsedData.length} nodes
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-1">File 2</h3>
                  <p className="text-sm text-gray-900 font-medium">{selectedConflict.file2.fileName}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {selectedConflict.file2.parsedData.length} nodes
                  </p>
                </div>
              </div>
            </div>

            {/* 競合リスト */}
            <div className="flex-1 overflow-y-auto p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                Conflicting OIDs ({selectedConflict.conflicts.length})
              </h3>
              <div className="space-y-3">
                {selectedConflict.conflicts.map((conflict, index) => (
                  <div key={index} className="bg-gray-50 border border-gray-200 rounded p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <h4 className="text-sm font-medium text-gray-900">{conflict.name}</h4>
                        <p className="text-xs text-gray-600 mt-0.5">OID: {conflict.oid}</p>
                      </div>
                    </div>
                    {conflict.differences.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-xs font-medium text-gray-700">Differences:</p>
                        {conflict.differences.map((diff, idx) => (
                          <div key={idx} className="text-xs bg-white border border-gray-200 rounded p-2">
                            <div className="font-medium text-gray-700">{diff.field}:</div>
                            <div className="grid grid-cols-2 gap-2 mt-1">
                              <div>
                                <span className="text-gray-500">File 1:</span>
                                <span className="ml-1 text-gray-900">{diff.existingValue || '(empty)'}</span>
                              </div>
                              <div>
                                <span className="text-gray-500">File 2:</span>
                                <span className="ml-1 text-gray-900">{diff.newValue || '(empty)'}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* アクションボタン */}
            <div className="p-4 border-t border-gray-200 flex justify-between items-center bg-gray-50">
              <p className="text-sm text-gray-600">Choose which file to keep:</p>
              <div className="flex gap-3">
                <button
                  onClick={async () => {
                    if (confirm(`Delete ${selectedConflict.file1.fileName}?\nThis will keep ${selectedConflict.file2.fileName}.`)) {
                      await onDeleteFile(selectedConflict.file1.id);
                      setSelectedConflict(null);
                    }
                  }}
                  className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors text-sm font-medium"
                >
                  Delete {selectedConflict.file1.fileName}
                </button>
                <button
                  onClick={async () => {
                    if (confirm(`Delete ${selectedConflict.file2.fileName}?\nThis will keep ${selectedConflict.file1.fileName}.`)) {
                      await onDeleteFile(selectedConflict.file2.id);
                      setSelectedConflict(null);
                    }
                  }}
                  className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors text-sm font-medium"
                >
                  Delete {selectedConflict.file2.fileName}
                </button>
                <button
                  onClick={() => setSelectedConflict(null)}
                  className="px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400 transition-colors text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
