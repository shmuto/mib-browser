# MIB Tree Construction Logic - Detailed Documentation

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

#### ParsedModule
```typescript
interface ParsedModule {
  moduleName: string;        // Module name
  fileName?: string;         // File name
  imports: ImportInfo[];     // IMPORTS clause information
  objects: ParsedObject[];   // OID assignments and OBJECT-TYPE definitions
  textualConventions: TextualConvention[];  // TEXTUAL-CONVENTION definitions
}
```

#### TreeBuildNode
```typescript
interface TreeBuildNode extends MibNode {
  parentName: string | null;      // Unresolved parent name (e.g., "system")
  subid: number | number[];       // Relative ID from parent
  parent: TreeBuildNode | null;   // Resolved parent node reference
  children: TreeBuildNode[];      // Child node array
}
```

#### MibNode (Final Output)
```typescript
interface MibNode {
  name: string;           // Node name (e.g., "sysDescr")
  oid: string;            // Absolute OID (e.g., "1.3.6.1.2.1.1.1")
  parent: string | null;  // Parent's OID
  children: MibNode[];    // Child node array
  type: string;           // OBJECT-TYPE type
  syntax: string;         // SYNTAX
  access: string;         // ACCESS/MAX-ACCESS
  status: string;         // STATUS
  description: string;    // DESCRIPTION
  moduleName: string;     // Module name
  mibName: string;        // MIB name
  fileName?: string;      // Source file name
}
```

### Symbol Maps

The tree building process uses three main maps:

1. **symbolMap**: `Map<string, TreeBuildNode>`
   - Key: `"ModuleName::ObjectName"` (e.g., `"SNMPv2-MIB::system"`)
   - Value: Node object
   - Purpose: Unique reference resolution within modules

2. **nameMap**: `Map<string, TreeBuildNode[]>`
   - Key: `"ObjectName"` (e.g., `"system"`)
   - Value: Array of nodes with the same name (can be defined in multiple modules)
   - Purpose: Cross-module search and fallback

3. **importsMap**: `Map<string, Map<string, string>>`
   - Key: Module name
   - Value: `{ ImportedSymbolName → SourceModuleName }`
   - Purpose: Reference resolution based on IMPORTS clause

---

## 3-Pass Approach

