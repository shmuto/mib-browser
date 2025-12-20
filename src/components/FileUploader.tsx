import { useCallback, useRef, useState } from 'react';
import { Upload, FileText } from 'lucide-react';
import type { UploadResult } from '../types/mib';
import ConflictDialog from './ConflictDialog';

interface FileUploaderProps {
  onUpload: (file: File, forceUpload?: boolean) => Promise<UploadResult>;
}

export default function FileUploader({ onUpload }: FileUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [conflictResult, setConflictResult] = useState<UploadResult | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const processUpload = useCallback(async (file: File, forceUpload = false) => {
    const result = await onUpload(file, forceUpload);

    if (result.success) {
      console.log(`Uploaded: ${file.name}`);
    } else if (result.conflicts && result.conflicts.length > 0) {
      // 競合が見つかった場合、ダイアログを表示
      setConflictResult(result);
      setPendingFile(file);
    } else {
      console.error(`Failed to upload: ${file.name}`, result.error);
    }

    return result;
  }, [onUpload]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      await processUpload(files[i]);
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [processUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      await processUpload(files[i]);
    }
  }, [processUpload]);

  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleConflictCancel = useCallback(() => {
    setConflictResult(null);
    setPendingFile(null);
  }, []);

  const handleConflictForceUpload = useCallback(async () => {
    if (pendingFile) {
      await processUpload(pendingFile, true);
    }
    setConflictResult(null);
    setPendingFile(null);
  }, [pendingFile, processUpload]);

  return (
    <>
      <div
        className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 transition-colors cursor-pointer"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={handleButtonClick}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.mib"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
        <Upload className="mx-auto mb-4 text-gray-400" size={48} />
        <p className="text-lg font-medium text-gray-700 mb-2">
          Drag & drop MIB files
        </p>
        <p className="text-sm text-gray-500 mb-4">
          or click to select files
        </p>
        <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
          <FileText size={16} />
          <span>Supports .txt, .mib files</span>
        </div>
      </div>

      {conflictResult && conflictResult.conflicts && pendingFile && (
        <ConflictDialog
          conflicts={conflictResult.conflicts}
          fileName={pendingFile.name}
          onCancel={handleConflictCancel}
          onForceUpload={handleConflictForceUpload}
        />
      )}
    </>
  );
}
