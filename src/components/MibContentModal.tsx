import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { StoredMibData } from '../types/mib';

interface MibContentModalProps {
  mib: StoredMibData | null;
  onClose: () => void;
}

export default function MibContentModal({ mib, onClose }: MibContentModalProps) {
  // Close on ESC key
  useEffect(() => {
    if (!mib) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mib, onClose]);

  if (!mib) return null;

  // Close on background click
  const handleBackgroundClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={handleBackgroundClick}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">{mib.fileName}</h2>
            <p className="text-sm text-gray-500 mt-1">
              Uploaded: {new Date(mib.uploadedAt).toLocaleString()}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded transition-colors"
            title="Close"
          >
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <pre className="text-xs font-mono bg-gray-50 p-4 rounded border border-gray-200 whitespace-pre-wrap break-words">
            {mib.content}
          </pre>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
