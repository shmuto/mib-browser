# MIB Tree Construction Logic - Detailed Documentation

How MIB text becomes a merged OID tree. For the surrounding application — UI,
state, persistence — see [ARCHITECTURE_EN.md](./ARCHITECTURE_EN.md); for the
cost of each stage see [PERFORMANCE_EN.md](./PERFORMANCE_EN.md).

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [3-Pass Approach](#3-pass-approach)
4. [OID Hierarchy Management](#oid-hierarchy-management)
5. [Error Handling](#error-handling)
6. [Tree Rebuild Process](#tree-rebuild-process)
7. [Complete Flow Diagram](#complete-flow-diagram)
8. [Key Design Decisions](#key-design-decisions)

---

## Overview

The MIB tree construction system is a robust solution for parsing multiple MIB modules and integrating them into a unified SNMP OID hierarchy tree. The primary implementation is in the `MibTreeBuilder` class (`src/lib/mib-tree-builder.ts`), which employs a **3-pass approach**.

### Key Components

| File | Purpose |
|------|---------|
| `src/lib/mib-tree-builder.ts` | Core tree building logic (3-pass processing) |
| `src/lib/mib-parser.ts` | MIB grammar parsing |
| `src/lib/oid-utils.ts` | OID operations and hierarchy utilities |
| `src/hooks/useMibStorage.ts` | Tree rebuild and lifecycle management |
| `src/lib/indexeddb.ts` | Tree persistence |

---

## Architecture

### Data Structures

The authoritative definitions are in `src/types/mib.ts`.

#### ParsedModule
```typescript
interface ParsedModule {
  moduleName: string;              // Module name
  fileName: string;                // Source file name
  imports: Map<string, string>;    // { "SymbolName": "SourceModuleName" }
  objects: RawMibObject[];         // OID assignments and OBJECT-TYPE definitions
  textualConventions?: TextualConvention[];
}
```

#### RawMibObject
Parsed but not yet resolved: the parent is still a *name*, and the position
under it is a sub-identifier.

```typescript
interface RawMibObject {
  name: string;
  parentName: string;           // Unresolved parent name (e.g., "system")
  subid: number | number[];     // One subid, or several for { parent 3011 7124 3282 }
  type: string;                 // "OBJECT-TYPE" | "OBJECT IDENTIFIER" | ...
  description?: string;
  syntax?: string;
  access?: string;
  status?: string;
  fileName?: string;
}
```

#### MibNode (final output)
```typescript
interface MibNode {
  oid: string;            // Absolute OID (e.g., "1.3.6.1.2.1.1.1")
  name: string;           // Node name (e.g., "sysDescr")
  parent: string | null;  // Parent's OID, not a node reference
  type: string;           // OBJECT-TYPE type
  syntax: string;         // SYNTAX
  access: string;         // ACCESS/MAX-ACCESS
  status: string;         // STATUS
  description: string;    // DESCRIPTION
  children: MibNode[];    // Child node array
  isExpanded?: boolean;
  mibName?: string;       // Module the node came from
  fileName?: string;      // Source file name
}
```

#### TreeBuildNode
The builder's working node: a `MibNode` plus the fields needed to resolve it.
Note that `parent` is inherited from `MibNode` and holds the parent's **OID
string**, filled in during Pass 3 — the parent-child relationship itself lives
in the `children` arrays.

```typescript
interface TreeBuildNode extends MibNode {
  parentName?: string | null;   // Unresolved parent name
  subid?: number | number[];    // Position under the parent
  moduleName: string;           // Source module name
}
```

### Symbol Maps

The tree building process uses three main maps:

1. **symbolMap**: `Map<string, TreeBuildNode>`
   - Key: `"ModuleName::ObjectName"` (e.g., `"SNMPv2-MIB::system"`)
   - Value: Node object
   - Purpose: Unique reference resolution within modules
   - Seed nodes are registered under the module name `SNMPv2-SMI`
     (`"SNMPv2-SMI::iso"`, …)

2. **nameMap**: `Map<string, TreeBuildNode[]>`
   - Key: `"ObjectName"` (e.g., `"system"`)
   - Value: Array of nodes with the same name (can be defined in multiple modules)
   - Purpose: Cross-module search and fallback

3. **importsMap**: `Map<string, Map<string, string>>`
   - Key: Module name
   - Value: `{ ImportedSymbolName → SourceModuleName }`
   - Purpose: Reference resolution based on IMPORTS clause

Two lookup indexes support them:

4. **seedMap**: `Map<string, TreeBuildNode>` — seed nodes by name.
5. **childIndex**: `Map<TreeBuildNode, Map<string, TreeBuildNode>>` — for each
   parent, its children keyed by `"name|subid"`. This is what makes duplicate
   detection a map lookup instead of a scan of the children array; without it,
   linking under a parent with many children (`enterprises` with hundreds of
   vendor MIBs) is quadratic.

---

## 3-Pass Approach

### Pass 1: Symbol Registration
**Function**: `pass1_registerSymbols()` (`src/lib/mib-tree-builder.ts`)

#### Purpose
Extract symbols from all MIB modules and register them in maps. Parent-child relationships are not established at this stage.

#### Processing Flow

1. **Seed Node Registration** (`registerSeedNodes()`)
   - Create predefined standard SNMP hierarchy root nodes
   - 23 seed nodes:
     ```
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

2. **Module Symbol Registration**
   ```typescript
   // For each ParsedModule
   for (const obj of module.objects) {
     const node: TreeBuildNode = {
       name: obj.name,
       oid: '',                    // Not computed yet
       parent: null,               // Not linked yet
       parentName: obj.parentName, // Unresolved parent name
       subid: obj.subid,           // Relative ID from parent
       children: [],
       // ... other fields
     };

     // Register in maps
     symbolMap.set(`${moduleName}::${obj.name}`, node);

     if (!nameMap.has(obj.name)) {
       nameMap.set(obj.name, []);
     }
     nameMap.get(obj.name)!.push(node);
   }
   ```

3. **IMPORTS Information Registration**
   ```typescript
   // Example: IMPORTS { system FROM SNMPv2-MIB }
   importsMap.set('CurrentModule', {
     'system': 'SNMPv2-MIB'
   });
   ```

#### Output
- All symbols registered in maps
- Parent-child relationships not established
- OIDs not computed

---

### Pass 2: Parent Linking
**Function**: `pass2_linkParents()` (`src/lib/mib-tree-builder.ts`)

#### Purpose
Connect each node to its parent node to form a tree structure.

#### Parent Resolution Algorithm

The `resolveParent()` function searches for parents in the following order:

```typescript
function resolveParent(node: TreeBuildNode, moduleName: string): TreeBuildNode | null {
  const parentName = node.parentName;
  if (!parentName) return null;

  // 1. Search within same module
  const sameModuleKey = `${moduleName}::${parentName}`;
  if (symbolMap.has(sameModuleKey)) {
    return symbolMap.get(sameModuleKey)!;
  }

  // 2. Search using IMPORTS information
  const imports = importsMap.get(moduleName);
  if (imports && imports.has(parentName)) {
    const sourceModule = imports.get(parentName)!;
    const importedKey = `${sourceModule}::${parentName}`;
    if (symbolMap.has(importedKey)) {
      return symbolMap.get(importedKey)!;
    }
  }

  // 3. Search seed nodes
  const seed = seedMap.get(parentName);
  if (seed) {
    return seed;
  }

  // 4. Fallback: Cross-module search (only if name is unique)
  const candidates = nameMap.get(parentName);
  if (candidates && candidates.length === 1) {
    return candidates[0];
  }

  return null;  // Parent not found → orphan node
}
```

#### Duplicate Detection and Merging

Two MIB files can define the same node — the same name at the same position
under the same parent. Linking goes through `attachChild()`, which identifies a
child by `"name|subid"` and consults the parent's `childIndex`:

```typescript
function attachChild(parent: TreeBuildNode, node: TreeBuildNode): void {
  const index = getChildIndex(parent);       // built lazily, then kept in sync
  const key = childKey(node);                // `${name}|${subid}`
  const existing = index.get(key);

  if (!existing) {
    // New child - link it (its OID is computed in Pass 3)
    parent.children.push(node);
    index.set(key, node);
    return;
  }

  if (existing === node) return;             // already linked

  // Duplicate definition - fold this node's children into the existing one,
  // skipping grandchildren the existing node already has
  const existingIndex = getChildIndex(existing);
  for (const grandChild of node.children) {
    const grandChildKey = childKey(grandChild);
    if (!existingIndex.has(grandChildKey)) {
      existing.children.push(grandChild);
      existingIndex.set(grandChildKey, grandChild);
    }
  }
}
```

The duplicate node itself is dropped from the tree; whichever definition was
linked first wins. The **files** are still compared afterwards and reported as
conflicts — see [Conflict Detection](#conflict-detection).

`childKey()` distinguishes an array subid from a numeric one (`a3011.7124` vs
`n12`) so that `[1, 2]` and `12` cannot collide.

#### Orphan Node Processing

Nodes whose parent cannot be found are added to the `orphanNodes` array:

```typescript
if (!parent) {
  orphanNodes.push(node);
}
```

---

### Pass 2.5: Orphan Rescue
**Function**: `pass2_5_rescueOrphans()` (`src/lib/mib-tree-builder.ts`)

#### Purpose
Retry orphan nodes to link them to parents when dependencies are loaded out of order.

#### Processing Flow

```typescript
function pass2_5_rescueOrphans(): void {
  const maxRetries = 3;
  let retry = 0;

  while (orphanNodes.length > 0 && retry < maxRetries) {
    const currentOrphans = [...orphanNodes];
    orphanNodes = [];

    for (const node of currentOrphans) {
      const parent = resolveParent(node);

      if (parent) {
        attachChild(parent, node);   // same linking/merging path as Pass 2
      } else {
        orphanNodes.push(node);      // still orphan, try again next round
      }
    }

    retry++;
  }
}
```

#### Retry Strategy

- At most 3 rounds, and it stops as soon as no orphans are left
- Each round can only help if the previous one linked something, because a
  rescued node may itself be the parent another orphan was waiting for — a
  chain of *n* out-of-order definitions needs *n* rounds
- Whatever is still orphaned after the last round is reported as a missing
  dependency (see [Orphan Node Detection](#orphan-node-detection))

---

### Pass 3: OID Computation
**Function**: `pass3_computeOids()` (`src/lib/mib-tree-builder.ts`)

#### Purpose
Compute each node's absolute OID from its parent's OID and its own subid.

#### Computation Algorithm

```typescript
function computeOidRecursive(node: TreeBuildNode, visited: Set<string>): void {
  const key = `${node.moduleName}::${node.name}`;

  // Detect circular references
  if (visited.has(key)) {
    console.error(`[Cycle Detected] ${key}`);
    return;
  }
  visited.add(key);

  for (const child of node.children) {
    // Compute the child's OID from the parent's OID and the child's subid
    if (node.oid && child.subid !== undefined) {
      child.oid = Array.isArray(child.subid)
        ? `${node.oid}.${child.subid.join('.')}`   // { aristaProducts 3011 7124 3282 }
        : `${node.oid}.${child.subid}`;
      child.parent = node.oid;                     // parent is stored as an OID
    }

    computeOidRecursive(child, visited);
  }

  // Remove on the way back up: `visited` tracks the current root-to-node path
  visited.delete(key);
}

// Start only from seeds that are not themselves under another seed.
// The seeds form a chain (iso -> org -> dod -> internet -> ...), so starting
// from every one of them would recompute the same subtrees repeatedly.
for (const seed of seedNodes) {
  if (seed.parentName) continue;
  computeOidRecursive(seed, new Set());
}
```

Two details that are easy to get wrong here:

- **`visited` holds the current path, not every node seen.** Entries are removed
  as the recursion unwinds, so one set can be reused for the whole traversal.
  Keeping entries after the fact would flag a legitimately shared node as a
  cycle; copying the set for each child would allocate O(nodes x depth) sets.
- **The traversal starts at `iso` only.** Everything reachable from a seed is
  reachable from `iso`, because `buildSeedHierarchy()` links the seeds together.

#### Multiple SubID Handling

Some MIB definitions have multiple subids:

```
-- Example: Enterprise OID
myCompanyProduct OBJECT IDENTIFIER ::= { enterprises 30065 3011 7124 3282 }
```

In this case:
```typescript
node.subid = [30065, 3011, 7124, 3282];
node.oid = "1.3.6.1.4.1.30065.3011.7124.3282";
```

---

## OID Hierarchy Management

### OID Utilities (`src/lib/oid-utils.ts`)

#### Basic Operations

```typescript
// Convert OID string to number array
parseOid(oid: string): number[]
// Example: "1.3.6.1.2.1" → [1, 3, 6, 1, 2, 1]

// Convert number array to OID string
formatOid(parts: number[]): string
// Example: [1, 3, 6, 1, 2, 1] → "1.3.6.1.2.1"

// Lexicographic comparison of OIDs
compareOids(oid1: string, oid2: string): number
// Returns -1, 0, or 1

// Sort OID array
sortOids(oids: string[]): string[]
```

#### Hierarchy Operations

```typescript
// Get parent OID
getParentOid(oid: string): string | null
// Example: "1.3.6.1.2.1" → "1.3.6.1.2"

// Get OID depth
getOidDepth(oid: string): number
// Example: "1.3.6.1.2.1" → 5

// Get OID path
getOidPath(oid: string): string[]
// Example: "1.3.6.1.2" → ["1", "1.3", "1.3.6", "1.3.6.1", "1.3.6.1.2"]

// Check descendant relationship
isDescendant(parentOid: string, childOid: string): boolean
// Example: isDescendant("1.3.6", "1.3.6.1.2") → true

// Check if direct child
isDirectChild(parentOid: string, childOid: string): boolean
// Example: isDirectChild("1.3.6", "1.3.6.1") → true
//          isDirectChild("1.3.6", "1.3.6.1.2") → false

// Find common ancestor
getCommonAncestor(oid1: string, oid2: string): string | null
// Example: getCommonAncestor("1.3.6.1.2", "1.3.6.1.4") → "1.3.6.1"
```

#### OID Mapping

```typescript
// Build OID → name map from tree
buildOidNameMap(tree: MibNode[]): Map<string, string>

// Convert OID path to name path
getOidNamePath(oid: string, oidNameMap: Map<string, string>): string | null
// Example: "1.3.6.1.2.1.1.1" → "iso.org.dod.internet.mgmt.mib-2.system.sysDescr"

// Format OID for display
formatOidDisplay(oid: string, name?: string): string
// Example: formatOidDisplay("1.3.6.1.2.1.1.1", "sysDescr")
//          → "sysDescr (1.3.6.1.2.1.1.1)"
```

#### OID Validation

```typescript
// Validate OID
isValidOid(oid: string): boolean
// Checks that all parts are non-negative integers

// Get last OID number
getLastOidNumber(oid: string): number
// Example: "1.3.6.1.2.1" → 1
```

---

## Error Handling

### Orphan Node Detection

If nodes remain without parents after Pass 2.5, detect missing MIB dependencies:

```typescript
function detectMissingMibs(): Set<string> {
  const missing = new Set<string>();

  for (const orphan of orphanNodes) {
    const imports = importsMap.get(orphan.moduleName);
    if (imports && imports.has(orphan.parentName!)) {
      const requiredModule = imports.get(orphan.parentName!)!;
      missing.add(requiredModule);
    }
  }

  return missing;
}
```

### Error Notification

```typescript
if (orphanNodes.length > 0) {
  const missingMibs = detectMissingMibs();
  const missingList = Array.from(missingMibs).join(', ');

  throw new Error(
    `Cannot resolve all nodes. Missing MIB dependencies: ${missingList}. ` +
    `Orphaned nodes: ${orphanNodes.length}`
  );
}
```

### Error Recovery

`rebuildAllTrees()` in `useMibStorage.ts` catches errors and excludes problematic MIBs:

```typescript
async function rebuildAllTrees() {
  let modules = await parseAllModules();
  const excludedModules = new Set<string>();
  const maxRetries = 10;

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const tree = builder.buildTree(modules);
      // Success - save tree
      await saveMergedTree(tree);
      break;
    } catch (error) {
      // Extract missing MIB names from error message
      const missingMibs = extractMissingMibsFromError(error.message);

      if (missingMibs.length === 0) {
        throw error; // Unrecoverable error
      }

      // Exclude modules depending on missing MIBs
      for (const mod of modules) {
        if (dependsOnMissingMib(mod, missingMibs)) {
          excludedModules.add(mod.moduleName);
          // Save error information
          await saveMibError(mod.fileName, error.message);
        }
      }

      // Remove excluded modules and retry
      modules = modules.filter(m => !excludedModules.has(m.moduleName));
    }
  }
}
```

---

## Tree Rebuild Process

### Triggers

Tree rebuild occurs on the following events:

1. **MIB File Upload**
2. **MIB File Deletion**
3. **MIB File Import**
4. **Manual Rebuild Button Click**

### Complete Rebuild Flow

```typescript
async function rebuildAllTrees(): Promise<void> {
  // 1. Load all MIBs from IndexedDB
  const allMibs = await loadAllMibs();

  if (allMibs.length === 0) {
    await clearMergedTree();
    return;
  }

  // 2. Parse each MIB to ParsedModule format
  const modules: ParsedModule[] = [];
  for (const mib of allMibs) {
    try {
      const parsed = parseMibModule(mib.content, mib.fileName);
      modules.push(parsed);
    } catch (error) {
      console.error(`Failed to parse ${mib.fileName}:`, error);
    }
  }

  // 3. Build tree with MibTreeBuilder (with retry mechanism)
  let tree: MibNode[] = [];
  const builder = new MibTreeBuilder();
  const excludedModules = new Set<string>();

  for (let retry = 0; retry < 10; retry++) {
    try {
      tree = builder.buildTree(modules);
      break; // Success
    } catch (error) {
      // Detect missing MIBs
      const missingMibs = extractMissingMibsFromError(error.message);
      if (missingMibs.length === 0) {
        throw error;
      }

      // Exclude dependent modules
      for (const mod of modules) {
        if (dependsOnMissingMib(mod, missingMibs)) {
          excludedModules.add(mod.moduleName);
        }
      }

      modules = modules.filter(m => !excludedModules.has(m.moduleName));
    }
  }

  // 4. Flatten tree
  const flatTree = flattenTree(tree);

  // 5. Save merged tree to IndexedDB
  await saveMergedTree(tree);

  // 6. Calculate node count per file
  const nodeCounts = calculateNodeCountsByFile(flatTree);

  // 7. Detect conflicts in duplicate module names
  const conflicts = detectConflicts(allMibs, flatTree);

  // 8. Save metadata for every MIB (nodeCount, conflicts, errors) in ONE
  //    transaction. One saveMib() per file means one transaction per file.
  await saveMibs(changedMibs);
}
```

The records are mutated in place as the rebuild goes along, collected in a
`dirtyMibs` set, and written once at the end — including on the early-return
path where the build failed completely, so error state is never lost.

### Conflict Detection

When files with the same `moduleName` exist, compare each object field:

```typescript
function detectConflicts(mibs: Mib[], flatTree: MibNode[]): Map<string, Conflict[]> {
  const moduleNameMap = new Map<string, Mib[]>();

  // Group by same module name
  for (const mib of mibs) {
    if (!moduleNameMap.has(mib.moduleName)) {
      moduleNameMap.set(mib.moduleName, []);
    }
    moduleNameMap.get(mib.moduleName)!.push(mib);
  }

  const conflictMap = new Map<string, Conflict[]>();

  for (const [moduleName, mibList] of moduleNameMap) {
    if (mibList.length <= 1) continue; // No conflict

    // Compare each pair
    for (let i = 0; i < mibList.length; i++) {
      for (let j = i + 1; j < mibList.length; j++) {
        const mib1 = mibList[i];
        const mib2 = mibList[j];

        // Get nodes from tree for both MIBs
        const nodes1 = flatTree.filter(n => n.fileName === mib1.fileName);
        const nodes2 = flatTree.filter(n => n.fileName === mib2.fileName);

        // Match by name
        for (const n1 of nodes1) {
          const n2 = nodes2.find(n => n.name === n1.name);
          if (!n2) continue;

          // Compare fields
          const differences: FieldDifference[] = [];

          if (n1.type !== n2.type) {
            differences.push({
              field: 'type',
              oldValue: n1.type,
              newValue: n2.type
            });
          }

          if (n1.syntax !== n2.syntax) {
            differences.push({
              field: 'syntax',
              oldValue: n1.syntax,
              newValue: n2.syntax
            });
          }

          // ... other fields similarly

          if (differences.length > 0) {
            if (!conflictMap.has(mib1.fileName)) {
              conflictMap.set(mib1.fileName, []);
            }
            conflictMap.get(mib1.fileName)!.push({
              objectName: n1.name,
              conflictingFile: mib2.fileName,
              differences
            });
          }
        }
      }
    }
  }

  return conflictMap;
}
```

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       MIB File Upload                           │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    parseMibModule(content)                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ • Extract IMPORTS clause                                 │   │
│  │ • Extract OID assignments (unresolved: parentName+subid) │   │
│  │ • Extract OBJECT-TYPE definitions                        │   │
│  │ • Extract TEXTUAL-CONVENTION definitions                 │   │
│  │ → Return ParsedModule                                    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│              MibTreeBuilder.buildTree(modules[])                 │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Pass 1: registerSeedNodes() + pass1_registerSymbols()          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Create seed nodes:                                        │   │
│  │   iso, org, dod, internet, mgmt, mib-2, system, ...      │   │
│  │                                                           │   │
│  │ Register all symbols in three maps:                      │   │
│  │   • symbolMap: "ModuleName::ObjectName" → Node           │   │
│  │   • nameMap: "ObjectName" → Node[]                       │   │
│  │   • importsMap: Module → {Symbol → SourceModule}         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Pass 2: pass2_linkParents()                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ For each node:                                            │   │
│  │   1. Search for parent with resolveParent()              │   │
│  │      ├─ Search within same module                        │   │
│  │      ├─ Use IMPORTS information                          │   │
│  │      ├─ Search seed nodes                                │   │
│  │      └─ Fallback: Cross-module search                    │   │
│  │                                                           │   │
│  │   2. If parent found:                                    │   │
│  │      • Check for duplicates (name + subid)               │   │
│  │      • Merge if duplicate, add if new                    │   │
│  │                                                           │   │
│  │   3. If parent not found → Add to orphanNodes[]          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Pass 2.5: pass2_5_rescueOrphans() [Max 3 retries]             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ For each orphan node:                                     │   │
│  │   • Retry resolveParent()                                │   │
│  │   • Link if parent found                                 │   │
│  │   • Remain orphan if not found                           │   │
│  │                                                           │   │
│  │ Exit early if no progress                                │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Check for unresolved orphan nodes                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ If orphans remain:                                        │   │
│  │   • Run detectMissingMibs()                              │   │
│  │   • Throw error: "Missing MIB dependencies: ..."         │   │
│  │                                                           │   │
│  │ Error is caught in rebuildAllTrees()                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Pass 3: pass3_computeOids()                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ From each seed node:                                      │   │
│  │   • Call computeOidRecursive()                           │   │
│  │                                                           │   │
│  │ For each child node:                                      │   │
│  │   child.oid = parent.oid + "." + child.subid             │   │
│  │                                                           │   │
│  │ For multiple SubIDs:                                      │   │
│  │   child.oid = parent.oid + "." + subid.join('.')         │   │
│  │                                                           │   │
│  │ Detect circular references: use visited set              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  buildTreeFromSeeds()                                           │
│  • Return tree rooted at "iso" node                             │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  saveMergedTree(tree) → IndexedDB                               │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  calculateNodeCountsByFile(flatTree)                            │
│  • Count nodes per file                                         │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  detectConflicts(allMibs, flatTree)                             │
│  • Compare objects in files with same moduleName                │
│  • Record field differences                                     │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  saveMib() - Save metadata to each MIB                          │
│  • nodeCount                                                    │
│  • conflicts[]                                                  │
│  • error (if applicable)                                        │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  MibTreeView renders tree                                       │
│  • Recursively display with TreeNode components                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. 3-Pass Approach

**Rationale**: Separating parsing, linking, and OID resolution makes each stage's responsibility clear and debugging easier.

**Benefits**:
- Separate symbol registration and linking → can handle forward references
- Compute OID after parent linking → compute after parent OID is determined
- Each pass can be tested independently

### 2. Seed Nodes

**Rationale**: Predefining standard SNMP hierarchy roots ensures all MIBs are anchored to the base hierarchy.

**Benefits**:
- Always guarantee valid tree structure
- Ensure complete OID path from iso(1)
- Can display base tree even without custom MIBs

### 3. Symbol Maps (3 types)

**Rationale**: To efficiently support different search strategies.

**symbolMap**: O(1) resolution of unique references within modules
**nameMap**: Enables cross-module search and fallback
**importsMap**: Accurate reference resolution based on IMPORTS clause

### 4. Orphan Rescue Mechanism

**Rationale**: MIBs may be loaded in arbitrary order, causing dependencies to be out of sequence.

**Benefits**:
- Not dependent on loading order
- Can handle complex dependency graphs
- Prevents infinite loops

### 5. Duplicate Detection and Merging

**Rationale**: Multiple MIB files may define the same object (different versions or cross-references).

**Approach**:
- Detect duplicates by name + subid
- Merge children to integrate information
- Display conflicts in UI

### 6. Error Propagation and Exclusion

**Rationale**: One MIB's error should not prevent the entire tree from being built.

**Strategy**:
- Detect missing MIBs
- Exclude dependent modules
- Retry up to 10 times
- Save error information in MIB metadata

### 7. Tree Persistence

**Rationale**: Rebuilding large trees is expensive.

**Implementation**:
- Save complete tree to IndexedDB
- Load tree on app startup
- Rebuild only on changes

### 8. Conflict Tracking

**Rationale**: Users may upload different versions of the same module.

**Features**:
- Detect field-level differences
- Display conflicts in UI
- Show old and new values

---

## Critical Functions Summary

| Function | File | Responsibility |
|---|---|---|
| `MibTreeBuilder.buildTree()` | `mib-tree-builder.ts` | Orchestrate the 3-pass process |
| `pass1_registerSymbols()` | `mib-tree-builder.ts` | Register all symbols |
| `pass2_linkParents()` | `mib-tree-builder.ts` | Link nodes to parents |
| `pass2_5_rescueOrphans()` | `mib-tree-builder.ts` | Retry unresolved parents |
| `pass3_computeOids()` | `mib-tree-builder.ts` | Calculate absolute OIDs |
| `resolveParent()` | `mib-tree-builder.ts` | Find a parent, with fallbacks |
| `attachChild()` | `mib-tree-builder.ts` | Link a child, merging duplicates |
| `detectMissingMibs()` | `mib-tree-builder.ts` | Name the MIBs the orphans need |
| `registerSeedNodes()` | `mib-tree-builder.ts` | Create the standard SNMP hierarchy |
| `parseMibModule()` | `mib-parser.ts` | Parse MIB text into a `ParsedModule` |
| `validateMibContent()` | `mib-parser.ts` | Reject files that are not MIBs |
| `filterTreeByQuery()` | `mib-parser.ts` | Filter the tree to search matches |
| `rebuildAllTrees()` | `useMibStorage.ts` | Full rebuild, with error handling |

---

## Performance Considerations

Measured figures, profiling instructions and the full list of optimizations live
in [PERFORMANCE_EN.md](./PERFORMANCE_EN.md). In summary:

### Time Complexity

| Stage | Complexity | Notes |
|---|---|---|
| Pass 1 | O(n) | n = total object count |
| Pass 2 | O(n) | map lookups for both parent resolution and duplicate detection |
| Pass 2.5 | O(orphans x rounds) | at most 3 rounds |
| Pass 3 | O(n) | each node visited once, from `iso` only |
| `convertToMibNode` | O(n) | allocates the output tree |

Parsing the files, not building the tree, dominates a rebuild: it is the only
stage that has to touch every byte.

### Space Complexity

`symbolMap`, `nameMap` and `childIndex` are each O(n), and the output tree is a
second full copy of the nodes. Overall O(n), with a constant factor of roughly
"three maps plus two trees".

### Optimizations Applied

1. **Map-based resolution** — parent lookup and duplicate detection are both
   O(1); neither scans an array.
2. **Single-traversal Pass 3** — only root seeds are traversed, and the
   cycle-detection set is reused with backtracking rather than copied per child.
3. **Early exit in orphan rescue** — stops as soon as no orphans remain.
4. **Batched persistence** — one IndexedDB transaction per rebuild, on a cached
   connection.
5. **Tree persistence** — the built tree is stored, so a page reload renders it
   without rebuilding.

---

## Troubleshooting Guide

### Issue: Some nodes don't appear in tree

**Cause**: Orphan nodes - parent not found

**Diagnosis**:
1. Search browser console for "orphan"
2. Check error message for missing MIBs

**Solution**:
1. Upload required MIB files
2. Verify IMPORTS clause is correct
3. Verify parent object is defined

### Issue: Duplicate nodes appear

**Cause**: Multiple MIBs contain the same object with different definitions

**Diagnosis**:
1. Check for "Conflicts" badge in MIB list
2. View conflict details

**Solution**:
1. Delete older version MIBs
2. Keep only one authoritative MIB
3. Accept both if needed and live with conflicts

### Issue: OIDs not computed correctly

**Cause**: Parent OID is undefined or invalid

**Diagnosis**:
1. Check parent node's OID
2. Verify path to seed nodes

**Solution**:
1. Rebuild tree
2. Verify parent node is correctly defined
3. Check for circular references

### Issue: Tree building is slow

**Cause**: Every added or removed file rebuilds the whole collection, and the
rebuild re-parses every stored MIB.

**Notes**:
1. A bulk upload rebuilds once at the end, not once per file — if you are seeing
   one rebuild per file, `skipReload` is not being passed through
2. Delete MIBs you are not using; the cost scales with the total stored bytes
3. The built tree is cached in IndexedDB, so a page reload does not rebuild
4. To profile, see [PERFORMANCE_EN.md](./PERFORMANCE_EN.md)

---

## Future Extension Ideas

### 1. Incremental Updates

Currently, full rebuild is performed when adding/deleting MIBs. Incremental updates would rebuild only affected subtrees.

### 2. Off the Main Thread

Parsing dominates a rebuild and currently blocks the UI for its duration.
Running `parseMibModule` for each file in a Web Worker would keep the app
responsive even without incremental updates. (Pass 1 itself is not the
bottleneck and shares mutable maps, so it is a poor parallelization target.)

### 3. Tree Validation

Post-build tree integrity checks:
- Are all OIDs unique?
- Are all nodes reachable?
- Are there circular references?

### 4. Improved Cache Strategy

- Cache parsed modules, so a rebuild re-parses only what changed
- Avoid parsing an uploaded file twice (once for its module name, once in the
  rebuild)
- Incremental tree updates

### 5. Better Error Recovery

- More detailed error messages
- Automatic fix suggestions
- Partial tree building (excluding error sections)

---

## Conclusion

The MIB tree construction system is a robust solution for building a unified OID hierarchy from multiple MIB modules while handling complex dependencies, duplicates, and errors.

**Key Strengths**:
- ✅ Modular 3-pass architecture
- ✅ Comprehensive error handling
- ✅ Map-based reference resolution and duplicate detection, both O(1)
- ✅ Not dependent on loading order
- ✅ Duplicate and conflict detection
- ✅ Linear in the number of objects

**Limitations**:
- ⚠️ Requires a full rebuild (no incremental updates)
- ⚠️ Circular dependencies are detected and logged, not auto-resolved
- ⚠️ Runs on the main thread, so a large rebuild blocks the UI
- ⚠️ In-memory processing (limits for very large MIB sets)

This documentation should help understand the MIB tree construction logic and support future maintenance and extensions.
