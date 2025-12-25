import { useCallback, useRef, useState } from 'react';
import { Upload, FileText, Loader2, ClipboardPaste } from 'lucide-react';
import toast from 'react-hot-toast';
import type { UploadResult } from '../types/mib';
import TextInputModal from './TextInputModal';

interface FileUploaderProps {
  onUpload: (file: File, forceUpload?: boolean, skipReload?: boolean) => Promise<UploadResult>;
  onUploadFromText?: (content: string, fileName: string) => Promise<UploadResult>;
  onReload?: () => Promise<void>;
  onNotification?: (type: 'error' | 'warning' | 'success' | 'info', title: string, details?: string[]) => void;
}

interface UploadProgress {
  isUploading: boolean;
  currentFile: string;
  processedFiles: number;
  totalFiles: number;
}

export default function FileUploader({ onUpload, onUploadFromText, onReload, onNotification }: FileUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    isUploading: false,
    currentFile: '',
    processedFiles: 0,
    totalFiles: 0,
  });
  const [isTextModalOpen, setIsTextModalOpen] = useState(false);

  const handleTextSubmit = useCallback(async (content: string, fileName: string) => {
    if (!onUploadFromText) {
      return { success: false, error: 'Text upload not supported' };
    }

    const result = await onUploadFromText(content, fileName);

    if (result.success) {
      if (onReload) {
        await onReload();
      }
      toast.success('MIB added successfully from text');
    } else {
      // Add failure to notification panel
      if (onNotification) {
        onNotification('error', 'Failed to upload MIB from text', [`${fileName}: ${result.error || 'Unknown error'}`]);
      }
    }

    return result;
  }, [onUploadFromText, onReload, onNotification]);

  const processUpload = useCallback(async (file: File, skipReload = false, fileIndex: number, totalFiles: number) => {
    // Update progress
    setUploadProgress({
      isUploading: true,
      currentFile: file.name,
      processedFiles: fileIndex,
      totalFiles: totalFiles,
    });

    const result = await onUpload(file, true, skipReload);
    return { file, result };
  }, [onUpload]);

  const processRemainingFiles = useCallback(async (
    files: File[],
    startIndex: number,
    totalFiles: number
  ): Promise<Array<{ file: File; result: UploadResult }>> => {
    if (files.length === 0) {
      return [];
    }

    const [nextFile, ...rest] = files;

    // Enable skipReload if there are remaining files
    const skipReload = rest.length > 0;
    const uploadResult = await processUpload(nextFile, skipReload, startIndex, totalFiles);

    // Process next file
    const remainingResults = await processRemainingFiles(rest, startIndex + 1, totalFiles);
    return [uploadResult, ...remainingResults];
  }, [processUpload]);

  const showUploadSummary = useCallback((results: Array<{ file: File; result: UploadResult }>) => {
    if (results.length === 0) return;

    let successCount = 0;
    let conflictCount = 0;
    let failureCount = 0;

    results.forEach(({ result }) => {
      if (result.success) {
        if (result.conflicts && result.conflicts.length > 0) {
          conflictCount++;
        } else {
          successCount++;
        }
      } else {
        failureCount++;
      }
    });

    // Add failed files to notification panel
    if (failureCount > 0 && onNotification) {
      const failedDetails = results
        .filter(({ result }) => !result.success)
        .map(({ file, result }) => `${file.name}: ${result.error || 'Unknown error'}`);

      onNotification('error', `${failureCount} file(s) failed to upload`, failedDetails);
    }

    if (results.length === 1) {
      // Show individual message for single file
      const { file, result } = results[0];
      if (result.success) {
        if (result.conflicts && result.conflicts.length > 0) {
          toast(`⚠ ${file.name}: Conflicts detected`, {
            icon: '⚠️',
            style: {
              background: '#fef3c7',
              color: '#92400e',
            },
          });
        } else {
          toast.success(`✓ ${file.name} uploaded successfully`);
        }
      } else {
        toast.error(`✗ Failed to upload ${file.name}: ${result.error || 'Unknown error'}`);
      }
    } else {
      // Show summary for multiple files
      const parts: string[] = [];
      if (successCount > 0) parts.push(`${successCount} uploaded`);
      if (conflictCount > 0) parts.push(`${conflictCount} with conflicts`);
      if (failureCount > 0) parts.push(`${failureCount} failed`);

      const message = `✓ ${parts.join(', ')}`;

      if (failureCount > 0) {
        // Collect failed file names
        const failedFiles = results
          .filter(({ result }) => !result.success)
          .map(({ file, result }) => `${file.name}: ${result.error || 'Unknown error'}`);

        toast.error(
          <div>
            <div>{message}</div>
            <div className="mt-1 text-xs opacity-80">
              {failedFiles.map((f, i) => (
                <div key={i}>• {f}</div>
              ))}
            </div>
          </div>,
          { duration: 6000 }
        );
      } else if (conflictCount > 0) {
        toast(message, {
          icon: '⚠️',
          style: {
            background: '#fef3c7',
            color: '#92400e',
          },
        });
      } else {
        toast.success(message);
      }
    }
  }, [onNotification]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);
    const totalFiles = fileArray.length;

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    try {
      // Start upload
      setUploadProgress({
        isUploading: true,
        currentFile: '',
        processedFiles: 0,
        totalFiles: totalFiles,
      });

      // Process first file
      const [firstFile, ...rest] = fileArray;

      // Enable skipReload if there are remaining files
      const skipReload = rest.length > 0;
      const firstResult = await processUpload(firstFile, skipReload, 1, totalFiles);

      let allResults = [firstResult];

      if (rest.length > 0) {
        const remainingResults = await processRemainingFiles(rest, 2, totalFiles);
        allResults = [...allResults, ...remainingResults];
      }

      // Execute reload
      if (onReload) {
        await onReload();
      }

      // Show summary
      showUploadSummary(allResults);
    } finally {
      // Reset upload progress
      setUploadProgress({
        isUploading: false,
        currentFile: '',
        processedFiles: 0,
        totalFiles: 0,
      });
    }
  }, [processUpload, processRemainingFiles, onReload, showUploadSummary]);

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
    const totalFiles = fileArray.length;

    try {
      // Start upload
      setUploadProgress({
        isUploading: true,
        currentFile: '',
        processedFiles: 0,
        totalFiles: totalFiles,
      });

      // Process first file
      const [firstFile, ...rest] = fileArray;

      // Enable skipReload if there are remaining files
      const skipReload = rest.length > 0;
      const firstResult = await processUpload(firstFile, skipReload, 1, totalFiles);

      let allResults = [firstResult];

      if (rest.length > 0) {
        const remainingResults = await processRemainingFiles(rest, 2, totalFiles);
        allResults = [...allResults, ...remainingResults];
      }

      // Execute reload
      if (onReload) {
        await onReload();
      }

      // Show summary
      showUploadSummary(allResults);
    } finally {
      // Reset upload progress
      setUploadProgress({
        isUploading: false,
        currentFile: '',
        processedFiles: 0,
        totalFiles: 0,
      });
    }
  }, [processUpload, processRemainingFiles, onReload, showUploadSummary]);

  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const progressPercentage = uploadProgress.totalFiles > 0
    ? Math.round((uploadProgress.processedFiles / uploadProgress.totalFiles) * 100)
    : 0;

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
        uploadProgress.isUploading
          ? 'border-blue-500 bg-blue-50 cursor-not-allowed'
          : 'border-gray-300 hover:border-blue-500 cursor-pointer'
      }`}
      onDragOver={uploadProgress.isUploading ? undefined : handleDragOver}
      onDrop={uploadProgress.isUploading ? undefined : handleDrop}
      onClick={uploadProgress.isUploading ? undefined : handleButtonClick}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.mib"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        disabled={uploadProgress.isUploading}
      />

      {uploadProgress.isUploading ? (
        <>
          <Loader2 className="mx-auto mb-4 text-blue-500 animate-spin" size={48} />
          <p className="text-lg font-medium text-gray-700 mb-2">
            Processing MIB files...
          </p>
          <p className="text-sm text-gray-600 mb-4">
            {uploadProgress.currentFile && (
              <span className="block mb-1">Current: {uploadProgress.currentFile}</span>
            )}
            <span>{uploadProgress.processedFiles} / {uploadProgress.totalFiles} files</span>
          </p>

          {/* Progress bar */}
          <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
            <div
              className="bg-blue-500 h-2.5 rounded-full transition-all duration-300"
              style={{ width: `${progressPercentage}%` }}
            ></div>
          </div>

          <p className="text-xs text-gray-500">
            Please wait, do not close this window
          </p>
        </>
      ) : (
        <>
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
        </>
      )}

      {/* Paste text button */}
      {onUploadFromText && !uploadProgress.isUploading && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsTextModalOpen(true);
          }}
          className="mt-3 flex items-center justify-center gap-2 px-4 py-2 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors mx-auto"
        >
          <ClipboardPaste size={16} />
          <span>Paste from text</span>
        </button>
      )}

      {/* Text input modal */}
      <TextInputModal
        isOpen={isTextModalOpen}
        onClose={() => setIsTextModalOpen(false)}
        onSubmit={handleTextSubmit}
      />
    </div>
  );
}
