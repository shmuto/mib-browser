import { useState, useCallback, useMemo } from 'react';
import type { StoredMibData } from '../types/mib';
import { FileText, Trash2, Download, CheckSquare, Square, Search, X, AlertTriangle } from 'lucide-react';
import { formatFileSize } from '../lib/storage';

type SortField = 'name' | 'uploadedAt' | 'size';
type SortOrder = 'asc' | 'desc';

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
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('uploadedAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

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

  // Filter and sort MIBs
  const filteredMibs = useMemo(() => {
    let result = mibs;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(mib =>
        mib.fileName.toLowerCase().includes(query) ||
        (mib.mibName && mib.mibName.toLowerCase().includes(query))
      );
    }

    // Apply sorting
    result = [...result].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'name':
          comparison = a.fileName.localeCompare(b.fileName);
          break;
        case 'uploadedAt':
          comparison = a.uploadedAt - b.uploadedAt;
          break;
        case 'size':
          comparison = a.size - b.size;
          break;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [mibs, searchQuery, sortField, sortOrder]);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredMibs.length && filteredMibs.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredMibs.map(m => m.id)));
    }
  }, [selectedIds.size, filteredMibs]);

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

  const allSelected = selectedIds.size === filteredMibs.length && filteredMibs.length > 0;
  const someSelected = selectedIds.size > 0;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const SortableHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => {
    const isActive = sortField === field;
    return (
      <th
        className="px-2 py-2 text-left text-xs font-medium text-gray-600 cursor-pointer hover:bg-gray-100 transition-colors"
        onClick={() => handleSort(field)}
      >
        <div className="flex items-center gap-1">
          {children}
          {isActive && (
            <span className="text-blue-600">
              {sortOrder === 'asc' ? '↑' : '↓'}
            </span>
          )}
        </div>
      </th>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search Bar */}
      <div className="p-2 bg-gray-50 border-b border-gray-200">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {searchQuery && (
          <p className="text-xs text-gray-500 mt-1">
            {filteredMibs.length} of {mibs.length} file(s)
          </p>
        )}
      </div>

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

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {filteredMibs.length === 0 ? (
          <div className="p-4 text-center text-gray-400">
            <p className="text-sm">No files match your search</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-2 py-2 w-8">
                  <button
                    onClick={toggleSelectAll}
                    className="text-gray-400 hover:text-blue-600 transition-colors"
                    title={allSelected ? 'Deselect All' : 'Select All'}
                  >
                    {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                  </button>
                </th>
                <SortableHeader field="name">Name</SortableHeader>
                <SortableHeader field="size">Size</SortableHeader>
                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Nodes</th>
                <SortableHeader field="uploadedAt">Date</SortableHeader>
                <th className="px-2 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredMibs.map(mib => {
                const isSelected = selectedIds.has(mib.id);
                return (
                  <tr
                    key={mib.id}
                    className={`hover:bg-gray-50 transition-colors ${
                      mib.id === activeMibId ? 'bg-blue-50' : ''
                    }`}
                  >
                    {/* Checkbox */}
                    <td className="px-2 py-2">
                      <button
                        onClick={(e) => toggleSelection(mib.id, e)}
                        className="text-gray-400 hover:text-blue-600 transition-colors"
                      >
                        {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                      </button>
                    </td>

                    {/* File Name */}
                    <td
                      className="px-2 py-2 cursor-pointer"
                      onClick={() => onSelect(mib)}
                    >
                      <div className="flex items-center gap-2">
                        <FileText size={14} className="text-blue-500 flex-shrink-0" />
                        <span className="font-medium text-gray-800 truncate">{mib.fileName}</span>
                        {mib.error && (
                          <div className="relative group">
                            <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 cursor-help" />
                            <div className="absolute right-0 top-full mt-1 hidden group-hover:block z-50 w-max max-w-xs p-2 bg-gray-900 text-white text-xs rounded shadow-lg whitespace-normal break-words">
                              {mib.missingDependencies && mib.missingDependencies.length > 0 ? (
                                <>
                                  <p className="font-semibold mb-1">Missing MIBs:</p>
                                  <ul className="list-disc list-inside">
                                    {mib.missingDependencies.map((dep, idx) => (
                                      <li key={idx}>{dep}</li>
                                    ))}
                                  </ul>
                                </>
                              ) : (
                                <>
                                  <p className="font-semibold mb-1">Error:</p>
                                  <p>{mib.error}</p>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Size */}
                    <td className="px-2 py-2 text-gray-600 whitespace-nowrap">
                      {formatFileSize(mib.size)}
                    </td>

                    {/* Nodes */}
                    <td className="px-2 py-2 text-gray-600">
                      {mib.nodeCount}
                    </td>

                    {/* Date */}
                    <td className="px-2 py-2 text-gray-600 whitespace-nowrap">
                      {new Date(mib.uploadedAt).toLocaleDateString()}
                    </td>

                    {/* Delete */}
                    <td className="px-2 py-2">
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (confirm(`Delete ${mib.fileName}?`)) {
                            await onDelete(mib.id);
                          }
                        }}
                        className="p-1 hover:bg-red-100 rounded text-gray-400 hover:text-red-600 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
