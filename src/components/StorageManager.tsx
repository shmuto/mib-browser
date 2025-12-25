import { useState } from 'react';
import type { StorageInfo } from '../types/mib';
import { Trash2, HardDrive, RefreshCw } from 'lucide-react';
import { formatFileSize } from '../lib/storage';
import ConfirmModal from './ConfirmModal';
import toast from 'react-hot-toast';

interface StorageManagerProps {
  storageInfo: StorageInfo;
  onClearAll: () => Promise<void>;
  onRebuildTree: () => Promise<void>;
}

export default function StorageManager({ storageInfo, onClearAll, onRebuildTree }: StorageManagerProps) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);

  const handleClearAll = () => {
    setIsConfirmOpen(true);
  };

  const handleConfirmClearAll = async () => {
    setIsConfirmOpen(false);
    await onClearAll();
  };

  const handleRebuildTree = async () => {
    if (isRebuilding) return;
    setIsRebuilding(true);
    try {
      await onRebuildTree();
      toast.success('Tree rebuilt successfully');
    } catch {
      toast.error('Failed to rebuild tree');
    } finally {
      setIsRebuilding(false);
    }
  };

  return (
    <div className="p-4 bg-gray-50 border-t border-gray-200">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <HardDrive size={16} />
          <span>IndexedDB</span>
        </div>
        <span className="text-sm font-medium text-gray-700">
          {formatFileSize(storageInfo.used)}
        </span>
      </div>

      <div className="flex gap-2 mb-2">
        <button
          onClick={handleRebuildTree}
          disabled={isRebuilding}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          title="Rebuild tree"
        >
          <RefreshCw size={16} className={isRebuilding ? 'animate-spin' : ''} />
          <span>{isRebuilding ? 'Rebuilding...' : 'Rebuild Tree'}</span>
        </button>
        <button
          onClick={handleClearAll}
          className="flex items-center justify-center gap-2 px-3 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors text-sm"
          title="Delete all"
        >
          <Trash2 size={16} />
        </button>
      </div>

      <p className="text-xs text-gray-400 mt-2 text-center">
        Page unresponsive? Add <code className="bg-gray-200 px-1 rounded">?reset=true</code> to URL
      </p>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={isConfirmOpen}
        title="Clear All Data"
        message="Delete all MIB data? This operation cannot be undone."
        confirmLabel="Delete All"
        onConfirm={handleConfirmClearAll}
        onCancel={() => setIsConfirmOpen(false)}
      />
    </div>
  );
}
