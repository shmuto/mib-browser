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

**80 files / 5.4 MB / 16k nodes**, in-browser rebuild paths. Wall time is how
long the operation takes; blocked is how much of that the main thread spends
unable to respond (total time in tasks over 50 ms):

| Action | Wall | Main thread blocked |
|---|---|---|
| Bulk upload of 79 files (nothing cached) | ~1270 ms | ~90 ms |
| Adding one more file to those 79 | ~505 ms | ~105 ms |
| Rebuild Tree with nothing changed | ~455 ms | 0 ms |

Wall time is the less interesting number: parsing and building now happen in a
worker, so most of it is time the app is still usable. What remains on the main
thread is reading the records, receiving the tree, and rendering.

Where a rebuild's time goes at that size — worth knowing before optimizing it,
because the storage half is bigger than it looks:

| Stage | Time | Runs on |
|---|---|---|
| Read every stored MIB (`getAll`) | ~38 ms | main |
| Parse all files | ~185 ms | worker |
| Build the tree | ~55 ms | worker |
| **Write the merged tree** | **~176 ms** | worker |
| Receive the tree from the worker | ~76 ms | main |

And what it costs to move data across the worker boundary, which is what shapes
the design:

| | Time |
|---|---|
| Post 5.4 MB of MIB text to a worker | ~95 ms |
| Post the tree there and back | ~222 ms |
| `structuredClone` of the tree, one way | ~76 ms |

**60 files / ~12k nodes**, in-browser interactions:

| Action | Time |
|---|---|
| Upload (parse + build + persist) | ~625 ms |
| Expand All | ~85 ms |
| Collapse All | ~60 ms |
| Selecting a node | one frame |

"One frame" means the worst gap between animation frames after the click is
~17 ms, i.e. no visible stall. That is the number to watch for selection: a
regression here shows up as a gap of several frames, not as a slower average.

Parsing is the largest single CPU cost, but it is not the majority of a rebuild:
persisting the tree is comparable, and the reads on either side add more. Any
plan to make rebuilds cheaper has to account for the write, which no amount of
incremental parsing or building removes.

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
`TEXTUAL-CONVENTION` by parsing every stored MIB, on every selection.
*This was most of the 14x on node selection.*

**...and then re-parsed once after every file change.** Caching that index per
MIB list removed the per-click cost but left one full re-parse on the first node
click after any upload or delete — a 150–270 ms stall at 5 MB of MIBs, growing
with the collection. The rebuild already parses every module, so it now collects
the TEXTUAL-CONVENTIONs and stores them next to the merged tree; the details
panel does a map lookup. A tree stored before this still falls back to parsing
on demand.

**Selecting a node invalidated the whole row model.** The effect that expands
the path to the selected node always handed back a new `Set`, so every click
changed `expandedOids` by identity and made the tree view rebuild all of its
rows — the entire tree, once Expand All had been used. It now returns the
previous `Set` when the path is already expanded, and does not add the selected
node's own OID unless it has children, since expanding a leaf means nothing.
Leaves are most of what gets clicked, so without that second part the first part
almost never applies.

**Full-tree search per breadcrumb segment.** `OidBreadcrumb` searched the entire
tree for each OID in the path; it descends the path once instead.

**Every rebuild re-parsed every file.** Only the file that changed can have a
different body, so parsed modules are now kept in a session-scoped cache keyed
by MIB id, reused when the content is identical. The cache is deliberately *not*
persisted: a page reload does not rebuild — it renders the stored tree — so
persisting it would buy nothing and cost a serialization round trip. Uploading
also seeds the cache with the parse it already did to read the module name, so
a file is no longer parsed twice on the way in.

**The UI waited for the tree to be written.** A rebuild persisted the tree, then
re-read it (and every MIB record) to put it into React state. The state is now
published from what the rebuild already has in memory, before the write.
*Adding one file to 79: 644 → 195 ms.*

**The rebuild ran on the main thread.** Parsing, building and writing the tree
now happen in a Web Worker (`src/workers/rebuild.worker.ts`), so a rebuild no
longer freezes the app.
*Main thread blocked: 249 → 89 ms bulk, 309 → 105 ms adding a file, 145 → 0 ms
for Rebuild Tree.*

Two things had to be true for that to be worth doing, and the naive version of
it is a net **loss**:

