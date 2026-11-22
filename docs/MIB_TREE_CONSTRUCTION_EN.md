# MIB Tree Construction Logic

How raw MIB text becomes a unified SNMP OID tree.

> [!NOTE]
> For the surrounding application (UI, state ownership, Web Worker plumbing, and IndexedDB), see [ARCHITECTURE_EN.md](./ARCHITECTURE_EN.md). For benchmarks and optimizations, see [PERFORMANCE_EN.md](./PERFORMANCE_EN.md).

## Table of Contents

1. [Overview](#overview)
2. [Data Structures & Symbol Maps](#data-structures--symbol-maps)
3. [Parsing (`mib-parser.ts`)](#parsing-mib-parserts)
4. [3-Pass Tree Construction (`mib-tree-builder.ts`)](#3-pass-tree-construction-mib-tree-builderts)
5. [Error Handling & Recovery](#error-handling--recovery)
6. [Rebuild Pipeline & Conflict Detection](#rebuild-pipeline--conflict-detection)
7. [End-to-End Flow Diagram](#end-to-end-flow-diagram)
8. [Key Design Decisions](#key-design-decisions)
9. [Critical Functions Summary](#critical-functions-summary)
10. [Complexity & Performance](#complexity--performance)
11. [Troubleshooting Guide](#troubleshooting-guide)

---

## Overview

The MIB tree builder parses multiple MIB modules and merges them into a single SNMP OID hierarchy regardless of load order. The core algorithm lives in `MibTreeBuilder` (`src/lib/mib-tree-builder.ts`) and runs in **three passes** (plus an orphan-rescue step between Pass 2 and Pass 3).

### Key Files

| File | Purpose |
|---|---|
| `src/lib/mib-parser.ts` | MIB grammar parsing, masking, `SYNTAX` and `TRAP-TYPE` extraction, tree filtering |
| `src/lib/mib-tree-builder.ts` | Core 3-pass tree construction (`MibTreeBuilder`) |
| `src/lib/oid-utils.ts` | `getOidPath` — computes every OID prefix from root to target |
| `src/lib/rebuild.ts` | Full rebuild pipeline, parse cache, error recovery, conflict detection |
| `src/workers/rebuild.worker.ts` | Runs `rebuild.ts` off the main thread |
| `src/hooks/useMibStorage.ts` | React lifecycle integration and state publishing |
| `src/lib/indexeddb.ts` | Tree and MIB persistence |

---

## Data Structures & Symbol Maps

Authoritative TypeScript definitions live in `src/types/mib.ts`.

### Core Types

#### `ParsedModule` (Parser Output)
```typescript
interface ParsedModule {
  moduleName: string;              // Module name
  fileName: string;                // Source file name
  imports: Map<string, string>;    // { "SymbolName": "SourceModuleName" }
  objects: RawMibObject[];         // OID assignments and OBJECT-TYPE definitions
  textualConventions?: TextualConvention[];
}
```

#### `RawMibObject` (Unresolved Definition)
Parsed from text, with an unresolved parent *name* and relative sub-identifier(s):
```typescript
interface RawMibObject {
  name: string;
  parentName: string;           // Unresolved parent name (e.g., "system")
  subid: number | number[];     // Single subid, or array for { parent 3011 7124 3282 }
  type: string;                 // "OBJECT-TYPE" | "OBJECT IDENTIFIER" | "TRAP-TYPE" | ...
  description?: string;
  syntax?: string;
  access?: string;
  status?: string;
  fileName?: string;
}
```

#### `MibNode` (Final Output)
```typescript
interface MibNode {
  oid: string;            // Absolute OID (e.g., "1.3.6.1.2.1.1.1")
  name: string;           // Node name (e.g., "sysDescr")
  parent: string | null;  // Parent's OID string (not an object reference)
  type: string;           // Definition type
  syntax: string;         // Whole SYNTAX clause: "INTEGER { up(1), down(2) }"
  access: string;         // ACCESS / MAX-ACCESS
  status: string;         // STATUS
  description: string;    // DESCRIPTION
  children: MibNode[];    // Child nodes
  isExpanded?: boolean;
  mibName?: string;       // Source module name
  fileName?: string;      // Source file name
  variables?: string[];   // VARIABLES (SMIv1) / OBJECTS (SMIv2) of a notification
}
```

#### `TreeBuildNode` (Builder Working Node)
Extends `MibNode` with temporary resolution fields. `parent` (inherited from `MibNode`) holds the parent's **OID string** once filled in during Pass 3; the tree links themselves live in `children`.
```typescript
interface TreeBuildNode extends MibNode {
  parentName?: string | null;   // Unresolved parent name
  subid?: number | number[];    // Position under the parent
  moduleName: string;           // Source module name
}
```

### Symbol Maps Used by `MibTreeBuilder`

| Map | Type | Purpose |
|---|---|---|
| `symbolMap` | `Map<string, TreeBuildNode>` | Keyed by `"ModuleName::ObjectName"` (e.g., `"SNMPv2-MIB::system"`). O(1) module-scoped resolution. Seed nodes use `"SNMPv2-SMI"`. |
| `nameMap` | `Map<string, TreeBuildNode[]>` | Keyed by `"ObjectName"`. Supports cross-module fallback when a name is globally unique. |
| `importsMap` | `Map<string, Map<string, string>>` | Maps `ModuleName → { ImportedSymbol → SourceModule }`. Drives `IMPORTS`-based parent lookup. |
| `seedMap` | `Map<string, TreeBuildNode>` | Direct lookup of predefined standard seed nodes by name. |
| `childIndex` | `Map<TreeBuildNode, Map<string, TreeBuildNode>>` | Per-parent child lookup keyed by `"name\|subid"`. Makes duplicate detection O(1) instead of scanning `children`. |

---

## Parsing (`mib-parser.ts`)

Before `MibTreeBuilder` ever runs, `parseMibModule()` extracts `IMPORTS`, object definitions, `TRAP-TYPE`s, and `TEXTUAL-CONVENTION`s from raw MIB text. Several real-world MIB quirks are handled at this stage:

### 1. Pre-Scan Masking
Real MIB files contain text that looks like object definitions inside comments, macros, and descriptions. Three passes clean the text before definition regexes run:

1. **Strip comments** using RFC 2578 rules (`removeComments`).
2. **Blank `<NAME> MACRO ::= BEGIN ... END` blocks:** Standard SMI modules define macros whose bodies contain the same keywords as real definitions. Without blanking, an `END` directly above `OBJECT-IDENTITY MACRO ::=` in `SNMPv2-SMI` was misread as an object named `END` stealing `zeroDotZero`'s `::= { 0 0 }`.
3. **Blank string literal contents:** `DESCRIPTION` fields often quote example definitions (e.g., `IF-MIB` writes `noTest OBJECT IDENTIFIER ::= { 0 0 }` inside `ifTestType`'s description).

Both blanking passes preserve character offsets and newlines, so matches in the masked copy map back to the original text by index to extract `DESCRIPTION`s accurately.

### 2. Hyphenated Identifiers
Standard MIB descriptors contain hyphens (`mib-2`, `member-body`). Matching with `\w+` stops at the hyphen (turning `mib-2` into `2`), so identifiers are matched with `[A-Za-z][\w-]*` throughout.

### 3. `SYNTAX` Clauses
A `SYNTAX` clause runs until the next clause keyword, but the value itself can contain keywords inside braces or constraints—for example `INTEGER { status(2), index(3) }` or `DisplayString (SIZE (0..255))`.
- `extractSyntaxClause()` scans forward tracking brace, parenthesis, and string depth, ending only at a keyword at depth `0`.
- The full clause is stored on the node; `parseSyntaxValues()` splits it into a base type plus enumerated values or a range when the details panel needs them (sharing logic with `TEXTUAL-CONVENTION` parsing).

### 4. Multi Sub-Identifier Assignments & Root Arcs
- **Multi-subid assignments** like `::= { enterprises 30065 3011 7124 3282 }` are stored as an array (`subid: [30065, 3011, 7124, 3282]`) and joined directly onto the parent's OID in Pass 3.
- **Root-arc anchors** may start at a numeric arc (`::= { 1 3 6 1 4 1 99999 }`) or a named-number root arc (`::= { iso(1) std(0) iso8802(8802) ... }`, common in IEEE 802.1 modules). `ccitt` (`0`) and `joint-iso-ccitt` (`2`) are seeded alongside `iso` (`1`) to support `zeroDotZero` (`0.0`) and other root arcs; roots with no children are hidden from the UI.

### 5. SMIv1 `TRAP-TYPE`
SMIv1 traps (RFC 1215) carry an `ENTERPRISE` node and a specific-trap number rather than an OID:

```asn1
v1CardRemoved TRAP-TYPE
    ENTERPRISE  testV1Traps
    VARIABLES   { v1TrapReason }
    DESCRIPTION "A card was removed."
    ::= 1
```

`extractTrapTypes()` maps these per RFC 3584 section 3.1 (`<enterprise>.0.<specific>`) using the multi-subid mechanism:

```typescript
node.parentName = "testV1Traps";
node.subid = [0, 1];
node.oid = "1.3.6.1.4.1.99999.5.0.1";
```

- Traps resolve like any other node (missing `ENTERPRISE` modules trigger standard missing-dependency reports).
- `VARIABLES` (and SMIv2 `OBJECTS`) are stored in `node.variables` for the details panel, and `isNotificationNode()` matches both `TRAP-TYPE` and `NOTIFICATION-TYPE` for the **Traps Only** filter.
- Each trap block is sliced from its header line to the next header line so a malformed block missing `::=` cannot swallow the following trap.
- *Limitation:* The six generic RFC 1215 traps (`ENTERPRISE snmp`) map to `snmp.0.<n>` rather than their fixed RFC 3584 `snmpTraps` OIDs.

---

## 3-Pass Tree Construction (`mib-tree-builder.ts`)

### Pass 1: Symbol Registration (`pass1_registerSymbols`)

Extracts every symbol from all parsed modules into lookup maps without linking parents or computing OIDs.

1. **Seed Nodes (`registerSeedNodes`):** Creates 23 predefined standard SNMP hierarchy nodes:
   ```text
   iso (1)
     └─ org (1.3)
          └─ dod (1.3.6)
               └─ internet (1.3.6.1)
                    ├─ directory (1.3.6.1.1)
                    ├─ mgmt (1.3.6.1.2)
                    │    └─ mib-2 (1.3.6.1.2.1)
                    │         ├─ system (1.3.6.1.2.1.1)
                    │         ├─ interfaces (1.3.6.1.2.1.2)
                    │         ├─ at (1.3.6.1.2.1.3)
                    │         ├─ ip (1.3.6.1.2.1.4)
                    │         ├─ icmp (1.3.6.1.2.1.5)
                    │         ├─ tcp (1.3.6.1.2.1.6)
                    │         ├─ udp (1.3.6.1.2.1.7)
                    │         ├─ egp (1.3.6.1.2.1.8)
                    │         ├─ transmission (1.3.6.1.2.1.10)
                    │         └─ snmp (1.3.6.1.2.1.11)
                    ├─ experimental (1.3.6.1.3)
                    ├─ private (1.3.6.1.4)
                    │    └─ enterprises (1.3.6.1.4.1)
                    ├─ security (1.3.6.1.5)
                    ├─ snmpV2 (1.3.6.1.6)
                    └─ mail (1.3.6.1.7)
   ```
   *(Plus `ccitt (0)` and `joint-iso-ccitt (2)` for root-arc anchors.)*
2. **Module Symbols:** Wraps each `RawMibObject` in a `TreeBuildNode` and registers it in `symbolMap` (`"ModuleName::ObjectName"`) and `nameMap` (`"ObjectName"`).
3. **`IMPORTS` Map:** Records each module's `Symbol → SourceModule` mappings in `importsMap`.

---

### Pass 2: Parent Linking (`pass2_linkParents`)

Connects each node to its parent using `resolveParent()` in strict priority order:

```typescript
function resolveParent(node: TreeBuildNode, moduleName: string): TreeBuildNode | null {
  const parentName = node.parentName;
  if (!parentName) return null;

  // 1. Same module
  const sameModule = symbolMap.get(`${moduleName}::${parentName}`);
  if (sameModule) return sameModule;

  // 2. Declared IMPORTS source
  const declaredSource = importsMap.get(moduleName)?.get(parentName);
  if (declaredSource) {
    const imported = symbolMap.get(`${declaredSource}::${parentName}`);
    if (imported) return imported;
  }

  // 3. Standard seed nodes (by name)
  const seed = seedMap.get(parentName);
  if (seed) return seed;

  // 3b. Numeric root arc (e.g., ::= { 1 3 6 1 4 1 99999 })
  if (/^\d+$/.test(parentName)) {
    const rootArc = seedNodes.find(s => s.oid === parentName);
    if (rootArc) return rootArc;
  }

  // 4. Global fallback: only if unique AND not explicitly imported from elsewhere
  if (declaredSource) return null;
  const candidates = nameMap.get(parentName);
  return candidates?.length === 1 ? candidates[0] : null;
}
```

Why this order matters:
- **Respecting `IMPORTS`:** If a module explicitly imports an anchor from `VENDOR-B-SMI`, step 4 is skipped so it cannot accidentally attach to a same-named node in an unrelated vendor's module. Instead, it becomes an orphan and triggers a clear missing-dependency report. Step 3 runs first because modules commonly import `enterprises` from `SNMPv2-SMI` without loading `SNMPv2-SMI` itself.
- **Numeric root arcs:** `::= { 1 3 6 ... }` starts with the numeric arc `1` (`iso`), handled by step 3b.

#### Duplicate Detection & Merging (`attachChild`)
Two files may define the same node (same `name` and `subid` under the same parent). `attachChild()` uses the parent's `childIndex` keyed by `childKey(node)` (distinguishing array subids `a3011.7124` from numeric subids `n12`):

```typescript
function attachChild(parent: TreeBuildNode, node: TreeBuildNode): void {
  parent = resolveMerged(parent);
  node = resolveMerged(node);
  if (parent === node) return;

  const index = getChildIndex(parent);
  const key = childKey(node);
  const existing = index.get(key);

  if (!existing) {
    parent.children.push(node);
    index.set(key, node);
    return;
  }
  if (existing === node) return;

  // Merge duplicate: redirect future references and re-attach children recursively
  mergedInto.set(node, existing);
  const grandChildren = node.children;
  node.children = [];
  for (const grandChild of grandChildren) attachChild(existing, grandChild);
}
```

- Whichever definition is linked first survives in the tree; the files are still compared afterward for conflict reporting.
- `mergedInto` ensures that subsequent objects referencing a merged-away anchor in `symbolMap` are redirected to the surviving node instead of disappearing into a detached subtree.

Nodes whose parent cannot be found are added to `orphanNodes`.

---

### Pass 2.5: Orphan Rescue (`pass2_5_rescueOrphans`)

Retries linking nodes in `orphanNodes` for up to **3 rounds** (stopping early once `orphanNodes` is empty). Each round re-runs `resolveParent()` and `attachChild()`, handling chains of out-of-order definitions where a newly rescued node becomes the parent for another orphan.

---

### Pass 3: OID Computation (`pass3_computeOids`)

Computes absolute OIDs top-down from root seed nodes:

```typescript
function computeOidRecursive(node: TreeBuildNode, visited: Set<string>): void {
  const key = `${node.moduleName}::${node.name}`;
  if (visited.has(key)) {
    console.error('[Cycle Detected]', key);
    return;
  }
  visited.add(key);

  for (const child of node.children) {
    if (node.oid && child.subid !== undefined) {
      child.oid = Array.isArray(child.subid)
        ? `${node.oid}.${child.subid.join('.')}`
        : `${node.oid}.${child.subid}`;
      child.parent = node.oid;
    }
    computeOidRecursive(child, visited);
  }

  visited.delete(key); // Track current root-to-node path only
}

for (const seed of seedNodes) {
  if (seed.parentName) continue; // Start only from top-level roots
  computeOidRecursive(seed, new Set());
}
```

- **Backtracking `visited`:** Removing `key` on unwind lets one `Set` track the active ancestor path without false-positive cycle reports or O(nodes × depth) set allocations.
- **Root-only starts:** Because seed nodes form a chain (`iso → org → dod → ...`), starting only from parentless roots ensures every subtree is computed exactly once.

### OID Path Helper (`src/lib/oid-utils.ts`)
`getOidPath(oid)` returns every prefix from the root to the given OID (tolerating a leading dot), used by breadcrumbs and auto-expansion:
```typescript
getOidPath("1.3.6.1.2") // → ["1", "1.3", "1.3.6", "1.3.6.1", "1.3.6.1.2"]
```

---

## Error Handling & Recovery

### Missing Dependencies vs. Unresolved Anchors

After Pass 2.5, remaining orphans fall into two categories:

1. **Missing dependencies (`detectMissingMibs`):** An orphan whose `parentName` is listed in its module's `IMPORTS`. `buildTree()` throws an error naming the missing modules (`Missing MIB dependencies: ...`).
2. **Unresolved anchors (`getUnresolvedOrphans`):** An orphan whose `parentName` is neither defined anywhere nor listed in `IMPORTS`. These cannot be placed in the tree; `rebuild.ts` attributes them to their source files (`RebuildResult.unplacedFiles`) so the UI surfaces a warning while keeping the rest of the file's definitions in the tree.

### Automatic Exclusion & Retry (`rebuild.ts`)

When `buildTree()` throws a missing-dependency error, `runRebuild()` catches it, excludes every module that depends on the missing MIBs, records the error on those files, and retries with a fresh `MibTreeBuilder` instance (up to **10 retries**). A single broken or incomplete MIB never blocks the rest of the collection.

---

## Rebuild Pipeline & Conflict Detection

### Triggers
A rebuild runs on:
1. MIB file upload (once at the end of a multi-file batch)
2. MIB file deletion
3. JSON import
4. Manual **Rebuild Tree** button click

### Pipeline Steps (`src/lib/rebuild.ts`)
1. **Resolve modules:** Reuse unchanged `ParsedModule`s from the session-scoped `parseCache`; parse only new or modified files.
2. **Build tree:** Run `MibTreeBuilder.buildTree(modules)` with the missing-dependency exclusion/retry loop.
3. **Bookkeeping:** Flatten the tree to compute per-file node counts, record unplaced-anchor warnings, and run conflict detection.
4. **Publish & persist:** Post `{ tree, textualConventions, files }` back to the main thread so React renders immediately, then persist `mergedTree` to IndexedDB in the worker while the main thread writes changed MIB metadata in a single batched `saveMibs()` transaction.

### Conflict Detection

Two kinds of conflicts are reported in each file's `conflicts` array:

1. **Same module name across multiple files:** Objects with the same name are compared field by field (`type`, `syntax`, `access`, `status`, `description`). Any differences are attached to both files for the conflict diff dialog.
2. **Same OID across different modules:** Because nodes are identified by OID, two differently named objects landing on the same OID (commonly caused by loading two revisions of a vendor MIB where an object was renamed) are flagged with a `name` difference. *(Objects with the same name **and** OID are merged in Pass 2 and are not collisions.)*

---

## End-to-End Flow Diagram

```text
MIB File Upload / Delete / Rebuild
        │
        ▼
[Main Thread] getAllMibs() → post uncached contents to Rebuild Worker
        │
        ▼
[Worker] parseMibModule() (reusing session parseCache)
        │  • Strip comments, mask MACROs & strings
        │  • Extract IMPORTS, objects, TRAP-TYPEs, TEXTUAL-CONVENTIONs
        ▼
[Worker] MibTreeBuilder.buildTree(modules)
        ├─ Pass 1:   Register 23+ seed nodes & all module symbols into maps
        ├─ Pass 2:   Resolve parents (same module → IMPORTS → seeds → unique global)
        │            Merge duplicates via childIndex + mergedInto
        ├─ Pass 2.5: Rescue orphans (up to 3 rounds)
        ├─ Check:    Missing imports? → exclude dependents & retry (up to 10×)
        │            Unresolved anchors? → record against source file
        └─ Pass 3:   Compute absolute OIDs top-down from root seeds (cycle-safe)
        │
        ▼
[Worker] Per-file bookkeeping (node counts, conflicts, errors)
        │
        ├──────────────────────────────┐
        ▼                              ▼
[Main Thread]                   [Worker]
  • Publish state to React        • saveMergedTree() → IndexedDB
  • MibTreeView renders           • post { persisted }
    virtualized window
  • saveMibs(changed) (1 tx)
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **3-pass separation** | Decoupling registration, linking, and OID computation naturally handles forward references and keeps each stage independently testable. |
| **Predefined seed nodes** | Guarantees a valid standard SNMP root hierarchy (`iso(1)` down to `enterprises` and `mib-2`) even when `SNMPv2-SMI` isn't uploaded. |
| **Multi-map indexing** | `symbolMap`, `nameMap`, `importsMap`, and `childIndex` keep parent lookup and duplicate detection O(1). |
| **Orphan rescue loop** | Makes the builder independent of file upload order while bounding retries to prevent infinite loops. |
| **Error isolation** | Excluding modules with missing dependencies ensures one incomplete file never prevents viewing the rest of the MIBs. |
| **Worker + in-memory parse cache** | Offloads parsing, tree building, and IndexedDB tree writes off the main thread so the UI stays responsive. |
| **Persisted merged tree** | Avoids rebuilding on page reload; startup renders directly from IndexedDB. |

---

## Critical Functions Summary

| Function | File | Responsibility |
|---|---|---|
| `parseMibModule()` | `mib-parser.ts` | Parse MIB text into a `ParsedModule` |
| `validateMibContent()` | `mib-parser.ts` | Reject non-MIB files on upload |
| `extractTrapTypes()` | `mib-parser.ts` | Map SMIv1 `TRAP-TYPE` to `<enterprise>.0.<specific>` |
| `extractSyntaxClause()` | `mib-parser.ts` | Read a full `SYNTAX` clause across nested braces/constraints |
| `parseSyntaxValues()` | `mib-parser.ts` | Split `SYNTAX` into base type, enums, and range |
| `filterTreeByQuery()` | `mib-parser.ts` | Filter tree to search matches and ancestors |
| `filterTreeToNotifications()` | `mib-parser.ts` | Filter tree to `NOTIFICATION-TYPE` / `TRAP-TYPE` nodes |
| `MibTreeBuilder.buildTree()` | `mib-tree-builder.ts` | Orchestrate the 3-pass build |
| `registerSeedNodes()` | `mib-tree-builder.ts` | Seed the standard SNMP hierarchy |
| `pass1_registerSymbols()` | `mib-tree-builder.ts` | Register all module symbols into maps |
| `pass2_linkParents()` | `mib-tree-builder.ts` | Link nodes to parents and collect orphans |
| `pass2_5_rescueOrphans()` | `mib-tree-builder.ts` | Retry unresolved orphans (up to 3 rounds) |
| `pass3_computeOids()` | `mib-tree-builder.ts` | Compute absolute OIDs from root seeds |
| `resolveParent()` | `mib-tree-builder.ts` | Resolve a node's parent with priority fallbacks |
| `attachChild()` / `resolveMerged()` | `mib-tree-builder.ts` | Link children and merge duplicate definitions |
| `detectMissingMibs()` | `mib-tree-builder.ts` | Identify unloaded modules referenced by orphans |
| `runRebuild()` | `rebuild.ts` | End-to-end rebuild, caching, retry, and bookkeeping |
| `rebuildAllTrees()` | `useMibStorage.ts` | Trigger worker rebuild and publish React state |

---

## Complexity & Performance

For measured timings and profiling instructions, see [PERFORMANCE_EN.md](./PERFORMANCE_EN.md).

### Time Complexity

| Stage | Complexity | Notes |
|---|---|---|
| Pass 1 | `O(n)` | `n` = total object count |
| Pass 2 | `O(n)` | O(1) map lookups for parent resolution and duplicate detection |
| Pass 2.5 | `O(orphans × rounds)` | At most 3 rounds |
| Pass 3 | `O(n)` | Each node visited once from root seeds |
| `convertToMibNode` | `O(n)` | Allocates the final output tree |

### Space Complexity

`O(n)` overall—roughly three lookup maps (`symbolMap`, `nameMap`, `childIndex`) plus two tree representations (working `TreeBuildNode` tree and output `MibNode` tree).

---

## Troubleshooting Guide

### Some nodes don't appear in the tree
- **Cause:** Orphan nodes whose parent was not found (missing `IMPORTS` module or undefined anchor).
- **Check:** Inspect the notification panel for missing-dependency or unplaced-anchor warnings, or check the browser console for orphan logs.
- **Fix:** Upload the required dependency MIB and verify that the parent object is defined and spelled consistently in `IMPORTS`.

### Conflict badge appears on MIBs
- **Cause:** Two files define the same module differently, or two different modules assign different names to the same OID.
- **Check:** Open the conflict banner to inspect the field-by-field diff.
- **Fix:** Delete the older or redundant revision, or keep both if intentional.

### OIDs are missing or incorrect
- **Cause:** A parent node's OID could not be resolved, or a circular reference exists.
- **Check:** Verify the ancestor chain back to a seed node (`iso`, `enterprises`, `mib-2`, etc.) and check the console for `[Cycle Detected]` messages.
- **Fix:** Correct the parent reference and click **Rebuild Tree**.

### Rebuilds feel slow on very large collections
- **Cause:** Every mutation still rebuilds and rewrites the full merged tree in IndexedDB (even though unchanged files hit the parse cache and work runs in a Web Worker).
- **Notes:**
  - Bulk uploads rebuild once at the end—if you see one rebuild per file, verify `skipReload` is passed through.
  - Remove unused MIBs to reduce total tree size.
  - See [PERFORMANCE_EN.md](./PERFORMANCE_EN.md) for profiling steps.
