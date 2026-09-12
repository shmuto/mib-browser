/**
 * Collecting the files behind a drop or a folder pick.
 *
 * A dropped folder shows up in `dataTransfer.files` as one entry that cannot be
 * read, so a folder drop used to import nothing. The File System entry API is
 * what exposes the files inside it: every dropped item is turned into an entry
 * up front (the item list is only valid during the drop handler), and each
 * directory entry is then walked to the files at its leaves.
 */

/**
 * Names that never hold a MIB module and that a folder drop should not even
 * read: dotfiles and dot-directories such as .git, .svn and .DS_Store.
 */
export function isIgnoredEntryName(name: string): boolean {
  return name.startsWith('.');
}

/** True if any path segment is an ignored name (for webkitRelativePath). */
export function isIgnoredPath(path: string): boolean {
  return path.split('/').some(segment => segment.length > 0 && isIgnoredEntryName(segment));
}

/**
 * Turn the items of a drop into File System entries.
 *
 * Must be called synchronously from the drop handler: the item list is cleared
 * once the handler returns. Returns null when the browser has no entry API, so
 * the caller can fall back to `dataTransfer.files`.
 */
export function entriesFromDataTransfer(dataTransfer: DataTransfer): FileSystemEntry[] | null {
  const items = dataTransfer.items;
  if (!items || items.length === 0) return null;

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const getAsEntry = item.webkitGetAsEntry?.bind(item);
    if (!getAsEntry) return null;
    const entry = getAsEntry();
    if (entry) entries.push(entry);
  }

  return entries.length > 0 ? entries : null;
}

/** True if at least one entry is a directory - i.e. this was a folder drop. */
export function hasDirectoryEntry(entries: FileSystemEntry[]): boolean {
  return entries.some(entry => entry.isDirectory);
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise(resolve => {
    // A file that cannot be read (removed or permission denied mid-walk) is
    // skipped rather than failing the whole folder
    entry.file(file => resolve(file), () => resolve(null));
  });
}

function readEntryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(batch => resolve(batch), error => reject(error));
  });
}

async function readDirectoryEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];

  // readEntries hands back one batch at a time (Chrome stops at 100) and
  // signals the end with an empty batch, so keep calling until it does
  for (;;) {
    let batch: FileSystemEntry[];
    try {
      batch = await readEntryBatch(reader);
    } catch {
      break; // An unreadable directory contributes what was read so far
    }
    if (batch.length === 0) break;
    entries.push(...batch);
  }

  return entries;
}

async function collectEntry(entry: FileSystemEntry, collected: File[]): Promise<void> {
  if (isIgnoredEntryName(entry.name)) return;

  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    if (file) collected.push(file);
    return;
  }

  if (entry.isDirectory) {
    const children = await readDirectoryEntries(entry as FileSystemDirectoryEntry);
    for (const child of children) {
      await collectEntry(child, collected);
    }
  }
}

/**
 * Walk the entries of a drop down to their files, subdirectories included.
 * The order follows the directory listing, so files from one folder stay
 * together and dependencies within a folder are uploaded before the tree is
 * rebuilt at the end of the batch.
 */
export async function collectFilesFromEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const collected: File[] = [];
  for (const entry of entries) {
    await collectEntry(entry, collected);
  }
  return collected;
}

/**
 * Files from a folder pick (`<input webkitdirectory>`), minus the ones inside
 * dot-directories that the drop path skips too.
 */
export function filterPickedFolderFiles(files: File[]): File[] {
  return files.filter(file => {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (relativePath && isIgnoredPath(relativePath)) return false;
    return !isIgnoredEntryName(file.name);
  });
}
