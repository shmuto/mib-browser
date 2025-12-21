import { useCallback, useRef } from 'react';
import { Upload, FileText } from 'lucide-react';
import type { UploadResult } from '../types/mib';

interface FileUploaderProps {
  onUpload: (file: File, forceUpload?: boolean, skipReload?: boolean) => Promise<UploadResult>;
  onReload?: () => Promise<void>;
}

export default function FileUploader({ onUpload, onReload }: FileUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processUpload = useCallback(async (file: File, skipReload = false) => {
    const result = await onUpload(file, true, skipReload);

    if (result.success) {
      console.log(`Uploaded: ${file.name}`);
      return true;
    } else {
      console.error(`Failed to upload: ${file.name}`, result.error);
      return false;
    }
  }, [onUpload]);

  const processRemainingFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      // すべてのファイルの処理が完了したら、一度だけリロード
      if (onReload) {
        await onReload();
      }
      return;
    }

    const [nextFile, ...rest] = files;

    // 残りのファイルがある場合はskipReloadを有効にする
    const skipReload = rest.length > 0;
    await processUpload(nextFile, skipReload);

    // 次のファイルを処理
    await processRemainingFiles(rest);
  }, [processUpload, onReload]);

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

    // 残りのファイルがある場合は skipReload を有効にする
    const skipReload = rest.length > 0;
    await processUpload(firstFile, skipReload);

    if (rest.length > 0) {
      await processRemainingFiles(rest);
    } else if (onReload) {
      // 単一ファイルの場合も明示的にリロード
      await onReload();
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

    // 残りのファイルがある場合は skipReload を有効にする
    const skipReload = rest.length > 0;
    await processUpload(firstFile, skipReload);

    if (rest.length > 0) {
      await processRemainingFiles(rest);
    } else if (onReload) {
      // 単一ファイルの場合も明示的にリロード
      await onReload();
    }
  }, [processUpload, processRemainingFiles, onReload]);

  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
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
  );
}
