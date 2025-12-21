import { useState, useCallback, useMemo } from 'react';
import type { StoredMibData } from '../types/mib';
import { FileText, Trash2, Download, CheckSquare, Square, Search, X, ArrowUpDown } from 'lucide-react';
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

        {/* Sort Controls */}
        <div className="flex items-center gap-2 mt-2">
          <ArrowUpDown size={12} className="text-gray-400" />
          <select
            value={sortField}
            onChange={(e) => setSortField(e.target.value as SortField)}
            className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
          >
            <option value="uploadedAt">Date</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
          </select>
          <button
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100 transition-colors"
            title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortOrder === 'asc' ? '↑' : '↓'}
          </button>
        </div>
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
        {filteredMibs.length === 0 ? (
          <div className="p-4 text-center text-gray-400">
            <p className="text-sm">No files match your search</p>
          </div>
        ) : (
          filteredMibs.map(mib => {
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
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xs font-medium text-gray-800 truncate">{mib.fileName}</h4>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatFileSize(mib.size)} • {mib.parsedData.length} nodes
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
            </div>
          );
        })
        )}
      </div>
    </div>
  );
}
