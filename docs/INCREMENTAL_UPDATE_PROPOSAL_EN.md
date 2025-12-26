# Incremental MIB Tree Update Proposal

## Current Problem

The current implementation **rebuilds the entire tree** when adding or deleting even a single MIB file:

```typescript
// useMibStorage.ts uploadMib()
await uploadMib(file) {
  // 1. Save MIB to IndexedDB
  await saveMib(newMib);

  // 2. Load all MIBs and rebuild entire tree
  await rebuildAllTrees();  // ← Re-parse and rebuild ALL MIBs
}
```

### Performance Issues

| MIB Count | Rebuild Time (Estimated) | Issue |
|-----------|--------------------------|-------|
| 10 files | ~100ms | Acceptable |
| 50 files | ~500ms | Somewhat slow |
| 100 files | ~1-2s | User experience degraded |
| 500 files | ~5-10s | Impractical |

---

## Incremental Update Implementation Strategy

### Approach 1: Differential Updates (Recommended)

#### Basic Idea

1. **Preserve existing tree** and process only changed MIBs
2. **Identify affected scope** for minimal recalculation
3. **Incremental merge** into existing tree

#### Implementation Steps

##### 1. Processing When Adding MIB

```typescript
async function addMibIncremental(newMibFile: File): Promise<void> {
  // Step 1: Parse new MIB
  const newModule = parseMibModule(content, fileName);

  // Step 2: Load existing tree
  const existingTree = await loadMergedTree();

  // Step 3: Impact analysis
  const affectedNodes = analyzeImpact(newModule, existingTree);

  // Step 4: Build new nodes
  const newNodes = buildNodesFromModule(newModule);

  // Step 5: Merge into existing tree
  const updatedTree = mergeIntoTree(existingTree, newNodes, affectedNodes);

  // Step 6: Recompute OIDs only for affected scope
  recomputeOidsForAffectedNodes(updatedTree, affectedNodes);

  // Step 7: Save
  await saveMergedTree(updatedTree);
}
```

##### 2. Impact Analysis Implementation

```typescript
interface AffectedNodes {
  orphansResolved: string[];      // Nodes that were orphans but parent found in new MIB
  newParents: string[];           // Existing nodes where new MIB nodes become parents
  duplicates: string[];           // Nodes with duplicate definitions
  newRoots: string[];             // Completely new subtrees
}

function analyzeImpact(newModule: ParsedModule, existingTree: MibNode[]): AffectedNodes {
  const affected: AffectedNodes = {
    orphansResolved: [],
    newParents: [],
    duplicates: [],
    newRoots: []
  };

  // Flatten existing tree and build maps
  const existingByName = buildNodeNameMap(existingTree);
  const existingByOid = buildNodeOidMap(existingTree);

  // Analyze each object in new module
  for (const obj of newModule.objects) {
    // 1. Does it resolve existing orphan nodes?
    const orphans = findOrphanNodes(existingTree);
    for (const orphan of orphans) {
      if (orphan.parentName === obj.name) {
        affected.orphansResolved.push(orphan.oid);
      }
    }

    // 2. Will it become parent of existing nodes?
    const potentialChildren = existingByName.get(obj.name);
    if (potentialChildren) {
      for (const child of potentialChildren) {
        if (child.parentName === obj.name) {
          affected.newParents.push(child.oid);
        }
      }
    }

    // 3. Is it a duplicate definition?
    if (existingByName.has(obj.name)) {
      const existing = existingByName.get(obj.name)!;
      if (existing.length > 0 && existing[0].moduleName !== newModule.moduleName) {
        affected.duplicates.push(obj.name);
      }
    }

    // 4. Is it completely new?
    const parentExists = existingByName.has(obj.parentName!) ||
                        isSeedNode(obj.parentName!);
    if (parentExists && !existingByName.has(obj.name)) {
      affected.newRoots.push(obj.name);
    }
  }

  return affected;
}
```

##### 3. Incremental Merge Implementation

