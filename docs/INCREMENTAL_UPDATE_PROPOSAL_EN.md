# Incremental MIB Tree Update Proposal

> [!IMPORTANT]
> **Status: Partially implemented; full incremental updates deferred.**
> The high-value, low-risk parts of this proposal—an **in-memory session parse cache**, **publishing React state before persisting**, and **running rebuilds in a Web Worker**—have been implemented. Full differential tree updates remain deferred after profiling showed they would not address the remaining bottlenecks.
>
> See [PERFORMANCE_EN.md](./PERFORMANCE_EN.md) for current numbers and [MIB_TREE_CONSTRUCTION_EN.md](./MIB_TREE_CONSTRUCTION_EN.md) for how rebuilds work today.

## Table of Contents

1. [Summary of Current State](#summary-of-current-state)
2. [Reassessment After Measurement](#reassessment-after-measurement)
3. [What Was Implemented Instead](#what-was-implemented-instead)
4. [Why Full Incremental Updates Are Deferred](#why-full-incremental-updates-are-deferred)
5. [Summary of Evaluated Approaches](#summary-of-evaluated-approaches)

---

## Summary of Current State

Adding or deleting even a single MIB file still rebuilds the entire OID tree and writes it back to IndexedDB as a single record. While the rebuild runs off the main thread and skips re-parsing unchanged files, total work still scales with the **entire collection** rather than the changed file.

---

## Reassessment After Measurement

Profiling an **80-file / 5.4 MB / 16k-node** collection showed that four assumptions in the original incremental-update proposal did not hold:

### 1. Parsing Is Not the Majority of a Rebuild

| Stage | Time |
|---|---|
| Read all stored MIBs | ~38 ms |
| Parse all files | ~185 ms |
| Build the tree | ~55 ms |
| **Write the merged tree** | **~176 ms** |
| Read the tree back *(removed)* | ~34 ms |

Parsing accounted for ~30% of the total cost, not the bulk. Speedup estimates based on parse time alone were optimistic by roughly 3×.

### 2. Writing the Merged Tree Is a Floor Under Every Approach

Because `mergedTree` is persisted as a single IndexedDB record (~176 ms at 16k nodes, scaling with tree size), incremental parsing and incremental tree building cannot eliminate it. Reaching a 90–95% speedup would require splitting the tree across multiple records or deferring persistence.

### 3. Differential Updates Cannot Run Against the Stored Tree

Persisted `MibNode` records do not retain builder metadata (`parentName`, `subid`) or orphan nodes:

```text
Stored MibNode keys: access, children, description, fileName, isExpanded,
                     mibName, name, oid, parent, status, syntax, type
Has subid?           false
Has parentName?      false
Includes orphans?    false
```

`convertToMibNode()` strips resolution fields, and orphans are never linked into the tree. Differential updates would require persisting the larger `TreeBuildNode` structure (making the IndexedDB write even slower) or keeping the builder state alive in memory.

### 4. The Parse Cache Should Not Be Persisted

Persisting parsed modules to IndexedDB adds serialization overhead for zero benefit: a page reload renders the stored `mergedTree` directly without rebuilding, so the parse cache is only ever read within the active session. An in-memory `Map` is simpler and strictly faster.

---

## What Was Implemented Instead

Three changes delivered most of the responsiveness gains without changing the persisted data model:

1. **In-memory session parse cache (`src/lib/rebuild.ts`):** Keyed by MIB id and reused whenever file content is unchanged. Upload seeds the cache with the initial module-name parse so new files are parsed once.
2. **Publish React state before persisting:** UI state updates from the in-memory rebuild result immediately, eliminating the redundant IndexedDB read-back.
   - *At 80 files / 16k nodes:* add 1 file `644 → 195 ms`, Rebuild Tree `540 → 185 ms`, bulk upload of 79 files `1207 → 784 ms`, delete 1 file `680 → 413 ms`.
3. **Web Worker rebuild (`src/workers/rebuild.worker.ts`):** Parsing, tree building, and writing `mergedTree` all run off the main thread for **responsiveness** (not parallelism):
   - *Main-thread blocking:* bulk upload `249 → 89 ms`, add 1 file `309 → 105 ms`, Rebuild Tree `145 → 0 ms`.
   - Two details make this a net win: the worker holds the parse cache (avoiding ~95 ms of main-thread serialization to send 5.4 MB of MIB text) and writes `mergedTree` (offsetting the ~76 ms main-thread deserialization cost of receiving the tree).

---

## Why Full Incremental Updates Are Deferred

**Re-measure before building anything else.** With parsing cached and rebuilds running in a Web Worker, main-thread blocking is down to ~90–105 ms—mostly deserializing the tree returned by the worker, which incremental tree building would not remove.

Given the high correctness risk of differential tree updates (where subtle bugs like a wrong OID or silently missing node are hard to detect), further work should only be reconsidered if real-world collections outgrow the current worker architecture.

---

## Summary of Evaluated Approaches

| Approach | Idea | Risk / Limitation | Status |
|---|---|---|---|
| **In-memory parse cache + Web Worker** | Keep full tree build, cache unchanged `ParsedModule`s in memory, run build + write off the main thread | Still rewrites the full tree record | **Implemented** |
| **Differential updates (Add only)** | Analyze affected scope, merge new nodes, recompute affected OIDs | Requires `TreeBuildNode` metadata not stored in IndexedDB; does not remove full tree write | Deferred |
| **Differential updates (Add + Remove)** | Same as above plus orphan re-linking on deletion | High complexity and correctness risk; same storage floor | Deferred |