- **The worker keeps the parse cache**, so only changed files' contents cross
  the boundary. Posting all 5.4 MB costs ~95 ms of main-thread serialization —
  about what parsing them costs, so sending everything every time would trade
  one main-thread cost for another.
- **The worker writes the merged tree.** Receiving the tree costs the main
  thread ~76 ms of deserialization, which is more than the ~55 ms build it took
  away. Only by also moving the ~176 ms write does the balance come out ahead.

The tree is posted back before it is written, so the UI renders the new tree
while the worker is still persisting it.

---

## Invariants worth keeping

Things that are load-bearing and not obvious from the code alone:

- **Every tree row is the same height.** The virtual window computes positions
  from `ROW_HEIGHT` (28 px). A row that can grow — wrapping text, a taller
  badge — breaks scrolling silently. Keep long text on `truncate`.
- **Expansion state is keyed by OID string.** That is what lets collapse work by
  prefix, and what lets expansion survive a rebuild.
- **`expandedOids` must keep its identity when nothing changed.** It is a
  dependency of the tree view's row model; handing back a fresh `Set` on every
  selection rebuilds every row.
- **Tree rows are recycled by position.** Rows are keyed by index so React can
  reuse the DOM while scrolling, which means any state a row keeps in a ref
  belongs to the *position*, not to the node. Anything node-specific must record
  which OID it belongs to — as the double-click detection does.
- **A `MibTreeBuilder` is single-use.** Its symbol, name and child maps
  accumulate across a build, so every build needs a fresh instance — this is
  why the retry loop in `rebuildAllTrees` constructs one each time round. The
  `ParsedModule[]` itself is not modified and can be reused.
- **Only changed file contents cross the worker boundary.** The worker holds the
  parse cache and the main thread tracks which ids it has sent. Sending
  everything each time costs about as much as the parsing the worker saves.
- **The worker writes the merged tree, not the main thread.** Moving that write
  back would make the worker a net loss, because receiving the tree already
  costs the main thread more than the build did.
- **A rebuild publishes state before it persists.** The React state is set from
  what the rebuild holds in memory; the IndexedDB writes follow. Anything that
  reads the tree back to populate state would put the write back on the
  critical path.
- **Regexes run over MIB text must be linear.** The content is a file the user
  supplied, so a pattern that backtracks quadratically is a way to hang the tab,
  and CodeQL flags it as `js/polynomial-redos`. Spell out the alternatives you
  mean rather than skipping ahead with something like `[^;]*?`: the module
  header pattern did that to allow `DEFINITIONS IMPLICIT TAGS ::=` and went
  quadratic — 1 s on 256 KB that never matched, and four times that on 512 KB.
  A quick check is to run a candidate against `'A DEFINITIONS x\n'.repeat(n)`
  for growing n and confirm the time grows with n rather than n².
- **The keyword guards in the parser must stay case-insensitive.** The block
  patterns are `/i`; a guard using `indexOf` on an uppercase literal would skip
  lower-case definitions.
- **Only the last file of a bulk upload triggers a rebuild.** If
  `skipReload` handling changes, uploading n files goes back to n rebuilds.

---

## Known remaining costs

- **Every mutation still rebuilds the whole tree.** The parse cache means only
  the changed file is re-parsed, but the tree is rebuilt from scratch and
  rewritten whole. See
  [INCREMENTAL_UPDATE_PROPOSAL_EN.md](./INCREMENTAL_UPDATE_PROPOSAL_EN.md),
  including the reassessment of what that would actually be worth.
- **The merged tree is written as one record.** ~176 ms at 16k nodes, and it
  scales with the tree. It is off the main thread now, but it is still a floor
  under how quickly a rebuild can finish.
- **The whole tree crosses the worker boundary.** ~76 ms of main-thread
  deserialization at 16k nodes, and it grows with the tree. Avoiding it would
  mean the UI querying the tree in the worker rather than holding it, which is a
  much larger change than anything here.
- **The row model covers every visible row, not just the rendered window.**
  `flattenVisibleRows` has to walk all expanded branches to know the list's
  height, so with Expand All on a large tree each rebuild allocates one row
  object per node. It is only rebuilt when the tree, the expansion set, compact
  mode or the query changes — keeping it that way is what keeps interaction
  cheap.
- **The tree is held twice in memory** during filtering: `filterTreeByQuery`
  returns copies of the matching nodes rather than a view.