```typescript
function mergeIntoTree(
  existingTree: MibNode[],
  newNodes: TreeBuildNode[],
  affected: AffectedNodes
): MibNode[] {
  // Clone existing tree (maintain immutability)
  const tree = cloneTree(existingTree);
  const treeMap = buildNodeOidMap(tree);

  // Add new nodes
  for (const newNode of newNodes) {
    const parentOid = findParentOid(newNode, treeMap);

    if (parentOid && treeMap.has(parentOid)) {
      const parent = treeMap.get(parentOid)!;

      // Check for duplicates
      const existingChild = parent.children.find(c =>
        c.name === newNode.name &&
        subidsEqual(c.subid, newNode.subid)
      );

      if (existingChild) {
        // Duplicate - merge
        mergeNodes(existingChild, newNode);
      } else {
        // New - add
        parent.children.push(convertToMibNode(newNode));
        parent.children.sort(compareBySubid);
      }
    }
  }

  // Re-link orphan nodes
  for (const orphanOid of affected.orphansResolved) {
    const orphan = treeMap.get(orphanOid);
    if (orphan) {
      relinkOrphan(orphan, tree, treeMap);
    }
  }

  return tree;
}
```

##### 4. Partial OID Recalculation

```typescript
function recomputeOidsForAffectedNodes(
  tree: MibNode[],
  affected: AffectedNodes
): void {
  const visited = new Set<string>();

  // Recalculate only affected nodes and their descendants
  const affectedOids = new Set([
    ...affected.orphansResolved,
    ...affected.newParents,
    ...affected.newRoots
  ]);

  for (const oid of affectedOids) {
    const node = findNodeByOid(tree, oid);
    if (node && !visited.has(oid)) {
      recomputeOidRecursive(node, visited);
    }
  }
}

function recomputeOidRecursive(node: MibNode, visited: Set<string>): void {
  if (visited.has(node.oid)) return;
  visited.add(node.oid);

  for (const child of node.children) {
    // Recalculate child OID from parent OID
    if (typeof child.subid === 'number') {
      child.oid = `${node.oid}.${child.subid}`;
    } else if (Array.isArray(child.subid)) {
      child.oid = `${node.oid}.${child.subid.join('.')}`;
    }
    child.parent = node.oid;

    // Recursively process children
    recomputeOidRecursive(child, visited);
  }
}
```

##### 5. Processing When Removing MIB

```typescript
async function removeMibIncremental(fileName: string): Promise<void> {
  // Step 1: Load existing tree
  const existingTree = await loadMergedTree();

  // Step 2: Identify nodes to remove
  const nodesToRemove = findNodesByFileName(existingTree, fileName);

  // Step 3: Identify orphaned children
  const orphanedChildren = findChildrenOfNodes(existingTree, nodesToRemove);

  // Step 4: Remove nodes
  const updatedTree = removeNodesFromTree(existingTree, nodesToRemove);

  // Step 5: Re-link orphans to other parents (if possible)
  for (const orphan of orphanedChildren) {
    const alternativeParent = findAlternativeParent(orphan, updatedTree);
    if (alternativeParent) {
      relinkOrphan(orphan, updatedTree, alternativeParent);
    } else {
      // Parent not found - remain orphan (or delete)
      markAsOrphan(orphan);
    }
  }

  // Step 6: Save
  await saveMergedTree(updatedTree);
}
```

---

### Approach 2: Cache Optimization (Simpler)

Since full incremental updates are complex, starting with **cache optimization** might be more practical.

#### Implementation

```typescript
class MibTreeCache {
  // ParsedModule cache
  private parsedModuleCache: Map<string, {
    module: ParsedModule,
    hash: string,      // File content hash
    timestamp: number
  }>;

  constructor() {
    this.parsedModuleCache = new Map();
  }

  /**
   * Parse MIB (with cache)
   */
  async parseMibWithCache(fileName: string, content: string): Promise<ParsedModule> {
    const hash = await computeHash(content);
    const cached = this.parsedModuleCache.get(fileName);

    // Cache hit
    if (cached && cached.hash === hash) {
      console.log(`Cache hit for ${fileName}`);
      return cached.module;
    }

    // Cache miss - execute parse
    console.log(`Parsing ${fileName}...`);
    const module = parseMibModule(content, fileName);

    this.parsedModuleCache.set(fileName, {
      module,
      hash,
      timestamp: Date.now()
    });

    return module;
  }

  /**
   * Clear cache
   */
  clearCache(fileName?: string): void {
    if (fileName) {
      this.parsedModuleCache.delete(fileName);
    } else {
      this.parsedModuleCache.clear();
    }
  }
}
```

#### Usage Example

```typescript
const cache = new MibTreeCache();

async function rebuildAllTreesWithCache(): Promise<void> {
  const allMibs = await getAllMibs();

  // Parse using cache (re-parse only changed MIBs)
  const modules = await Promise.all(
    allMibs.map(mib => cache.parseMibWithCache(mib.fileName, mib.content))
  );

  // Build tree (full rebuild)
  const builder = new MibTreeBuilder();
  const tree = builder.buildTree(modules);

  await saveMergedTree(tree);
}
```

