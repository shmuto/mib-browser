# Application Architecture

How the pieces of the MIB Browser fit together: what runs where, how a MIB file
travels from the drop zone to a row in the tree, and which module owns which
piece of state.

For the parsing and tree-building internals see
[MIB_TREE_CONSTRUCTION_EN.md](./MIB_TREE_CONSTRUCTION_EN.md); this document
covers everything around them.

## Table of Contents

1. [Overview](#overview)
2. [Module map](#module-map)
3. [Data flow](#data-flow)
4. [State ownership](#state-ownership)
5. [Rendering the tree](#rendering-the-tree)
6. [Persistence](#persistence)
7. [Error and conflict surfaces](#error-and-conflict-surfaces)
8. [Legacy modules](#legacy-modules)

---

## Overview

The application is **entirely client-side**. There is no backend, no API call,
and no MIB ever leaves the browser — the GitHub Pages deployment serves static
files and nothing else. Everything the user loads lives in IndexedDB in their
own browser and is theirs to clear.

```
┌───────────────────────────────────────────────────────────┐
│  React UI (src/components)                                │
│  file upload · MIB list · tree view · node details        │
└───────────────────────────────────────────────────────────┘
                          │  props / callbacks
                          ▼
┌───────────────────────────────────────────────────────────┐
│  useMibStorage (src/hooks)                                │
│  owns the MIB list, the merged tree and the rebuild cycle │
└───────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│  rebuild worker              │   │  Persistence             │
│  parse · build · write tree  │   │  indexeddb.ts            │
│  mib-parser · mib-tree-      │   │  mib-browser-db          │
│  builder · rebuild.ts        │◀─▶│  (both threads use it)   │
└──────────────────────────────┘   └──────────────────────────┘
```

The heavy work — parsing every MIB, merging them into a tree, and writing that
tree — runs in a Web Worker, so adding or removing a file does not freeze the
UI. If a worker cannot be created the same pipeline runs inline instead.

Stack: React 18 + TypeScript, Vite, Tailwind CSS, `lucide-react` /
`react-icons` for icons, `react-hot-toast` for transient messages. No state
management library — component state plus one hook is enough at this size.

---

## Module map

### `src/lib` — no React, pure logic

| File | Responsibility |
|---|---|
| `mib-parser.ts` | Turn MIB text into a `ParsedModule` (IMPORTS, objects with unresolved parent names, TEXTUAL-CONVENTIONs). Also `validateMibContent`, `filterTreeByQuery`, `filterTreeToNotifications`, `flattenTree`, `countTreeNodes`. |
| `mib-tree-builder.ts` | Merge many `ParsedModule`s into one OID tree (`MibTreeBuilder`, 3-pass). |
| `rebuild.ts` | The whole rebuild pipeline as one plain function: parse (with a session cache), build, per-file bookkeeping, persist the tree. Runs in the worker, or inline if there is none. |
| `rebuild-client.ts` | Main-thread side of the worker: request/response plumbing, tracking which file contents the worker already has, and the no-worker fallback. |
| `oid-utils.ts` | OID string handling: parse, compare, ancestry, `getOidPath`, name maps. |
| `indexeddb.ts` | All IndexedDB access. Nothing else touches the database. |
| `storage.ts` | Small helpers: `generateId`, `sanitizeFileName`, `formatFileSize`, `isValidStoredMibData`. |

### `src/workers`

| File | Responsibility |
|---|---|
| `rebuild.worker.ts` | Runs `rebuild.ts` off the main thread. Posts the finished tree back, then persists it and posts again. |

### `src/hooks`

| File | Responsibility |
|---|---|
| `useMibStorage.ts` | The single source of truth for stored MIBs and the merged tree. Owns upload, delete, import/export, and `rebuildAllTrees`, plus the session-scoped cache of parsed modules. |

### `src/components`

| Component | Responsibility |
|---|---|
| `FileUploader` | Drop zone and file dialog, multi-file upload with a progress bar, "paste from text" entry point. |
| `SavedMibsList` | The stored-file list: filter, sort, selection, bulk delete/download. |
| `MibTreeView` | The merged tree. Flattens the visible branches and renders a windowed slice of them. |
| `TreeNode` | One row of the tree. Presentational and memoized. |
| `TreeExpandControls` | Expand all / collapse all / compact view toggle. |
| `SearchBar` | Query input and result count. |
| `NodeDetails` | The selected node: OID, notation, source file, syntax, TEXTUAL-CONVENTION values (looked up in the index stored with the tree), description, children. |
| `OidBreadcrumb` | The iso → org → dod → … path above the node details, each segment clickable. |
| `ConflictNotificationPanel` | Banner listing files that define the same module differently, with a diff dialog. |
| `NotificationPanel` | Persistent warnings and errors (missing dependencies, failed uploads). Exports the `useNotifications` hook. |
| `StorageManager` | IndexedDB usage readout, "Rebuild Tree" and "clear everything". |
| `MibContentModal` | Raw text of a stored MIB. |
| `TextInputModal` | Paste MIB source instead of uploading a file. |
| `ConfirmModal` | Confirmation dialog used by the destructive actions. |
| `ResizablePanel` | Two-pane splitter; remembers its width in `localStorage`. |

`App.tsx` wires these together and owns the view state (selection, query,
expansion). It holds no persisted MIB data of its own.

---

## Data flow

### Adding a MIB

```
FileUploader
   │ one call per file; skipReload = true for every file but the last
   ▼
useMibStorage.uploadMib(file)
   │
   ├─ validateMibContent(text)          reject non-MIB files early
   ├─ parseMibModule(text, fileName)    only to learn the module name
   ├─ getMibByFileName(fileName)        reuse the id if replacing a file
   ├─ saveMib(record)                   nodeCount/conflicts filled in later
   │
   └─ (last file only) rebuildAllTrees() ─▶ loadData()
```

The tree is built **once** per batch, not once per file. The parse done on the
way in (to read the module name) is handed to the rebuild through the parse
cache, so a file is parsed once overall.

### Rebuilding the merged tree

`rebuildAllTrees()` is the expensive path, and every mutation ends in it: upload,
delete, JSON import, and the manual **Rebuild Tree** button.

```
main thread                          rebuild worker
───────────                          ──────────────
getAllMibs()
   │  post { mibs }, content only
   │  for files the worker lacks
   └──────────────────────────────▶  parse each file
                                     (cached parses reused)
                                        ▼
                                     MibTreeBuilder.buildTree()
                                        │
                                        ├─ "Missing MIB dependencies: X"
                                        │    → drop every module importing X,
                                        │      record the error, retry
                                        │      (up to 10 times)
                                        ▼
                                     per-file bookkeeping
                                     node counts, conflicts, errors
   ┌──────────────────────────────◀  post { tree, tcs, files }
   ▼                                    ▼
apply bookkeeping to records         saveMergedTree()
publish to React state  ← UI here       ▼
   ▼                                 post { persisted }
saveMibs(changed)      ◀────────────────┘
```

The tree is posted back before it is written, so the UI renders it while the
worker is still persisting. Nothing reads back what was just written.

Only the contents of files the worker has not already parsed are sent — posting
all of them costs about as much as parsing them, which would defeat the point.

`loadData()` — the full read from IndexedDB — now runs on startup, after a
failed rebuild, and after operations that do not rebuild (import, clear).

### Rendering

```
mergedTree ──▶ filterTreeToNotifications(traps only) ──▶ typeFilteredTree
                                                        │
                            filterTreeByQuery(deferred query)
                                                        ▼
                                                   filteredTree
                                                        │
                                    expandedOids, compactMode
                                                        ▼
                                            flattenVisibleRows()
                                                        │
                                              slice to the viewport
                                                        ▼
                                                  <TreeNode> rows
```

---

## State ownership

| State | Lives in | Persisted as |
|---|---|---|
| Stored MIB records | `useMibStorage` | IndexedDB store `mibs` |
| Merged tree | `useMibStorage` | IndexedDB store `mergedTree` |
| Storage usage figures | `useMibStorage` | derived, not persisted |
| Selected node | `App` | — |
| Search query | `App` | — |
| Expanded OIDs | `App` (`Set<string>`) | — |
| Compact view | `App` | `localStorage: mib-browser-compact-mode` |
| Traps-only filter | `App` | `localStorage: mib-browser-notifications-only` |
| Panel widths | `ResizablePanel` | `localStorage: mib-browser-sidebar-width`, `mib-browser-panel-width` |
| Notifications | `useNotifications` in `App` | — |

Expansion state is keyed by **OID string**, not by node object, so it survives a
tree rebuild: reloading a file leaves the tree open where the user left it.

---

## Rendering the tree

A merged tree of a few hundred vendor MIBs runs to tens of thousands of nodes,
so the tree view never renders all of it.

**Flatten, then window.** `flattenVisibleRows()` walks only branches that are
expanded and produces a flat `TreeRow[]`; the component renders a spacer sized
to `rows.length * ROW_HEIGHT` and absolutely positions just the rows that fall
inside the viewport (plus `OVERSCAN` above and below). Expanding everything
costs a constant number of DOM nodes rather than one per MIB object.

Rows are a fixed **28 px** (`ROW_HEIGHT` in `TreeNode.tsx`, `h-7` on the row).
Changing the row's height class means changing that constant too — the window
maths depends on every row being the same height.

**Compact view** folds a chain of single-child nodes into one row
(`iso / org / dod / internet`). The row acts on the *last* node of the chain: it
is that node's OID that goes into `expandedOids`, and clicking selects it.
`chainOids` keeps the whole chain so selection highlighting still works when the
user navigates to an intermediate node from the breadcrumb.

**Expansion** is a `Set<string>` of OIDs held by `App`. Collapsing removes the
OID *and every descendant OID* in one update, found by string prefix — there is
no walk of the subtree. Selecting a node expands the path to it, but the `Set`
keeps its identity when that path is already open: it is an input to the row
model, so replacing it rebuilds every row.

**Search** filters the tree rather than just highlighting: `filterTreeByQuery`
keeps nodes that match on name, OID or description, plus their ancestors. It
runs against a `useDeferredValue` copy of the query, so typing stays responsive
while a large tree is re-filtered at lower priority.

**Traps only** is the same shape of filter, on node type instead of text:
`filterTreeToNotifications` keeps `NOTIFICATION-TYPE` nodes and their ancestors.
It is applied to `mergedTree` *before* the search, so searching while the filter
is on searches the traps. What is left is only the branches leading to
notifications, so `App` expands them automatically — otherwise every trap would
still be several clicks deep.

---

## Persistence

### IndexedDB

Database `mib-browser-db`, version 2. The connection is opened once and cached
in `indexeddb.ts`; it is dropped and reopened if the browser closes it or
another tab requests a version change.

| Store | Key | Contents |
|---|---|---|
| `mibs` | `id` | One `StoredMibData` per file: original text, size, timestamps, module name, node count, and any conflicts or dependency errors. Indexes: `fileName`, `uploadedAt`. |
| `mergedTree` | `id` | A single record `{ id: 'merged-tree', tree, textualConventions }` holding the whole built tree, plus the TEXTUAL-CONVENTIONs collected while parsing. Written by the rebuild worker; the `mibs` store is written by the main thread. The rebuild has already parsed every module, so storing them saves the details panel from re-parsing every MIB to resolve a node's SYNTAX. Trees stored before this field existed simply lack it, and the details panel falls back to parsing on demand. |

Storing the original text of every file is deliberate: a rebuild needs to
re-parse everything, and the raw MIB is what the content viewer shows.

Reported usage is the sum of the stored file sizes, compared against
`navigator.storage.estimate()` — it is an approximation of what the origin is
using, not an exact IndexedDB figure.

### localStorage

Only UI preferences (compact view, panel widths). An older version stored MIBs
under `mib-browser-mibs`; `migrateFromLocalStorage()` moves any such data into
IndexedDB on startup and then removes it.

### Escape hatch

Loading the page with **`?reset=true`** clears both stores before the first
render, for when stored data is what is keeping the app from starting. The
parameter is stripped from the URL immediately, and it is the only query
parameter the app reads.

---

## Error and conflict surfaces

Three different things can go wrong with a MIB, and each has its own surface:

| Situation | Detected in | Shown by |
|---|---|---|
| Not a MIB file at all (no `DEFINITIONS ::= BEGIN`, no `END`, no object definitions) | `validateMibContent` during upload | Toast, plus an entry in the notification panel |
| Imports a module that has not been loaded | `MibTreeBuilder` throws; `rebuildAllTrees` marks the dependants | Warning in the notification panel, error badge on the file row. The file stays stored with `nodeCount: 0` and starts contributing as soon as the missing MIB is added. |
| Two files define the same module differently | `rebuildAllTrees`, comparing objects of same-named modules field by field | Conflict banner with a per-object diff and a delete action |

A missing dependency never blocks the rest of the tree: the affected modules are
dropped and the build is retried without them.

---

## Legacy modules

Not everything in `src` is wired up. These are dead as of now, kept here so
nobody mistakes them for live code:

- `src/lib/mib-merger.ts` — `findNodeByOid` / `getTreeStats`, unused.
- `src/components/ConflictDialog.tsx` — superseded by
  `ConflictNotificationPanel`, which has its own dialog.
- `parseMibFile()` and `buildTree()` in `mib-parser.ts` — the pre-3-pass flat
  parsing path. `parseMibModule()` + `MibTreeBuilder` replaced it.
- `test-mib-parser.ts` in the repository root — a scratch script that reads
  ARISTA MIBs from a `tmp/` directory that is not part of the repository. See
  [`test-data/`](../test-data/README.md) for the fixtures that replaced it.
