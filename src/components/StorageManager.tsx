import { useState, useRef } from 'react';
import type { StorageInfo } from '../types/mib';
import { Download, Upload, Trash2, HardDrive } from 'lucide-react';
import { formatFileSize } from '../lib/storage';

interface StorageManagerProps {
  storageInfo: StorageInfo;
  onExport: () => Promise<string>;
  onImport: (json: string) => Promise<boolean>;
  onClearAll: () => Promise<void>;
}

export default function StorageManager({ storageInfo, onExport, onImport, onClearAll }: StorageManagerProps) {
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    const data = await onExport();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mib-browser-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const success = await onImport(text);
      if (success) {
        alert('Import successful');
      } else {
        alert('Import failed');
      }
    } catch (error) {
      alert('Failed to read file');
      console.error(error);
    } finally {
      setImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleClearAll = async () => {
    if (confirm('Delete all MIB data? This operation cannot be undone.')) {
      await onClearAll();
    }
  };

  return (
    <div className="p-4 bg-gray-50 border-t border-gray-200">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileSelect}
      />

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

      <div className="flex gap-2">
        <button
          onClick={handleExport}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors text-sm"
        >
          <Download size={16} />
          <span>Export</span>
        </button>
        <button
          onClick={handleImportClick}
          disabled={importing}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition-colors text-sm disabled:opacity-50"
        >
          <Upload size={16} />
          <span>{importing ? 'Importing...' : 'Import'}</span>
        </button>
        <button
          onClick={handleClearAll}
          className="flex items-center justify-center gap-2 px-3 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors text-sm"
          title="Delete all"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
