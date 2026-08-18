# Performance

Where the time goes when a large MIB collection is loaded, what has already been
optimized, and how to measure before changing any of it.

## Table of Contents

1. [The three costs](#the-three-costs)
2. [Measuring](#measuring)
3. [Current numbers](#current-numbers)
4. [What was optimized and why](#what-was-optimized-and-why)
5. [Invariants worth keeping](#invariants-worth-keeping)
6. [Known remaining costs](#known-remaining-costs)

---

## The three costs

Work in this app falls into three groups, and they fail in different ways:

| | Runs when | Scales with | Symptom when slow |
|---|---|---|---|
| **Rebuild** | any file added or removed | total size of *all* stored MIBs | the app freezes for a moment after upload or delete |
| **Render** | expand, collapse, scroll, select | number of *visible* rows | the tree stutters, expanding everything hangs the tab |
| **Search** | every keystroke | size of the merged tree | typing lags behind the keyboard |

The rebuild is the one that scales with the collection rather than with what is
on screen, so it is the one that limits how many MIBs can be loaded at all.

---

## Measuring

### In the browser

Generate a corpus and load it:

```bash
node test-data/generate-large-corpus.mjs 60 200     # ~12k nodes, ~2 MB
node test-data/generate-large-corpus.mjs 400 150    # ~63k nodes, ~14 MB
```

Then, with the Performance panel recording, exercise the three costs: drop the
files in (rebuild), Expand All and scroll (render), type into the search box
(search). Use `?reset=true` to clear storage between runs so uploads start from
the same state.

Two numbers worth watching besides the timings:

- `document.querySelectorAll('div').length` after Expand All — this should stay
  in the low hundreds no matter how large the tree is. If it tracks the node
  count, the virtualization has been broken.
- Heap size after a rebuild — the tree is held in memory *and* in IndexedDB.

### Outside the browser

`parseMibModule` and `MibTreeBuilder` are plain functions with no DOM
dependency, so they can be timed directly:

```ts
import { parseMibModule, flattenTree } from './src/lib/mib-parser';
import { MibTreeBuilder } from './src/lib/mib-tree-builder';

const modules = files.map(f => parseMibModule(f.content, f.name));

console.time('build');
const tree = new MibTreeBuilder().buildTree(modules);
console.timeEnd('build');

console.log(flattenTree(tree).length, 'nodes');
```

Run it with `bun run <script>.ts`. A `ParsedModule[]` can be reused across
builds — `buildTree` does not modify it — but a `MibTreeBuilder` **instance**
cannot: it accumulates state in its maps, so construct a new one per build.

---

## Current numbers

Reference points, not guarantees. Synthetic corpus, Chromium, warm cache.

**400 modules / 14 MB / 63k nodes**, library level:

| Stage | Time |
|---|---|
| `parseMibModule` (all files) | ~480 ms |
| `MibTreeBuilder.buildTree` | ~220 ms |
| `flattenTree` | ~3 ms |
| `filterTreeByQuery` | ~15–20 ms |

**60 files / ~12k nodes**, in-browser interactions:

| Action | Time |
|---|---|
| Upload (parse + build + persist) | ~625 ms |
| Expand All | ~85 ms |
| Collapse All | ~60 ms |
| Selecting a node | ~40 ms |

Parsing now dominates the rebuild. That is expected: it is the only stage that
has to touch every byte of every file.

---

## What was optimized and why

Each of these fixed a specific super-linear behaviour. They are recorded because
the naive version of each is the obvious way to write it, and easy to
reintroduce.

### Rendering

**The whole tree was in the DOM.** `TreeNode` rendered itself and recursed into
its children, so Expand All produced one DOM subtree per MIB object — tens of
thousands of elements. `MibTreeView` now flattens the expanded branches into a
flat row list and renders only the window that is on screen.
*24,328 → 151 elements at 12k nodes.*

**Collapse was quadratic.** Collapsing a node called the expansion setter once
per descendant, and each call copied the whole `Set`. It is now one update that
drops the OID and every descendant OID by string prefix.

**Search filtered on every keystroke.** The query now goes through
`useDeferredValue`, so the input updates immediately and the filter runs at
lower priority.

### Parsing and tree building

**`filterTreeByQuery` re-scanned subtrees.** It asked "does this subtree contain
a match?" for a node and then asked the same question again for each of its
children — the whole subtree was walked once per level. It is now a single
bottom-up pass, allocating a children array only when a child is actually kept,
and matching descriptions with a case-insensitive regex instead of lower-casing
a copy of every description in the tree.

**Pass 3 walked the tree once per seed level.** OID computation started from
every seed node, but the seeds form a chain (`iso → org → dod → internet → …`),
so everything under `enterprises` was recomputed six or seven times. It now
starts only from seeds that have no seed parent.
*759 ms → 176 ms at 63k nodes.*

**The cycle-detection set was copied per child.** `computeOidRecursive` passed
`new Set(visited)` to each child. One set is now reused, with entries removed on
the way back up, which is equivalent because only the current root-to-node path
matters.

**Duplicate child detection scanned the children array.** Every parent link
searched the parent's existing children linearly — quadratic for `enterprises`
with hundreds of vendor MIBs under it. A per-parent `name|subid` index makes it
a map lookup.

**Absent constructs were still scanned for.** Each of the `MODULE-COMPLIANCE`,
`OBJECT-GROUP`, `NOTIFICATION-GROUP`, … patterns scans the whole file with a
lazy `[\s\S]*?`. A cheap keyword test now skips the ones a module does not use.

### Storage and data flow

**A connection per operation.** `openDB()` opened a new IndexedDB connection
every call, so a rebuild opened one per file. The connection is cached.

**A transaction per file.** Rebuild bookkeeping wrote each MIB record
individually; the records are collected and written in one transaction.

**Full reads for single lookups.** Upload read every stored MIB to find one by
file name — quadratic over a bulk upload. It uses the `fileName` index. Delete
read every record just to check whether any were left; it counts instead.

**Every MIB re-parsed on each node click.** `NodeDetails` looked for a matching
`TEXTUAL-CONVENTION` by parsing every stored MIB, on every selection. The index
is built once per MIB list. *This was most of the 14x on node selection.*

**Full-tree search per breadcrumb segment.** `OidBreadcrumb` searched the entire
tree for each OID in the path; it descends the path once instead.

---

## Invariants worth keeping

Things that are load-bearing and not obvious from the code alone:

- **Every tree row is the same height.** The virtual window computes positions
  from `ROW_HEIGHT` (28 px). A row that can grow — wrapping text, a taller
  badge — breaks scrolling silently. Keep long text on `truncate`.
- **Expansion state is keyed by OID string.** That is what lets collapse work by
  prefix, and what lets expansion survive a rebuild.
- **A `MibTreeBuilder` is single-use.** Its symbol, name and child maps
  accumulate across a build, so every build needs a fresh instance — this is
  why the retry loop in `rebuildAllTrees` constructs one each time round. The
  `ParsedModule[]` itself is not modified and can be reused.
- **The keyword guards in the parser must stay case-insensitive.** The block
  patterns are `/i`; a guard using `indexOf` on an uppercase literal would skip
  lower-case definitions.
- **Only the last file of a bulk upload triggers a rebuild.** If
  `skipReload` handling changes, uploading n files goes back to n rebuilds.

---

## Known remaining costs

- **Every mutation rebuilds everything.** Adding one file re-parses and rebuilds
  the entire collection. This is the dominant cost and the real ceiling on
  collection size — see
  [INCREMENTAL_UPDATE_PROPOSAL_EN.md](./INCREMENTAL_UPDATE_PROPOSAL_EN.md).
- **Parsing is single-threaded on the main thread.** A large corpus blocks the
  UI for the duration. Moving parsing into a worker would keep the app
  responsive even without incremental updates.
- **The merged tree is written to IndexedDB whole.** A structured clone of the
  entire tree on every rebuild.
- **Each file is parsed twice on upload** — once for its module name, once
  during the rebuild. Harmless for a few files, wasteful for hundreds.
- **The tree is held twice in memory** during filtering: `filterTreeByQuery`
  returns copies of the matching nodes rather than a view.