### Pass 1: Symbol Registration
**Function**: `pass1_registerSymbols()` (`mib-tree-builder.ts:87-151`)

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
**Function**: `pass2_linkParents()` (`mib-tree-builder.ts:154-196`)

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
  const seedKey = `SEED::${parentName}`;
  if (symbolMap.has(seedKey)) {
    return symbolMap.get(seedKey)!;
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

If a child with the same name and subid already exists under the same parent, it's considered a duplicate:

```typescript
function subidsEqual(a: number | number[], b: number | number[]): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}

// Check for existing child
const existingChild = parent.children.find(c =>
  c.name === child.name && subidsEqual(c.subid, child.subid)
);

if (existingChild) {
  // Duplicate - merge children of existing node
  existingChild.children.push(...child.children);
  // Discard duplicate node
} else {
  // New - add to children array
  parent.children.push(child);
}
```

#### Orphan Node Processing

Nodes whose parent cannot be found are added to the `orphanNodes` array:

```typescript
if (!parent) {
  orphanNodes.push(node);
}
```

---

### Pass 2.5: Orphan Rescue
**Function**: `pass2_5_rescueOrphans()` (`mib-tree-builder.ts:249-295`)

#### Purpose
Retry orphan nodes to link them to parents when dependencies are loaded out of order.

#### Processing Flow

```typescript
function pass2_5_rescueOrphans(): void {
  const maxRetries = 3;

  for (let retry = 0; retry < maxRetries; retry++) {
    const stillOrphans: TreeBuildNode[] = [];
    const previousOrphanCount = orphanNodes.length;

    for (const orphan of orphanNodes) {
      const parent = resolveParent(orphan, orphan.moduleName);

      if (parent) {
        // Parent found - link
        orphan.parent = parent;
        // Check for duplicates and add
        const existing = parent.children.find(c =>
          c.name === orphan.name && subidsEqual(c.subid, orphan.subid)
        );
        if (!existing) {
          parent.children.push(orphan);
        }
      } else {
        // Still orphan
        stillOrphans.push(orphan);
      }
    }

    orphanNodes = stillOrphans;

    // Exit if no progress
    if (orphanNodes.length === previousOrphanCount) {
      break;
    }
  }
}
```

#### Retry Strategy

- Maximum 3 retries
- Exit early if orphan count doesn't decrease each retry
- Prevents infinite loops

---

### Pass 3: OID Computation
**Function**: `pass3_computeOids()` (`mib-tree-builder.ts:298-340`)

#### Purpose
Compute each node's absolute OID from its parent's OID and its own subid.

#### Computation Algorithm

```typescript
function computeOidRecursive(node: TreeBuildNode, visited: Set<TreeBuildNode>): void {
  // Detect circular references
  if (visited.has(node)) {
    console.error(`Circular reference detected at node: ${node.name}`);
    return;
  }
  visited.add(node);

  // For each child
  for (const child of node.children) {
    if (!child.parent) {
      child.parent = node;
    }

    // Compute OID
    if (typeof child.subid === 'number') {
      // Single subid
      child.oid = `${node.oid}.${child.subid}`;
    } else if (Array.isArray(child.subid)) {
      // Multiple subids (e.g., [3011, 7124, 3282])
      const subidStr = child.subid.join('.');
      child.oid = `${node.oid}.${subidStr}`;
    }

    // Set parent OID
    child.parent = node.oid;

    // Recursively process children
    computeOidRecursive(child, visited);
  }
}

// Start from each seed node
for (const seed of seedNodes) {
  const visited = new Set<TreeBuildNode>();
  computeOidRecursive(seed, visited);
}
```

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

  // 8. Save metadata to each MIB (nodeCount, conflicts, errors)
  for (const mib of allMibs) {
    await saveMib({
      ...mib,
      nodeCount: nodeCounts.get(mib.fileName) || 0,
      conflicts: conflicts.get(mib.fileName) || [],
      error: excludedModules.has(mib.moduleName) ? '...' : undefined
    });
  }
}
```

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

| Function | Responsibility | Lines |
|----------|----------------|-------|
| `MibTreeBuilder.buildTree()` | Orchestrate 3-pass process | 39-63 |
| `pass1_registerSymbols()` | Register all symbols | 87-151 |
| `pass2_linkParents()` | Link nodes to parents | 154-196 |
| `pass3_computeOids()` | Calculate absolute OIDs | 298-340 |
| `resolveParent()` | Find parent with fallbacks | 213-247 |
| `parseMibModule()` | Parse MIB to ParsedModule | 751-809 |
| `computeOidRecursive()` | Recursive OID calculation | 305-340 |
| `rebuildAllTrees()` | Complete rebuild with errors | 86-283 |
| `detectMissingMibs()` | Identify missing MIB dependencies | 438-463 |
| `registerSeedNodes()` | Create standard SNMP hierarchy | 343-398 |

---

## Performance Considerations

### Time Complexity

- **Pass 1**: O(n) - n is total object count
- **Pass 2**: O(n × m) - n is node count, m is average search time (nearly O(1) with maps)
- **Pass 3**: O(n) - visit each node once

**Overall**: O(n) - linear time, scalable to large MIBs

### Space Complexity

- **symbolMap**: O(n) - all symbols
- **nameMap**: O(n) - all symbols (including duplicates)
- **importsMap**: O(m) - m is import count
- **Tree**: O(n) - node count

**Overall**: O(n) - linear space

### Optimizations

1. **Map-based search**: O(1) reference resolution
2. **Early exit**: Stop orphan rescue if no progress
3. **Visited set**: Prevent infinite loops on circular references
4. **IndexedDB persistence**: Reduce rebuild frequency

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

**Cause**: Large number of MIBs or complex dependencies

**Optimization**:
1. Delete unnecessary MIBs
2. Check IndexedDB cache (automatic)
3. Profile with browser developer tools

---

## Future Extension Ideas

### 1. Incremental Updates

Currently, full rebuild is performed when adding/deleting MIBs. Incremental updates would rebuild only affected subtrees.

### 2. Parallel Processing

For large MIB sets, Pass 1 (symbol registration) could be parallelized.

### 3. Tree Validation

Post-build tree integrity checks:
- Are all OIDs unique?
- Are all nodes reachable?
- Are there circular references?

### 4. Improved Cache Strategy

- Cache parsed modules
- Re-parse only changed modules
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
- ✅ Efficient map-based reference resolution
- ✅ Not dependent on loading order
- ✅ Duplicate and conflict detection
- ✅ Scalable to large MIBs

**Limitations**:
- ⚠️ Requires full rebuild (no incremental updates)
- ⚠️ Circular dependencies detected but not auto-resolved
- ⚠️ In-memory processing (limits for very large MIB sets)

This documentation should help understand the MIB tree construction logic and support future maintenance and extensions.
