import { describe, test, expect } from 'bun:test';
import {
  collectFilesFromEntries,
  entriesFromDataTransfer,
  filterPickedFolderFiles,
  hasDirectoryEntry,
  isIgnoredEntryName,
  isIgnoredPath,
} from '../src/lib/dropped-files';

// Minimal stand-ins for the File System entry API, which no test runtime has.
// readEntries hands back one batch at a time and ends with an empty batch,
// exactly as a browser does.
function fileEntry(name: string, content = `${name} contents`, failRead = false): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    fullPath: `/${name}`,
    file(onSuccess: (file: File) => void, onError?: (error: unknown) => void) {
      if (failRead) {
        onError?.(new Error('unreadable'));
        return;
      }
      onSuccess(new File([content], name));
    },
  } as unknown as FileSystemEntry;
}

function directoryEntry(name: string, children: FileSystemEntry[], batchSize = 100, failRead = false): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    fullPath: `/${name}`,
    createReader() {
      let offset = 0;
      return {
        readEntries(onSuccess: (entries: FileSystemEntry[]) => void, onError?: (error: unknown) => void) {
          if (failRead) {
            onError?.(new Error('unreadable'));
            return;
          }
          const batch = children.slice(offset, offset + batchSize);
          offset += batch.length;
          onSuccess(batch);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

const names = (files: File[]) => files.map(file => file.name);

describe('isIgnoredEntryName', () => {
  test.each(['.git', '.DS_Store', '.svn', '.hidden-mib'])('%p is ignored', name => {
    expect(isIgnoredEntryName(name)).toBe(true);
  });

  test.each(['SNMPv2-MIB', 'IF-MIB.txt', 'my.mib'])('%p is kept', name => {
    expect(isIgnoredEntryName(name)).toBe(false);
  });
});

describe('isIgnoredPath', () => {
  test('a dot-directory anywhere in the path is ignored', () => {
    expect(isIgnoredPath('mibs/.git/objects/abc')).toBe(true);
    expect(isIgnoredPath('mibs/vendor/IF-MIB')).toBe(false);
  });
});

describe('collectFilesFromEntries', () => {
  test('a dropped folder yields the files inside it', async () => {
    const entries = [directoryEntry('mibs', [fileEntry('IF-MIB'), fileEntry('SNMPv2-MIB')])];

    expect(names(await collectFilesFromEntries(entries))).toEqual(['IF-MIB', 'SNMPv2-MIB']);
  });

  test('subdirectories are walked too', async () => {
    const entries = [
      directoryEntry('mibs', [
        fileEntry('IF-MIB'),
        directoryEntry('vendor', [fileEntry('ACME-MIB'), directoryEntry('old', [fileEntry('LEGACY-MIB')])]),
      ]),
    ];

    expect(names(await collectFilesFromEntries(entries))).toEqual(['IF-MIB', 'ACME-MIB', 'LEGACY-MIB']);
  });

  test('a directory listing longer than one batch is read to the end', async () => {
    // Chrome stops at 100 entries per readEntries call: a folder read in one
    // call would lose every MIB past the first batch
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`MIB-${i}`));
    const entries = [directoryEntry('mibs', children, 100)];

    expect(await collectFilesFromEntries(entries)).toHaveLength(250);
  });

  test('dot-directories and dotfiles are skipped', async () => {
    const entries = [
      directoryEntry('mibs', [
        fileEntry('IF-MIB'),
        fileEntry('.DS_Store'),
        directoryEntry('.git', [fileEntry('HEAD')]),
      ]),
    ];

    expect(names(await collectFilesFromEntries(entries))).toEqual(['IF-MIB']);
  });

  test('an unreadable file does not lose the rest of the folder', async () => {
    const entries = [
      directoryEntry('mibs', [fileEntry('IF-MIB'), fileEntry('GONE-MIB', '', true), fileEntry('SNMPv2-MIB')]),
    ];

    expect(names(await collectFilesFromEntries(entries))).toEqual(['IF-MIB', 'SNMPv2-MIB']);
  });

  test('an unreadable directory does not lose the rest of the drop', async () => {
    const entries = [directoryEntry('locked', [fileEntry('HIDDEN-MIB')], 100, true), fileEntry('IF-MIB')];

    expect(names(await collectFilesFromEntries(entries))).toEqual(['IF-MIB']);
  });

  test('plain files dropped alongside a folder are kept', async () => {
    const entries = [fileEntry('IF-MIB'), directoryEntry('mibs', [fileEntry('ACME-MIB')])];

    expect(names(await collectFilesFromEntries(entries))).toEqual(['IF-MIB', 'ACME-MIB']);
  });
});

describe('hasDirectoryEntry', () => {
  test('tells a folder drop from a file drop', () => {
    expect(hasDirectoryEntry([fileEntry('IF-MIB')])).toBe(false);
    expect(hasDirectoryEntry([fileEntry('IF-MIB'), directoryEntry('mibs', [])])).toBe(true);
  });
});

describe('entriesFromDataTransfer', () => {
  function dataTransfer(items: Array<{ kind: string; entry: FileSystemEntry | null }> | null): DataTransfer {
    return {
      items: items && {
        length: items.length,
        ...items.reduce((acc, item, i) => ({ ...acc, [i]: { kind: item.kind, webkitGetAsEntry: () => item.entry } }), {}),
      },
    } as unknown as DataTransfer;
  }

  test('non-file items (dragged text, for one) are left out', () => {
    const entry = fileEntry('IF-MIB');
    const entries = entriesFromDataTransfer(dataTransfer([
      { kind: 'string', entry: null },
      { kind: 'file', entry },
    ]));

    expect(entries).toEqual([entry]);
  });

  test('a drop with no usable items falls back to dataTransfer.files', () => {
    expect(entriesFromDataTransfer(dataTransfer(null))).toBeNull();
    expect(entriesFromDataTransfer(dataTransfer([]))).toBeNull();
    expect(entriesFromDataTransfer(dataTransfer([{ kind: 'file', entry: null }]))).toBeNull();
  });
});

describe('filterPickedFolderFiles', () => {
  function pickedFile(relativePath: string): File {
    const name = relativePath.split('/').pop() as string;
    const file = new File(['x'], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
    return file;
  }

  test('drops the files a folder drop would skip', () => {
    const files = [
      pickedFile('mibs/IF-MIB'),
      pickedFile('mibs/.DS_Store'),
      pickedFile('mibs/.git/config'),
      pickedFile('mibs/vendor/ACME-MIB'),
    ];

    expect(names(filterPickedFolderFiles(files))).toEqual(['IF-MIB', 'ACME-MIB']);
  });
});
