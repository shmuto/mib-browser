import { useState } from 'react';
import type { StorageInfo } from '../types/mib';
import { Trash2, HardDrive } from 'lucide-react';
import { formatFileSize } from '../lib/storage';
import ConfirmModal from './ConfirmModal';

interface StorageManagerProps {
  storageInfo: StorageInfo;
  onClearAll: () => Promise<void>;
}

export default function StorageManager({ storageInfo, onClearAll }: StorageManagerProps) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const handleClearAll = () => {
    setIsConfirmOpen(true);
  };

  const handleConfirmClearAll = async () => {
    setIsConfirmOpen(false);
    await onClearAll();
  };

  return (
    <div className="p-4 bg-gray-50 border-t border-gray-200">
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <HardDrive size={16} />
            <span>Storage Usage</span>
          </div>
          <span className="text-sm font-medium text-gray-700">
            {formatFileSize(storageInfo.used)} / {formatFileSize(storageInfo.available)}
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className={`h-2 rounded-full ${
              storageInfo.percentage > 80 ? 'bg-red-500' : storageInfo.percentage > 50 ? 'bg-yellow-500' : 'bg-blue-500'
            }`}
            style={{ width: `${Math.min(storageInfo.percentage, 100)}%` }}
          />
        </div>
        <p className="text-xs text-gray-500 mt-1">{storageInfo.percentage.toFixed(1)}% used</p>
      </div>

      <button
        onClick={handleClearAll}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors text-sm"
        title="Delete all"
      >
        <Trash2 size={16} />
        <span>Clear All</span>
      </button>

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
