# Application Architecture

This document explains how the MIB Browser fits together: what runs where, how a MIB file moves from upload to the rendered tree, and which module owns each piece of state.

> [!NOTE]
> For parsing and 3-pass tree-building internals, see [MIB_TREE_CONSTRUCTION_EN.md](./MIB_TREE_CONSTRUCTION_EN.md). For benchmarks and optimization details, see [PERFORMANCE_EN.md](./PERFORMANCE_EN.md).

## Table of Contents

1. [Overview](#overview)
2. [Module Map](#module-map)
3. [Data Flow](#data-flow)
4. [State Ownership](#state-ownership)
5. [Rendering the Tree](#rendering-the-tree)
6. [Persistence](#persistence)
7. [Error & Conflict Surfaces](#error--conflict-surfaces)

---

## Overview

The application is **entirely client-side**. There is no backend, no API call, and no MIB file ever leaves the browser—the GitHub Pages deployment serves static assets only. All user data lives in the browser's IndexedDB.

```text
┌───────────────────────────────────────────────────────────┐
│  React UI (src/components)                                │
│  file upload · MIB list · tree view · node details        │
└───────────────────────────────────────────────────────────┘
                          │  props / callbacks
                          ▼
┌───────────────────────────────────────────────────────────┐
│  useMibStorage (src/hooks)                                │
│  owns the MIB list, the merged tree, and rebuild cycle    │
└───────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│  Rebuild Worker              │   │  Persistence             │
│  parse · build · write tree  │   │  indexeddb.ts            │
│  mib-parser · mib-tree-      │   │  mib-browser-db          │
│  builder · rebuild.ts        │◀─▶│  (used by both threads)  │
└──────────────────────────────┘   └──────────────────────────┘
```

Heavy work—parsing MIBs, merging them into one OID tree, and persisting that tree—runs in a **Web Worker** so adding or removing files does not freeze the UI. If Web Workers are unavailable, the exact same pipeline falls back to running inline on the main thread.

**Tech stack:** React 19, TypeScript, Vite, Tailwind CSS, `lucide-react` for icons, and `react-hot-toast` for transient messages. State is managed with standard React state and a single custom hook (`useMibStorage`).

---

## Module Map

### `src/lib` — Pure Logic (No React)

| File | Responsibility |
|---|---|
| `mib-parser.ts` | Parses MIB text into a `ParsedModule` (`IMPORTS`, unresolved objects, `TEXTUAL-CONVENTION`s). Also exports `validateMibContent`, `filterTreeByQuery`, `filterTreeToNotifications`, `flattenTree`, and `countTreeNodes`. |
| `mib-tree-builder.ts` | Merges multiple `ParsedModule`s into a single OID tree (`MibTreeBuilder`, 3-pass). |
| `rebuild.ts` | Full rebuild pipeline as a plain function: parse (with session-scoped `parseCache`), build, per-file bookkeeping, and persist tree. Runs in the worker or inline. |
| `rebuild-client.ts` | Main-thread bridge to the worker: request/response plumbing, tracking which file contents the worker already caches, and the inline fallback. |
| `oid-utils.ts` | `getOidPath` — returns every OID prefix from the root to a target OID. |
| `indexeddb.ts` | Sole owner of IndexedDB access. No other module touches the database directly. |
| `dropped-files.ts` | Walks dropped folders and directory picks (including subdirectories, batch by batch) into files, skipping dotfiles and dot-directories. |
| `storage.ts` | Small utilities (`generateId`, `sanitizeFileName`, `formatFileSize`) and guarded `readSetting` / `writeSetting` helpers for UI preferences. |

### `src/workers`

| File | Responsibility |
|---|---|
| `rebuild.worker.ts` | Runs `rebuild.ts` off the main thread. Posts the finished tree back immediately, then persists it to IndexedDB and posts a completion signal. |

### `src/hooks`

| File | Responsibility |
|---|---|
| `useMibStorage.ts` | Single source of truth for stored MIBs and the merged tree. Owns upload, delete, import/export, and `rebuildAllTrees`. |

### `src/components`

| Component | Responsibility |
|---|---|
| `FileUploader` | Drop zone, file/folder pickers, multi-file upload progress bar, and "paste from text" entry point. Delegates folder traversal to `dropped-files.ts`. |
| `SavedMibsList` | Stored-file list with filtering, sorting, multi-select, and bulk delete/download. |
| `MibTreeView` | Virtualized tree view: flattens visible branches and renders only the viewport window. |
| `TreeNode` | Memoized, presentational component for a single tree row. |
| `TreeExpandControls` | Expand all, collapse all, and compact view toggle. |
| `SearchBar` | Search input and match counter. |
| `NodeDetails` | Details pane for the selected node (re-resolved by OID after each rebuild): OID, notation, source file, syntax, enumerated values, notification varbinds, description, and children. |
| `OidBreadcrumb` | Clickable `iso → org → dod → …` path above the details pane. |
| `ConflictNotificationPanel` | Banner listing files with conflicting module definitions, with a field-by-field diff dialog. |
| `NotificationPanel` | Persistent warnings and errors (missing dependencies, failed uploads). Exports `useNotifications`. |
| `StorageManager` | IndexedDB usage display, **Rebuild Tree**, and **Clear All** actions. |
| `MibContentModal` | Raw text viewer for a stored MIB file. |
| `LicensesModal` | Displays bundled third-party open-source license notices fetched from `third-party-licenses.json`. |
| `TextInputModal` | Modal for pasting raw MIB source instead of uploading a file. |
| `ConfirmModal` | Confirmation dialog for destructive actions. |
| `ResizablePanel` | Two-pane splitter that persists its width in `localStorage`. |

`App.tsx` wires these components together and owns transient view state (selection, search query, expanded OIDs). It holds no persisted MIB data of its own.

---

## Data Flow

### Adding a MIB

```text
FileUploader
   │ one call per file; skipReload = true for every file except the last
   ▼
useMibStorage.uploadMib(file)
   ├─ validateMibContent(text)          reject non-MIB files early
   ├─ parseMibModule(text, fileName)    extract the module name
   ├─ getMibByFileName(fileName)        reuse existing id if replacing a file
   ├─ saveMib(record)                   nodeCount and conflicts filled in later
   └─ (last file only) rebuildAllTrees()
```

The tree is built **once per batch**, not once per file. The parse performed on upload to read the module name is passed into the parse cache via `noteParsedModule`, so each uploaded file is parsed only once.

### Rebuilding the Merged Tree

`rebuildAllTrees()` is the central mutation path, triggered by upload, delete, JSON import, and the manual **Rebuild Tree** button.

```text
Main Thread                          Rebuild Worker
───────────                          ──────────────
getAllMibs()
   │ post { mibs } (include content
   │ only for uncached files)
   └──────────────────────────────▶  parse each file (reuse cached parses)
                                        ▼
                                     MibTreeBuilder.buildTree()
                                        ├─ "Missing MIB dependencies: X"
                                        │    → drop modules importing X,
                                        │      record error, retry (up to 10×)
                                        ├─ unplaced definitions (unknown anchor)
                                        │    → record error against source file
                                        ▼
                                     per-file bookkeeping
                                     (node counts, conflicts, errors)
   ┌──────────────────────────────◀  post { tree, tcs, files }
   ▼                                    ▼
apply bookkeeping to records         saveMergedTree()
publish to React state  ← UI ready      ▼
   ▼                                 post { persisted }
saveMibs(changed)      ◀────────────────┘
```

Key design points of this pipeline:
- **Render before persist:** The worker posts the built tree back before writing it to IndexedDB, so the UI renders immediately while persistence finishes in the background.
- **Minimal cross-thread payload:** Only file contents that the worker does not already hold in its parse cache are sent over `postMessage`. Sending all file text every time would cost roughly as much as parsing it.
- **No redundant read-back:** `loadData()` (full IndexedDB read) only runs on startup, after a failed rebuild, or after operations that don't rebuild (import, clear).

### Rendering Pipeline

```text
mergedTree
   │
   ▼ filterTreeToNotifications (when "Traps only" is on)
typeFilteredTree
   │
   ▼ filterTreeByQuery (using deferred search query)
filteredTree
   │
   ▼ flattenVisibleRows (using expandedOids & compactMode)
TreeRow[]
   │
   ▼ slice to viewport (+ overscan)
<TreeNode> rows
```

---

## State Ownership

| State | Owner | Persistence |
|---|---|---|
| Stored MIB records | `useMibStorage` | IndexedDB store `mibs` |
| Merged tree & TCs | `useMibStorage` | IndexedDB store `mergedTree` |
| Storage usage figures | `useMibStorage` | Derived (not persisted) |
| Selected node | `App` | — |
| Search query | `App` | — |
| Expanded OIDs | `App` (`Set<string>`) | — |
| Compact view | `App` | `localStorage`: `mib-browser-compact-mode` |
| Traps-only filter | `App` | `localStorage`: `mib-browser-notifications-only` |
| Panel widths | `ResizablePanel` | `localStorage`: `mib-browser-sidebar-width`, `mib-browser-panel-width` |
| Notifications | `useNotifications` in `App` | — |

Because expansion state is keyed by **OID string** rather than node object reference, it survives tree rebuilds—reloading a file keeps the tree open right where the user left it.

---

## Rendering the Tree

A merged tree of a few hundred vendor MIBs easily reaches tens of thousands of nodes, so the tree view never mounts all of them in the DOM.

### Virtualization (Flatten, Then Window)
`flattenVisibleRows()` walks only expanded branches to produce a flat `TreeRow[]`. `MibTreeView` renders a spacer sized to `rows.length * ROW_HEIGHT` and absolutely positions only the rows inside the viewport (plus `OVERSCAN` above and below). Expanding the entire tree therefore costs a constant number of DOM nodes.

> [!IMPORTANT]
> Every row has a fixed height of **28 px** (`ROW_HEIGHT` in `TreeNode.tsx`, Tailwind class `h-7`). If you change the row height class, update `ROW_HEIGHT` to match—windowing calculations rely on uniform row height.

### Compact View
Folds chains of single-child nodes into one row (`iso / org / dod / internet`). Interactions target the *last* node of the chain (its OID is added to `expandedOids` and selected on click), while `chainOids` tracks all intermediate OIDs so selection highlighting still works when navigating via the breadcrumb.

### Expansion
Held as a `Set<string>` of OIDs in `App`.
- **Collapsing** removes the target OID and all descendant OIDs in one pass using string prefix matching—no subtree traversal needed.
- **Selecting a node** expands the path to it, but preserves the `Set`'s object identity if the path is already open so the row model isn't needlessly rebuilt.

### Search
`filterTreeByQuery` filters the tree rather than merely highlighting, keeping nodes matching on name, OID, or description along with their ancestors. It runs on a `useDeferredValue` copy of the query so typing remains responsive while large trees re-filter at lower priority.

### Traps Only
`filterTreeToNotifications` keeps notification nodes (SMIv2 `NOTIFICATION-TYPE` and SMIv1 `TRAP-TYPE`) and their ancestors. It runs *before* search so searching while enabled searches within traps. Because only branches leading to traps remain, `App` expands them automatically.

---

## Persistence

### IndexedDB

Database: `mib-browser-db` (version 2). The connection is opened once and cached in `indexeddb.ts`, and automatically reopened if the browser closes it or another tab triggers a version change.

| Store | Key | Contents |
|---|---|---|
| `mibs` | `id` | One `StoredMibData` record per file: raw text, size, timestamps, module name, node count, conflicts, and dependency errors. Indexes: `fileName`, `uploadedAt`. |
| `mergedTree` | `id` | Single record `{ id: 'merged-tree', tree, textualConventions }` containing the built OID tree and all parsed `TEXTUAL-CONVENTION`s. |

Additional details:
- **Why store `textualConventions` with the tree?** The rebuild already parses every module. Storing collected TCs alongside the tree lets `NodeDetails` resolve `SYNTAX` enumerations via a fast lookup (checking inline `SYNTAX INTEGER { ... }` first, then the TC index) instead of re-parsing MIB files. Older trees without this field fall back to on-demand parsing.
- **Why store raw MIB text?** Rebuilds need the original source to re-parse, and `MibContentModal` displays it directly.
- **Thread ownership:** The rebuild worker writes `mergedTree`; the main thread writes `mibs`.
- **Storage usage readout:** Uses `navigator.storage.estimate().usage` (which reflects actual origin quota including the merged tree), falling back to summing stored file sizes if the API is unavailable.
- **Transaction safety:** Write promises resolve on transaction completion rather than request success, preventing false positives when a commit fails (e.g., quota exceeded).

### `localStorage`

Stores only lightweight UI preferences (compact view, traps-only filter, panel widths). On startup, `migrateFromLocalStorage()` migrates any legacy MIB data stored under `mib-browser-mibs` into IndexedDB and removes the old key.

### Escape Hatch (`?reset=true`)

Loading the app with **`?reset=true`** clears both IndexedDB stores before the initial render—useful if corrupted data prevents startup. The parameter is immediately stripped from the URL and is the only query parameter the app reads.

---

## Error & Conflict Surfaces

| Situation | Detected In | User Surface |
|---|---|---|
| **Not a MIB file** (missing `DEFINITIONS ::= BEGIN`, `END`, or object definitions) | `validateMibContent` on upload | Toast and notification panel entry. During folder import, counted as *skipped* instead of an error (since folders often include READMEs or archives). |
| **Missing dependency** (imports an unloaded module) | `MibTreeBuilder` throws; `rebuildAllTrees` marks dependents | Warning in notification panel and error badge on the file row. File stays stored with `nodeCount: 0` and resolves automatically once the missing MIB is uploaded. |
| **Conflicting definitions** (two files define the same module differently) | `rebuildAllTrees` field-by-field comparison | Conflict banner with a per-object diff dialog and delete action. |

A missing dependency never blocks the rest of the tree: affected modules are excluded and the build retries without them.
