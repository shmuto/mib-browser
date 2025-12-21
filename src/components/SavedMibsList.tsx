import { useState, useCallback } from 'react';
import type { StoredMibData } from '../types/mib';
import { FileText, Trash2, Download, CheckSquare, Square, AlertTriangle } from 'lucide-react';
import { formatFileSize } from '../lib/storage';

interface SavedMibsListProps {
  mibs: StoredMibData[];
  activeMibId: string | null;
  onSelect: (mib: StoredMibData) => void;
  onDelete: (id: string) => Promise<void>;
  onBulkDelete?: (ids: string[]) => Promise<void>;
  onBulkDownload?: (mibs: StoredMibData[]) => void;
}

export default function SavedMibsList({
  mibs,
  activeMibId,
  onSelect,
  onDelete,
  onBulkDelete,
  onBulkDownload
}: SavedMibsListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showingConflicts, setShowingConflicts] = useState<string | null>(null);

  const toggleSelection = useCallback((id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === mibs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(mibs.map(m => m.id)));
    }
  }, [selectedIds.size, mibs]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;

    if (confirm(`Delete ${selectedIds.size} selected file(s)?`)) {
      if (onBulkDelete) {
        await onBulkDelete(Array.from(selectedIds));
      } else {
        // Fallback to individual deletes
        for (const id of selectedIds) {
          await onDelete(id);
        }
      }
      setSelectedIds(new Set());
    }
  }, [selectedIds, onBulkDelete, onDelete]);

  const handleBulkDownload = useCallback(() => {
    if (selectedIds.size === 0) return;

    const selectedMibs = mibs.filter(m => selectedIds.has(m.id));
    if (onBulkDownload) {
      onBulkDownload(selectedMibs);
    }
  }, [selectedIds, mibs, onBulkDownload]);

  if (mibs.length === 0) {
    return (
      <div className="p-4 text-center text-gray-400">
        <p className="text-sm">No saved MIBs</p>
      </div>
    );
  }

  const allSelected = selectedIds.size === mibs.length && mibs.length > 0;
  const someSelected = selectedIds.size > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Bulk Action Bar */}
      {someSelected && (
        <div className="p-2 bg-blue-50 border-b border-blue-200 flex items-center justify-between gap-2">
          <span className="text-xs text-blue-700 font-medium">
            {selectedIds.size} selected
          </span>
          <div className="flex gap-1">
            <button
              onClick={handleBulkDownload}
              className="p-1 hover:bg-blue-100 rounded text-blue-600 transition-colors"
              title="Download selected"
            >
              <Download size={14} />
            </button>
            <button
              onClick={handleBulkDelete}
              className="p-1 hover:bg-red-100 rounded text-red-600 transition-colors"
              title="Delete selected"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Select All */}
      <div className="p-2 bg-gray-50 border-b border-gray-200">
        <button
          onClick={toggleSelectAll}
          className="flex items-center gap-2 text-xs text-gray-600 hover:text-gray-800 transition-colors"
        >
          {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
          <span>{allSelected ? 'Deselect All' : 'Select All'}</span>
        </button>
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-200">
        {mibs.map(mib => {
          const isSelected = selectedIds.has(mib.id);
          return (
            <div
              key={mib.id}
              className={`p-2 hover:bg-gray-50 transition-colors ${
                mib.id === activeMibId ? 'bg-blue-50 border-l-2 border-blue-500' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                {/* Checkbox */}
                <button
                  onClick={(e) => toggleSelection(mib.id, e)}
                  className="flex-shrink-0 text-gray-400 hover:text-blue-600 transition-colors"
                >
                  {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                </button>

                {/* File Info - Clickable */}
                <div
                  className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                  onClick={() => onSelect(mib)}
                >
                  <FileText size={14} className="text-blue-500 flex-shrink-0" />
                  {mib.conflicts && mib.conflicts.length > 0 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowingConflicts(showingConflicts === mib.id ? null : mib.id);
                      }}
                      className="flex-shrink-0"
                      title={`${mib.conflicts.length} conflict(s)`}
                    >
                      <AlertTriangle size={14} className="text-yellow-500" />
                    </button>
                  )}
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xs font-medium text-gray-800 truncate">{mib.fileName}</h4>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatFileSize(mib.size)} • {mib.parsedData.length} nodes
                      {mib.conflicts && mib.conflicts.length > 0 && (
                        <span className="text-yellow-600 ml-1">• {mib.conflicts.length} conflict(s)</span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Individual Delete */}
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete ${mib.fileName}?`)) {
                      await onDelete(mib.id);
                    }
                  }}
                  className="p-1 hover:bg-red-100 rounded text-gray-400 hover:text-red-600 transition-colors flex-shrink-0"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* Conflict Details */}
              {showingConflicts === mib.id && mib.conflicts && mib.conflicts.length > 0 && (
                <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs">
                  <h5 className="font-semibold text-yellow-800 mb-2">Conflicts Detected:</h5>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {mib.conflicts.map((conflict, index) => (
                      <div key={index} className="bg-white p-2 rounded border border-yellow-100">
                        <div className="font-medium text-gray-800">
                          {conflict.name} ({conflict.oid})
                        </div>
                        <div className="text-gray-600 mt-1">
                          Conflicts with: <span className="font-medium">{conflict.existingFile}</span>
                        </div>
                        {conflict.differences.length > 0 && (
                          <div className="mt-1 text-gray-500">
                            {conflict.differences.length} difference(s)
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 pt-2 border-t border-yellow-200 flex gap-2">
                    <button
                      onClick={async () => {
                        if (confirm(`Delete ${mib.fileName}? This will resolve the conflicts.`)) {
                          await onDelete(mib.id);
                          setShowingConflicts(null);
                        }
                      }}
                      className="px-2 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600 transition-colors"
                    >
                      Delete This File
                    </button>
                    <button
                      onClick={() => setShowingConflicts(null)}
                      className="px-2 py-1 bg-gray-300 text-gray-700 rounded text-xs hover:bg-gray-400 transition-colors"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
