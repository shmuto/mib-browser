import { useCallback, useRef, useState } from 'react';
import { Upload, FileText } from 'lucide-react';
import type { UploadResult } from '../types/mib';
import ConflictDialog from './ConflictDialog';

interface FileUploaderProps {
  onUpload: (file: File, forceUpload?: boolean, skipReload?: boolean) => Promise<UploadResult>;
  onReload?: () => Promise<void>;
}

export default function FileUploader({ onUpload, onReload }: FileUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [conflictResult, setConflictResult] = useState<UploadResult | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [remainingFiles, setRemainingFiles] = useState<File[]>([]);

  const processUpload = useCallback(async (file: File, forceUpload = false, skipReload = false) => {
    const result = await onUpload(file, forceUpload, skipReload);

    if (result.success) {
      console.log(`Uploaded: ${file.name}`);
      return true;
    } else if (result.conflicts && result.conflicts.length > 0) {
      // 競合が見つかった場合、ダイアログを表示
      setConflictResult(result);
      setPendingFile(file);
      return false; // 競合検出で停止
    } else {
      console.error(`Failed to upload: ${file.name}`, result.error);
      return true; // エラーでも次に進む
    }
  }, [onUpload]);

  const processRemainingFiles = useCallback(async () => {
    if (remainingFiles.length === 0) {
      // すべてのファイルの処理が完了したら、一度だけリロード
      if (onReload) {
        await onReload();
      }
      return;
    }

    const [nextFile, ...rest] = remainingFiles;
    setRemainingFiles(rest);

    // 残りのファイルがある場合はskipReloadを有効にする
    const skipReload = rest.length > 0;
    const success = await processUpload(nextFile, false, skipReload);

    // 競合が検出されなかった場合、次のファイルに進む
    if (success) {
      // 次のファイルを処理
      setTimeout(() => processRemainingFiles(), 0);
    }
  }, [remainingFiles, processUpload, onReload]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    // 最初のファイルを処理
    const [firstFile, ...rest] = fileArray;
    setRemainingFiles(rest);

    // 残りのファイルがある場合は skipReload を有効にする
    const skipReload = rest.length > 0;
    const success = await processUpload(firstFile, false, skipReload);

    // 競合が検出されなかった場合、次のファイルに進む
    if (success) {
      if (rest.length > 0) {
        setTimeout(() => processRemainingFiles(), 0);
      } else if (onReload) {
        // 単一ファイルの場合も明示的にリロード
        await onReload();
      }
    }
  }, [processUpload, processRemainingFiles, onReload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);

    // 最初のファイルを処理
    const [firstFile, ...rest] = fileArray;
    setRemainingFiles(rest);

    // 残りのファイルがある場合は skipReload を有効にする
    const skipReload = rest.length > 0;
    const success = await processUpload(firstFile, false, skipReload);

    // 競合が検出されなかった場合、次のファイルに進む
    if (success) {
      if (rest.length > 0) {
        setTimeout(() => processRemainingFiles(), 0);
      } else if (onReload) {
        // 単一ファイルの場合も明示的にリロード
        await onReload();
      }
    }
  }, [processUpload, processRemainingFiles, onReload]);

  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleConflictCancel = useCallback(() => {
    setConflictResult(null);
    setPendingFile(null);

    // 残りのファイルの処理を続行
    if (remainingFiles.length > 0) {
      setTimeout(() => processRemainingFiles(), 0);
    }
  }, [remainingFiles, processRemainingFiles]);

  const handleConflictForceUpload = useCallback(async () => {
    if (pendingFile) {
      // 残りのファイルがある場合は skipReload を有効にする
      const skipReload = remainingFiles.length > 0;
      await onUpload(pendingFile, true, skipReload);
    }
    setConflictResult(null);
    setPendingFile(null);

    // 残りのファイルの処理を続行
    if (remainingFiles.length > 0) {
      setTimeout(() => processRemainingFiles(), 0);
    } else if (onReload) {
      // 最後のファイルの場合はリロード
      await onReload();
    }
  }, [pendingFile, onUpload, remainingFiles, processRemainingFiles, onReload]);

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
