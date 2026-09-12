import { useCallback, useRef, useState } from 'react';
import { Upload, FileText, Loader2, ClipboardPaste, FolderOpen } from 'lucide-react';
import toast from 'react-hot-toast';
import type { UploadResult } from '../types/mib';
import {
  collectFilesFromEntries,
  entriesFromDataTransfer,
  filterPickedFolderFiles,
  hasDirectoryEntry,
} from '../lib/dropped-files';
import TextInputModal from './TextInputModal';

interface FileUploaderProps {
  onUpload: (file: File, forceUpload?: boolean, skipReload?: boolean) => Promise<UploadResult>;
  onUploadFromText?: (content: string, fileName: string) => Promise<UploadResult>;
  onReload?: () => Promise<void>;
  onNotification?: (type: 'error' | 'warning' | 'success' | 'info', title: string, details?: string[]) => void;
}

interface UploadProgress {
  isUploading: boolean;
  isScanning: boolean;
  currentFile: string;
  processedFiles: number;
  totalFiles: number;
}

const IDLE_PROGRESS: UploadProgress = {
  isUploading: false,
  isScanning: false,
  currentFile: '',
  processedFiles: 0,
  totalFiles: 0,
};

// `webkitdirectory` is what turns a file input into a folder picker, and React
// has no typing for it
const FOLDER_INPUT_PROPS = { webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>;

export default function FileUploader({ onUpload, onUploadFromText, onReload, onNotification }: FileUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>(IDLE_PROGRESS);
  const [isTextModalOpen, setIsTextModalOpen] = useState(false);

  const handleTextSubmit = useCallback(async (content: string, fileName: string) => {
    if (!onUploadFromText) {
      return { success: false, error: 'Text upload not supported' };
    }

    const result = await onUploadFromText(content, fileName);

    if (result.success) {
      // The rebuild triggered by the upload already published the new state
      toast.success('MIB added successfully from text');
    } else {
      // Add failure to notification panel
      if (onNotification) {
        onNotification('error', 'Failed to upload MIB from text', [`${fileName}: ${result.error || 'Unknown error'}`]);
      }
    }

    return result;
  }, [onUploadFromText, onNotification]);

  const processUpload = useCallback(async (file: File, skipReload = false, fileIndex: number, totalFiles: number) => {
    // Update progress
    setUploadProgress({
      isUploading: true,
      isScanning: false,
      currentFile: file.name,
      processedFiles: fileIndex,
      totalFiles: totalFiles,
    });

    const result = await onUpload(file, true, skipReload);
    return { file, result };
  }, [onUpload]);

  // Upload files one by one. Only the last file triggers a tree rebuild;
  // the rest are stored with skipReload so the tree is built once.
  const processFiles = useCallback(async (
    files: File[]
  ): Promise<Array<{ file: File; result: UploadResult }>> => {
    const results: Array<{ file: File; result: UploadResult }> = [];

    for (let i = 0; i < files.length; i++) {
      const skipReload = i < files.length - 1;
      results.push(await processUpload(files[i], skipReload, i + 1, files.length));
    }

    return results;
  }, [processUpload]);

  const showUploadSummary = useCallback((
    results: Array<{ file: File; result: UploadResult }>,
    { fromFolder = false }: { fromFolder?: boolean } = {}
  ) => {
    if (results.length === 0) return;

    let successCount = 0;
    let conflictCount = 0;
    let skippedCount = 0;
    const failures: Array<{ file: File; result: UploadResult }> = [];

    results.forEach(({ file, result }) => {
      if (result.success) {
        if (result.conflicts && result.conflicts.length > 0) {
          conflictCount++;
        } else {
          successCount++;
        }
      } else if (fromFolder && result.reason === 'not-a-mib') {
        // A folder of MIBs also holds readmes, licenses and archives. Those
        // are not upload failures, so they are counted and left at that.
        skippedCount++;
      } else {
        failures.push({ file, result });
      }
    });

    // Add failed files to notification panel
    if (failures.length > 0 && onNotification) {
      const failedDetails = failures.map(({ file, result }) => `${file.name}: ${result.error || 'Unknown error'}`);

      onNotification('error', `${failures.length} file(s) failed to upload`, failedDetails);
    }

    if (results.length === 1 && !fromFolder) {
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
      return;
    }

    // Show summary for multiple files
    const parts: string[] = [];
    if (successCount > 0) parts.push(`${successCount} uploaded`);
    if (conflictCount > 0) parts.push(`${conflictCount} with conflicts`);
    if (failures.length > 0) parts.push(`${failures.length} failed`);
    if (skippedCount > 0) parts.push(`${skippedCount} skipped (not MIB files)`);

    if (fromFolder && successCount === 0 && conflictCount === 0 && failures.length === 0) {
      toast(`No MIB files found in the folder (${skippedCount} file(s) skipped)`, { icon: 'ℹ️' });
      return;
    }

    const message = `✓ ${parts.join(', ')}`;

    if (failures.length > 0) {
      // Collect failed file names
      const failedFiles = failures.map(({ file, result }) => `${file.name}: ${result.error || 'Unknown error'}`);

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
  }, [onNotification]);

  // Store every file of a selection or a drop, then report what happened
  const uploadFiles = useCallback(async (files: File[], { fromFolder = false }: { fromFolder?: boolean } = {}) => {
    if (files.length === 0) {
      if (fromFolder) toast('The folder holds no files to import', { icon: 'ℹ️' });
      return;
    }

    try {
      // Start upload
      setUploadProgress({
        isUploading: true,
        isScanning: false,
        currentFile: '',
        processedFiles: 0,
        totalFiles: files.length,
      });

      const allResults = await processFiles(files);

      // A successful batch ends in a rebuild, which publishes the new tree and
      // MIB list on its own. A failure can end the batch before that happens,
      // leaving earlier files stored but not shown, so reload in that case.
      if (onReload && allResults.some(({ result }) => !result.success)) {
        await onReload();
      }

      // Show summary
      showUploadSummary(allResults, { fromFolder });
    } finally {
      // Reset upload progress
      setUploadProgress(IDLE_PROGRESS);
    }
  }, [processFiles, onReload, showUploadSummary]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    await uploadFiles(fileArray);
  }, [uploadFiles]);

  const handleFolderSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileArray = filterPickedFolderFiles(Array.from(files));

    // Reset input
    if (folderInputRef.current) {
      folderInputRef.current.value = '';
    }

    await uploadFiles(fileArray, { fromFolder: true });
  }, [uploadFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // The dropped items are only readable during this handler, so the entries
    // behind them are taken before anything is awaited
    const entries = entriesFromDataTransfer(e.dataTransfer);
    const droppedFiles = Array.from(e.dataTransfer.files);

    if (!entries) {
      // No entry API: only the files of the drop are reachable
      await uploadFiles(droppedFiles);
      return;
    }

    if (!hasDirectoryEntry(entries)) {
      // A drop of plain files needs no walking, and a file dropped by name is
      // taken as it is - a dotfile included
      await uploadFiles(droppedFiles);
      return;
    }

    // Walking a folder takes a moment on a large collection; say so
    setUploadProgress({ ...IDLE_PROGRESS, isScanning: true });
    let files: File[];
    try {
      files = await collectFilesFromEntries(entries);
    } catch (error) {
      setUploadProgress(IDLE_PROGRESS);
      toast.error(`Failed to read the dropped folder: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return;
    }

    await uploadFiles(files, { fromFolder: true });
  }, [uploadFiles]);

  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const isBusy = uploadProgress.isUploading || uploadProgress.isScanning;

  const progressPercentage = uploadProgress.totalFiles > 0
    ? Math.round((uploadProgress.processedFiles / uploadProgress.totalFiles) * 100)
    : 0;

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
        isBusy
          ? 'border-blue-500 bg-blue-50 cursor-not-allowed'
          : 'border-gray-300 hover:border-blue-500 cursor-pointer'
      }`}
      onDragOver={isBusy ? undefined : handleDragOver}
      onDrop={isBusy ? undefined : handleDrop}
      onClick={isBusy ? undefined : handleButtonClick}
    >
      {/* No accept filter: MIB files come with every extension and none at all,
          and the content is validated on upload anyway */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        disabled={isBusy}
      />

      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderSelect}
        disabled={isBusy}
        {...FOLDER_INPUT_PROPS}
      />

      {uploadProgress.isScanning ? (
        <>
          <Loader2 className="mx-auto mb-4 text-blue-500 animate-spin" size={48} />
          <p className="text-lg font-medium text-gray-700 mb-2">
            Reading folder...
          </p>
          <p className="text-sm text-gray-600">
            Collecting the files to import
          </p>
        </>
      ) : uploadProgress.isUploading ? (
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
            Drag & drop MIB files or folders
          </p>
          <p className="text-sm text-gray-500 mb-4">
            or click to select files
          </p>
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
            <FileText size={16} />
            <span>Any file containing a MIB module</span>
          </div>
        </>
      )}

      {/* Folder and text entry points */}
      {!isBusy && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              folderInputRef.current?.click();
            }}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
          >
            <FolderOpen size={16} />
            <span>Select folder</span>
          </button>

          {onUploadFromText && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsTextModalOpen(true);
              }}
              className="flex items-center justify-center gap-2 px-4 py-2 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
            >
              <ClipboardPaste size={16} />
              <span>Paste from text</span>
            </button>
          )}
        </div>
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
