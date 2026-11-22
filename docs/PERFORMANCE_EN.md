# Performance

Where time goes when loading large MIB collections, what has already been optimized, the invariants that keep it fast, and how to measure before making changes.

## Table of Contents

1. [The Three Costs](#the-three-costs)
2. [How to Measure](#how-to-measure)
3. [Current Benchmarks](#current-benchmarks)
4. [Completed Optimizations](#completed-optimizations)
5. [Invariants Worth Keeping](#invariants-worth-keeping)
6. [Known Remaining Costs](#known-remaining-costs)

---

## The Three Costs

Performance work in this app falls into three categories with distinct scaling characteristics and failure modes:

| Category | Trigger | Scales With | Symptom When Slow |
|---|---|---|---|
| **Rebuild** | Any file added or removed | Total size of *all* stored MIBs | App stalls after upload or delete |
| **Render** | Expand, collapse, scroll, select | Number of *visible* rows | Tree stutters; Expand All hangs the tab |
| **Search** | Every keystroke | Size of the merged tree | Typing lags behind the keyboard |

Because **Rebuild** scales with the entire collection rather than what is visible on screen, it is the primary factor limiting how many MIBs can be loaded.

---

## How to Measure

### In the Browser

1. Generate a synthetic corpus:

```bash
node test-data/generate-large-corpus.mjs 60 200     # ~12k nodes, ~2 MB
node test-data/generate-large-corpus.mjs 400 150    # ~63k nodes, ~14 MB
```

2. Record with Chrome DevTools' **Performance** panel while exercising all three paths:
   - **Rebuild:** Drop the generated folder into the upload zone.
   - **Render:** Click **Expand All** and scroll.
   - **Search:** Type into the search box.
3. Reload with `?reset=true` between runs so each benchmark starts from an empty IndexedDB.

**Additional metrics to watch:**
- **DOM element count:** Run `document.querySelectorAll('div').length` after **Expand All**. It should stay in the low hundreds regardless of tree size. If it grows with node count, virtualization is broken.
- **Heap size:** Check memory after a rebuild—the tree is held both in memory and in IndexedDB.

### Outside the Browser (Library-Level)

`parseMibModule` and `MibTreeBuilder` have no DOM dependencies and can be benchmarked directly with Bun:

```ts
import { parseMibModule, flattenTree } from './src/lib/mib-parser';
import { MibTreeBuilder } from './src/lib/mib-tree-builder';

const modules = files.map(f => parseMibModule(f.content, f.name));

console.time('build');
const tree = new MibTreeBuilder().buildTree(modules);
console.timeEnd('build');

console.log(flattenTree(tree).length, 'nodes');
```

Run with `bun run <script>.ts`.

> [!NOTE]
> A `ParsedModule[]` array is safe to reuse across builds (`buildTree` does not mutate it), but a `MibTreeBuilder` **instance** is single-use—construct a new one for each build.

---

## Current Benchmarks

Reference points (not guarantees), measured on a synthetic corpus in Chromium with a warm cache.

### Library-Level (`400 modules / 14 MB / 63k nodes`)

| Stage | Time |
|---|---|
| `parseMibModule` (all files) | ~480 ms |
| `MibTreeBuilder.buildTree` | ~220 ms |
| `flattenTree` | ~3 ms |
| `filterTreeByQuery` | ~15–20 ms |

### In-Browser Rebuild Paths (`80 files / 5.4 MB / 16k nodes`)

*Wall time* is total elapsed duration; *Main thread blocked* is time spent in long tasks (>50 ms) where the UI cannot respond.

| Action | Wall Time | Main Thread Blocked |
|---|---|---|
| Bulk upload of 79 files (cold cache) | ~1270 ms | ~90 ms |
| Adding 1 file to those 79 | ~505 ms | ~105 ms |
| **Rebuild Tree** (nothing changed) | ~455 ms | 0 ms |

Because parsing, building, and tree persistence run in a Web Worker, most wall time happens while the UI remains interactive. Main-thread time is spent reading records, receiving the tree, and rendering.

### Rebuild Breakdown (`80 files / 5.4 MB / 16k nodes`)

| Stage | Time | Thread |
|---|---|---|
| Read all stored MIBs (`getAll`) | ~38 ms | Main |
| Parse all files | ~185 ms | Worker |
| Build tree | ~55 ms | Worker |
| **Write merged tree** | **~176 ms** | Worker |
| Receive tree from worker | ~76 ms | Main |

### Worker Boundary Overhead (`5.4 MB / 16k nodes`)

| Operation | Time |
|---|---|
| `postMessage` 5.4 MB of MIB text to worker | ~95 ms |
| `postMessage` tree round-trip | ~222 ms |
| `structuredClone` of the tree (one way) | ~76 ms |

### UI Interactions (`60 files / ~12k nodes`)

| Action | Time |
|---|---|
| Upload (parse + build + persist) | ~625 ms |
| Expand All | ~85 ms |
| Collapse All | ~60 ms |
| Select a node | 1 frame (~17 ms worst-case gap) |

> [!IMPORTANT]
> Parsing is the single largest CPU cost, but **persisting the merged tree** is comparable (~176 ms). Any plan to speed up rebuilds must account for the IndexedDB write, which incremental parsing or building alone does not eliminate.

---

## Completed Optimizations

Each item below fixed a specific super-linear bottleneck or stall. They are documented here because the naive implementation is often the obvious one and easy to reintroduce.

### Rendering

- **Virtualized tree rows** *(24,328 → 151 DOM elements at 12k nodes)*: `MibTreeView` flattens expanded branches into a `TreeRow[]` list and renders only the visible viewport window instead of recursively mounting every `TreeNode`.
- **Single-pass collapse:** Collapsing a node now removes the target OID and all descendant OIDs in one `Set` update using string prefix matching, replacing a quadratic loop that copied the `Set` per descendant.
- **Deferred search filtering:** Search queries pass through `useDeferredValue` so typing stays immediate while large trees re-filter at lower priority.

### Parsing & Tree Building

- **Single bottom-up search pass:** `filterTreeByQuery` previously re-scanned subtrees at every level. It now runs one bottom-up pass, allocates a `children` array only when matches exist, and matches descriptions with a case-insensitive regex rather than lowercasing every description string.
- **Root-only Pass 3 traversal** *(759 ms → 176 ms at 63k nodes)*: Pass 3 previously started from every seed node (recomputing `enterprises` 6–7 times). It now starts only from seeds without a seed parent.
- **Backtracking cycle-detection set:** `computeOidRecursive` reuses one `visited` `Set` (deleting on unwind) instead of allocating `new Set(visited)` per child.
- **Indexed duplicate detection:** A per-parent `name|subid` map (`childIndex`) replaces linear scans of `parent.children`, eliminating quadratic linking under `enterprises`.
- **Single-pass file masking** *(272 ms → 177 ms over 3.3 MB)*: Macro bodies and string literals are blanked once per file using space runs, and `OBJECT-TYPE` blocks slice into that masked copy by offset instead of re-masking per block.
- **Linear line-anchored regexes** *(536 ms → 4 ms on 20k comment lines)*: Line-start patterns changed from `^\s*` to `^[ \t]*` under the `/m` flag so whitespace-only stretches (like stripped comment blocks) cannot cause quadratic backtracking across newlines.
- **Keyword guards for rare constructs:** Cheap case-insensitive keyword checks skip scanning for constructs (`MODULE-COMPLIANCE`, `OBJECT-GROUP`, `NOTIFICATION-GROUP`, etc.) that a module doesn't contain.

### Storage & Data Flow

- **Cached IndexedDB connection:** `openDB()` reuses one connection instead of opening a new connection per file.
- **Batched metadata writes:** Rebuild bookkeeping updates all changed MIB records in a single IndexedDB transaction instead of one transaction per file.
- **Indexed lookups & counts:** Upload checks existing files via the `fileName` index (instead of reading every record), and delete checks emptiness with a count query.
- **Precomputed `TEXTUAL-CONVENTION` index:** `NodeDetails` previously re-parsed every MIB on every click (and later on the first click after any change—a 150–270 ms stall). Rebuilds now persist collected TCs alongside `mergedTree` so lookups are O(1).
- **Stable `expandedOids` on node selection:** Clicking a node returns the existing `Set` reference when its ancestor path is already expanded (and skips adding leaf OIDs), avoiding unnecessary full row-model rebuilds.
- **Single-descent breadcrumbs:** `OidBreadcrumb` walks the tree once along the OID path instead of searching the whole tree per segment.
- **In-memory session parse cache:** `rebuild.ts` caches `ParsedModule`s by MIB id (keyed on unchanged content), and upload seeds the cache with the initial module-name parse so files are parsed once. Deliberately not persisted—page reloads render the stored tree without rebuilding.
- **Publish state before persisting** *(adding 1 file to 79: 644 ms → 195 ms)*: React state updates directly from the in-memory rebuild result before IndexedDB writes finish, removing a redundant read-back.
- **Web Worker rebuild** *(main-thread blocked: 249 → 89 ms bulk, 309 → 105 ms add-1, 145 → 0 ms rebuild)*: Parsing, tree building, and persisting `mergedTree` run in `src/workers/rebuild.worker.ts`. Two constraints make this a net win:
  1. **Worker owns the parse cache** (avoiding ~95 ms of main-thread serialization to send all 5.4 MB of MIB text on every rebuild).
  2. **Worker writes `mergedTree`** (deserializing the returned tree costs ~76 ms on the main thread, which exceeds the ~55 ms build—offloading the ~176 ms write tips the balance).

---

## Invariants Worth Keeping

Load-bearing constraints that are easy to break accidentally:

### Rendering & UI
- **Fixed 28 px row height:** Virtualization calculates scroll offsets from `ROW_HEIGHT` (28 px / `h-7`). Wrapping text or taller badges will silently break scrolling—keep long text truncated.
- **OID-keyed expansion state:** Keying `expandedOids` by OID string enables O(n) prefix collapse and lets expansion survive rebuilds.
- **Stable `expandedOids` identity:** Returning a new `Set` when nothing changed forces `MibTreeView` to rebuild every row.
- **Position-keyed rows:** Virtualized rows are keyed by viewport index for DOM reuse. Any ref state inside a row belongs to the *slot*, not the node—tie node-specific state (like double-click tracking) to the node's OID.

### Tree Builder & Worker
- **`MibTreeBuilder` is single-use:** Internal maps accumulate state across a build; always instantiate a new builder per build (including inside retry loops). `ParsedModule[]` is safe to reuse.
- **Send only uncached file contents to the worker:** Sending all MIB text on every rebuild costs roughly as much as parsing it on the main thread.
- **Keep `mergedTree` writes in the worker:** Moving the write back to the main thread makes the worker a net loss.
- **Publish state before persisting:** Never re-read the tree from IndexedDB just to populate React state after a rebuild.
- **Batch bulk uploads:** Only the final file in a multi-file upload should trigger a rebuild (`skipReload` must stay `true` for earlier files).

### Parser
- **Linear regexes only:** MIB files are user-supplied, so polynomial backtracking can hang the tab (flagged by CodeQL as `js/polynomial-redos`). Avoid patterns like `[^;]*?` across unbounded text; test candidates against repeated non-matching inputs (e.g., `'A DEFINITIONS x\n'.repeat(n)`) to confirm linear scaling.
- **Case-insensitive keyword guards:** Block patterns use `/i`; guards must not use case-sensitive `indexOf` on uppercase literals.

---

## Known Remaining Costs

- **Full rebuild on every mutation:** While unchanged files hit the parse cache, the tree is still rebuilt and rewritten in full. See [INCREMENTAL_UPDATE_PROPOSAL_EN.md](./INCREMENTAL_UPDATE_PROPOSAL_EN.md) for why incremental updates are currently deferred.
- **Single-record tree write (~176 ms at 16k nodes):** Off the main thread, but still sets a floor on rebuild wall time and scales with tree size.
- **Full tree transfer across worker boundary (~76 ms at 16k nodes):** Avoiding main-thread deserialization would require keeping the tree inside the worker and querying slices asynchronously—a significantly larger architectural change.
- **Full visible row model:** `flattenVisibleRows` walks all expanded branches to compute total scroll height, allocating one row object per expanded node when the tree, expansion set, compact mode, or search query changes.
- **Double tree in memory during search:** `filterTreeByQuery` allocates copies of matching nodes rather than returning a view.