#### Improvement Effect

| MIB Count | No Changes | Add 1 | Add 10 |
|-----------|------------|-------|--------|
| Parse time (current) | 500ms | 550ms | 1000ms |
| Parse time (cached) | ~0ms | 50ms | 500ms |
| **Improvement** | **100%** | **90%** | **50%** |

Tree building time unchanged, but parsing significantly faster.

---

## Implementation Difficulty and Effect

| Approach | Difficulty | Implementation Time | Effect | Risk |
|----------|-----------|---------------------|--------|------|
| **Cache Optimization** | ⭐️ Low | 2-3 hours | 30-70% speedup | Low |
| **Partial Update (Add only)** | ⭐️⭐️⭐️ Medium | 1-2 days | 70-90% speedup | Medium |
| **Partial Update (Complete)** | ⭐️⭐️⭐️⭐️⭐️ High | 1 week | 90-95% speedup | High |

---

## Recommended Implementation Plan

### Phase 1: Cache Optimization (Short-term)

1. ✅ **Implement ParsedModule cache**
   - Detect changes with file content hash
   - Persist cache to IndexedDB
   - Expect significant speedup

2. ✅ **Parallelize tree building**
   - Parallel parsing with Web Workers
   - Further speedup

### Phase 2: Partial Updates (Mid-term)

3. ✅ **Incremental update on MIB addition**
   - Implement impact analysis logic
   - Implement incremental merge
   - Partial OID recalculation

4. ⚠️ **Incremental update on MIB removal**
   - More complex (orphan handling needed)
   - Defer if Phase 1 is sufficient

### Phase 3: Optimization (Long-term)

5. ✅ **Optimize tree structure**
   - Improve index structure
   - Enhance search performance

---

## Implementation Example: Phase 1 (Cache Optimization)

### File Structure

```
src/lib/
  mib-cache.ts         # New: Cache manager
  mib-tree-builder.ts  # Modified: Cache support
src/hooks/
  useMibStorage.ts     # Modified: Use cache
```

### Code Example

```typescript
// src/lib/mib-cache.ts
export class MibParseCache {
  private static readonly CACHE_STORE = 'mib-parse-cache';

  async get(fileName: string, contentHash: string): Promise<ParsedModule | null> {
    const cached = await db.get(this.CACHE_STORE, fileName);
    if (cached && cached.hash === contentHash) {
      return cached.module;
    }
    return null;
  }

  async set(fileName: string, contentHash: string, module: ParsedModule): Promise<void> {
    await db.put(this.CACHE_STORE, {
      fileName,
      hash: contentHash,
      module,
      timestamp: Date.now()
    });
  }

  async clear(fileName?: string): Promise<void> {
    if (fileName) {
      await db.delete(this.CACHE_STORE, fileName);
    } else {
      await db.clear(this.CACHE_STORE);
    }
  }
}

// src/hooks/useMibStorage.ts
const cache = new MibParseCache();

const rebuildAllTrees = useCallback(async (): Promise<void> => {
  const allMibs = await getAllMibs();

  // Parse using cache
  const allModules = await Promise.all(
    allMibs.map(async mib => {
      const hash = await computeHash(mib.content);

      // Check cache
      let module = await cache.get(mib.fileName, hash);

      if (!module) {
        // Cache miss - execute parse
        module = parseMibModule(mib.content, mib.fileName);
        await cache.set(mib.fileName, hash, module);
      }

      return module;
    })
  );

  // Build tree (existing logic)
  const builder = new MibTreeBuilder();
  const tree = builder.buildTree(allModules);

  await saveMergedTree(tree);
}, []);
```

---

## Summary

### Current State
- ❌ Full tree rebuild for adding one MIB
- ❌ Slow with large MIB sets

### Proposal
1. **Short-term**: Cache optimization for 30-70% speedup (simple implementation)
2. **Mid-term**: Partial updates for 70-90% speedup (somewhat complex)
3. **Long-term**: Full incremental updates for 90-95% speedup (complex)

### Recommendation
**Start with Phase 1 (Cache Optimization)** - most practical approach:
- Simple implementation (2-3 hours)
- Low risk
- High effect (30-70% speedup)
- Minimal changes to existing logic

Only proceed to Phase 2 if Phase 1 is insufficient.
