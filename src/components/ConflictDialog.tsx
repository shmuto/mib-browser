import type { MibConflict } from '../types/mib';
import { AlertTriangle, X } from 'lucide-react';

interface ConflictDialogProps {
  conflicts: MibConflict[];
  fileName: string;
  onCancel: () => void;
  onForceUpload: () => void;
}

export default function ConflictDialog({
  conflicts,
  fileName,
  onCancel,
  onForceUpload,
}: ConflictDialogProps) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <AlertTriangle size={24} className="text-orange-500" />
            <h2 className="text-lg font-semibold text-gray-800">MIB Conflicts Detected</h2>
          </div>
          <button
            onClick={onCancel}
            className="p-1 hover:bg-gray-100 rounded transition-colors"
          >
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-sm text-gray-600 mb-4">
            The file <span className="font-semibold text-gray-800">{fileName}</span> contains{' '}
            <span className="font-semibold text-orange-600">{conflicts.length}</span> conflicting
            definition(s) with existing MIB files. Uploading this file may cause inconsistencies.
          </p>

          <div className="space-y-4">
            {conflicts.map((conflict, index) => (
              <div
                key={`${conflict.oid}-${index}`}
                className="border border-orange-200 bg-orange-50 rounded-lg p-4"
              >
                <div className="mb-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-gray-800">{conflict.name}</span>
                    <span className="text-xs text-gray-500 font-mono">{conflict.oid}</span>
                  </div>
                  <div className="text-xs text-gray-600">
                    Conflicts with: <span className="font-semibold">{conflict.existingFile}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  {conflict.differences.map((diff, diffIndex) => (
                    <div key={diffIndex} className="bg-white rounded p-2 text-xs">
                      <div className="font-semibold text-gray-700 mb-1 capitalize">{diff.field}:</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-gray-500 mb-0.5">Existing:</div>
                          <div className="bg-red-50 border border-red-200 rounded p-1 font-mono text-red-800 break-words">
                            {diff.existingValue}
                          </div>
                        </div>
                        <div>
                          <div className="text-gray-500 mb-0.5">New:</div>
                          <div className="bg-green-50 border border-green-200 rounded p-1 font-mono text-green-800 break-words">
                            {diff.newValue}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel Upload
          </button>
          <button
            onClick={onForceUpload}
            className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors flex items-center gap-2"
          >
            <AlertTriangle size={16} />
            Upload Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
