import { useState, useEffect, useCallback } from 'react';
import { X, FileText, Loader2 } from 'lucide-react';

interface TextInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (content: string) => Promise<{ success: boolean; error?: string }>;
}

export default function TextInputModal({ isOpen, onClose, onSubmit }: TextInputModalProps) {
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ESCキーで閉じる
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  // モーダルが閉じたらリセット
  useEffect(() => {
    if (!isOpen) {
      setContent('');
      setError(null);
    }
  }, [isOpen]);

  const handleSubmit = useCallback(async () => {
    if (!content.trim()) {
      setError('MIB content is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await onSubmit(content);
      if (result.success) {
        onClose();
      } else {
        setError(result.error || 'Failed to upload MIB');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSubmitting(false);
    }
  }, [content, onSubmit, onClose]);

  if (!isOpen) return null;

  // 背景クリックで閉じる
  const handleBackgroundClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isSubmitting) {
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
          <div className="flex items-center gap-2">
            <FileText size={20} className="text-blue-500" />
            <h2 className="text-lg font-semibold text-gray-800">Paste MIB Content</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="p-2 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
            title="Close"
          >
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <p className="text-sm text-gray-600 mb-3">
            Paste the MIB file content below. The module name will be automatically detected.
          </p>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste MIB content here...

Example:
MY-MIB DEFINITIONS ::= BEGIN
IMPORTS
    enterprises, MODULE-IDENTITY
        FROM SNMPv2-SMI;
..."
            className="w-full h-80 p-3 font-mono text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
            disabled={isSubmitting}
          />
          {error && (
            <p className="mt-2 text-sm text-red-600">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !content.trim()}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Processing...
              </>
            ) : (
              'Add MIB'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
