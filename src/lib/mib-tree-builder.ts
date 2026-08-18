/**
 * MIB Tree Builder - 3-pass approach implementation
 * Based on design.md specifications
 */

import type { MibNode, ParsedModule, TreeBuildNode } from '../types/mib';

export class MibTreeBuilder {
  // Symbol Map: "ModuleName::ObjectName" → TreeBuildNode
  private symbolMap: Map<string, TreeBuildNode>;

  // Simple name lookup (cross-module)
  private nameMap: Map<string, TreeBuildNode[]>;

  // IMPORTS information: Map<"TargetModule", Map<"Symbol", "SourceModule">>
  private importsMap: Map<string, Map<string, string>>;

  // Orphan Nodes (nodes whose parent was not found in Pass 2)
  private orphanNodes: TreeBuildNode[];

  // Root nodes (iso, org, dod, internet, etc.)
  private seedNodes: TreeBuildNode[];

  // Seed node lookup by name (avoids a linear scan per parent resolution)
  private seedMap: Map<string, TreeBuildNode>;

  // Per-parent index of "name|subid" -> child node.
  // Lets parent linking detect duplicate children in O(1) instead of scanning
  // the whole children array, which is quadratic for parents with many
  // children (e.g. `enterprises` with hundreds of vendor MIBs loaded).
  private childIndex: Map<TreeBuildNode, Map<string, TreeBuildNode>>;

  constructor() {
    this.symbolMap = new Map();
    this.nameMap = new Map();
    this.importsMap = new Map();
    this.orphanNodes = [];
    this.seedNodes = [];
    this.seedMap = new Map();
    this.childIndex = new Map();
    this.registerSeedNodes();
  }

  /**
   * Main processing: build tree from multiple parsed modules
   * @param modules ParsedModule array
   * @returns Root node array (MibNode[])
   * @throws Error if orphan nodes remain (missing MIB dependencies)
   */
  public buildTree(modules: ParsedModule[]): MibNode[] {
    // Pass 1: Symbol Registration
    this.pass1_registerSymbols(modules);

    // Pass 2: Parent Linking
    this.pass2_linkParents();

    // Pass 2.5: Orphan Rescue (multiple retries)
    this.pass2_5_rescueOrphans();

    // Check for orphan nodes and throw error if missing dependencies
    if (this.orphanNodes.length > 0) {
      const missingMibs = this.detectMissingMibs();
      if (missingMibs.size > 0) {
        const missingList = Array.from(missingMibs).join(', ');
        throw new Error(`Missing MIB dependencies: ${missingList}. Please upload these MIB files first.`);
      }
    }

    // Pass 3: OID Computation
    this.pass3_computeOids();

    // Return tree from seeds
    return this.buildTreeFromSeeds();
  }

  /**
   * Detect missing MIB files based on orphan nodes and IMPORTS information
   */
  private detectMissingMibs(): Set<string> {
    const missingMibs = new Set<string>();

    this.orphanNodes.forEach(node => {
      const parentName = node.parentName;
      if (!parentName) return;

      // Check IMPORTS information for this module
      const imports = this.importsMap.get(node.moduleName);
      if (imports && imports.has(parentName)) {
        const sourceMib = imports.get(parentName)!;
        missingMibs.add(sourceMib);
      }
    });

    return missingMibs;
  }

  // === Pass 1: Symbol Registration ===
  private pass1_registerSymbols(modules: ParsedModule[]): void {
    modules.forEach(mod => {
      // Save IMPORTS information
      this.importsMap.set(mod.moduleName, mod.imports);

      mod.objects.forEach(obj => {
        // Check if a seed node with the same name and parent exists
        const seedKey = `SNMPv2-SMI::${obj.name}`;
        const existingSeedNode = this.symbolMap.get(seedKey);

        if (existingSeedNode) {
          // Compare subid (handle both number and array)
          const seedSubid = existingSeedNode.subid;
          const objSubid = obj.subid;

          const subidsMatch = this.subidsEqual(seedSubid, objSubid);

          // If seed node exists with same parent and subid, skip this node (use seed node instead)
          if (existingSeedNode.parentName === obj.parentName && subidsMatch) {
            // Update seed node with additional information from MIB file if missing
            if (obj.description && !existingSeedNode.description) {
              existingSeedNode.description = obj.description;
            }
            if (obj.type && existingSeedNode.type === 'OBJECT IDENTIFIER') {
              existingSeedNode.type = obj.type; // Update if MIB has more specific type
            }

            // Also register with the MIB's module name key for resolution
            const uniqueKey = `${mod.moduleName}::${obj.name}`;
            this.symbolMap.set(uniqueKey, existingSeedNode);
            return; // Skip creating new node
          }
        }

        const node: TreeBuildNode = {
          name: obj.name,
          oid: '', // Not computed yet
          parent: null,
          parentName: obj.parentName,
          subid: obj.subid,
          children: [],
          type: obj.type,
          syntax: obj.syntax || '',
          access: obj.access || '',
          status: obj.status || '',
          description: obj.description || '',
          moduleName: mod.moduleName,
          mibName: mod.moduleName,
          fileName: obj.fileName || mod.fileName,
        };

        // Register in Symbol Map (unique key)
        const uniqueKey = `${mod.moduleName}::${obj.name}`;
        this.symbolMap.set(uniqueKey, node);

        // Register in Name Map (allow duplicate names)
        if (!this.nameMap.has(obj.name)) {
          this.nameMap.set(obj.name, []);
        }
        this.nameMap.get(obj.name)!.push(node);
      });
    });
  }

  // === Pass 2: Parent Linking ===
  private pass2_linkParents(): void {
    for (const node of this.symbolMap.values()) {
      if (!node.parentName) {
        // No parent (root node)
        continue;
      }

      const parentNode = this.resolveParent(node);

      if (parentNode) {
        // Link (or merge into an existing duplicate child) via the child index
        this.attachChild(parentNode, node);
      } else {
        // Parent not found - add to Orphan List
        this.orphanNodes.push(node);
      }
    }
  }

  /**
   * Key identifying a child within its parent ("name|subid")
   */
  private childKey(node: TreeBuildNode): string {
    const subid = node.subid;
    const subidKey = subid === undefined
      ? ''
      : Array.isArray(subid) ? `a${subid.join('.')}` : `n${subid}`;
    return `${node.name}|${subidKey}`;
  }

  /**
   * Get (creating if needed) the "name|subid" -> child index for a parent
   */
  private getChildIndex(parent: TreeBuildNode): Map<string, TreeBuildNode> {
    let index = this.childIndex.get(parent);
    if (!index) {
      index = new Map();
      for (const child of parent.children) {
        index.set(this.childKey(child as TreeBuildNode), child as TreeBuildNode);
      }
      this.childIndex.set(parent, index);
    }
    return index;
  }

  /**
   * Link a node under a parent, merging into an existing duplicate if the
   * parent already has a child with the same name and subid.
   */
  private attachChild(parent: TreeBuildNode, node: TreeBuildNode): void {
    const index = this.getChildIndex(parent);
    const key = this.childKey(node);
    const existing = index.get(key);

    if (!existing) {
      // Establish parent-child relationship (parent OID will be set in Pass3)
      parent.children.push(node);
      index.set(key, node);
      return;
    }

    if (existing === node) {
      // Already linked
      return;
    }

    // Merge: copy children from this node to the existing duplicate
    const existingIndex = this.getChildIndex(existing);
    node.children.forEach(grandChild => {
      const grandChildNode = grandChild as TreeBuildNode;
      const grandChildKey = this.childKey(grandChildNode);
      if (!existingIndex.has(grandChildKey)) {
        existing.children.push(grandChild);
        existingIndex.set(grandChildKey, grandChildNode);
      }
    });
  }

  /**
   * Compare two subid values (handles both number and array)
   */
  private subidsEqual(a: number | number[] | undefined, b: number | number[] | undefined): boolean {
    if (a === undefined && b === undefined) return true;
    if (a === undefined || b === undefined) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    return a === b;
  }

  /**
   * Resolve parent node (utilizing IMPORTS information)
   */
  private resolveParent(node: TreeBuildNode): TreeBuildNode | null {
    const parentName = node.parentName!;

    // 1. Search within the same module
    const sameModuleKey = `${node.moduleName}::${parentName}`;
    let parent = this.symbolMap.get(sameModuleKey);
    if (parent) {
      return parent;
    }

    // 2. Search using IMPORTS information
    const imports = this.importsMap.get(node.moduleName);
    if (imports && imports.has(parentName)) {
      const sourceModule = imports.get(parentName)!;
      const importedKey = `${sourceModule}::${parentName}`;
      parent = this.symbolMap.get(importedKey);
      if (parent) {
        return parent;
      }
    }

    // 3. Search seed nodes
    parent = this.seedMap.get(parentName);
    if (parent) {
      return parent;
    }

    // 4. Fallback search in Name Map (cross-module)
    const candidates = this.nameMap.get(parentName);
    if (candidates && candidates.length === 1) {
      return candidates[0]; // Only if unique
    }

    return null;
  }

  // === Pass 2.5: Orphan Rescue ===
  private pass2_5_rescueOrphans(): void {
    const maxRetries = 3;
    let retry = 0;

    while (this.orphanNodes.length > 0 && retry < maxRetries) {
      const currentOrphans = [...this.orphanNodes];
      this.orphanNodes = [];

      currentOrphans.forEach(node => {
        const parent = this.resolveParent(node);
        if (parent) {
          this.attachChild(parent, node);
        } else {
          this.orphanNodes.push(node); // Still orphan
        }
      });

      retry++;
    }
  }

  // === Pass 3: OID Computation ===
  private pass3_computeOids(): void {
    // Compute OIDs recursively from the root seed nodes only.
    // Most seeds (org, dod, internet, ...) are descendants of `iso`, so
    // starting from every seed walked the same subtrees once per level of the
    // seed hierarchy.
    this.seedNodes.forEach(seed => {
      if (seed.parentName) return; // Reached through its own parent seed
      this.computeOidRecursive(seed, new Set());
    });
  }

  private computeOidRecursive(node: TreeBuildNode, visited: Set<string>): void {
    const key = `${node.moduleName}::${node.name}`;

    // Cycle detection.
    // `visited` holds the nodes on the current root-to-node path only: entries
    // are removed on the way back up, so a single Set is reused instead of
    // copying it for every child (which was O(nodes x depth) allocations).
    if (visited.has(key)) {
      console.error(`[Cycle Detected] ${key}`);
      return;
    }

    visited.add(key);

    // OID is already set for seed nodes
    // For other nodes, compute from parent's OID + subid
    // (parent-child relationships are already established in Pass2 via children array)

    // Recurse to children and compute their OIDs
    node.children.forEach(child => {
      const childNode = child as TreeBuildNode;

      // Compute child OID from parent OID + child subid
      if (node.oid && childNode.subid !== undefined) {
        if (Array.isArray(childNode.subid)) {
          // Multiple SubID support (e.g., { aristaProducts 3011 7124 3282 })
          childNode.oid = `${node.oid}.${childNode.subid.join('.')}`;
        } else {
          // Single SubID
          childNode.oid = `${node.oid}.${childNode.subid}`;
        }

        // Set parent reference to parent's OID
        childNode.parent = node.oid;
      }

      this.computeOidRecursive(childNode, visited);
    });

    visited.delete(key);
  }

  // === Helper: Seed node registration ===
  private registerSeedNodes(): void {
    const seeds: Array<{ name: string; oid: string; subid: number }> = [
      { name: 'iso', oid: '1', subid: 1 },
      { name: 'org', oid: '1.3', subid: 3 },
      { name: 'dod', oid: '1.3.6', subid: 6 },
      { name: 'internet', oid: '1.3.6.1', subid: 1 },
      { name: 'directory', oid: '1.3.6.1.1', subid: 1 },
      { name: 'mgmt', oid: '1.3.6.1.2', subid: 2 },
      { name: 'experimental', oid: '1.3.6.1.3', subid: 3 },
      { name: 'private', oid: '1.3.6.1.4', subid: 4 },
      { name: 'enterprises', oid: '1.3.6.1.4.1', subid: 1 },
      { name: 'security', oid: '1.3.6.1.5', subid: 5 },
      { name: 'snmpV2', oid: '1.3.6.1.6', subid: 6 },
      { name: 'mail', oid: '1.3.6.1.7', subid: 7 },
      { name: 'mib-2', oid: '1.3.6.1.2.1', subid: 1 },
      { name: 'system', oid: '1.3.6.1.2.1.1', subid: 1 },
      { name: 'interfaces', oid: '1.3.6.1.2.1.2', subid: 2 },
      { name: 'at', oid: '1.3.6.1.2.1.3', subid: 3 },
      { name: 'ip', oid: '1.3.6.1.2.1.4', subid: 4 },
      { name: 'icmp', oid: '1.3.6.1.2.1.5', subid: 5 },
      { name: 'tcp', oid: '1.3.6.1.2.1.6', subid: 6 },
      { name: 'udp', oid: '1.3.6.1.2.1.7', subid: 7 },
      { name: 'egp', oid: '1.3.6.1.2.1.8', subid: 8 },
      { name: 'transmission', oid: '1.3.6.1.2.1.10', subid: 10 },
      { name: 'snmp', oid: '1.3.6.1.2.1.11', subid: 11 },
    ];

    seeds.forEach(s => {
      const node: TreeBuildNode = {
        name: s.name,
        oid: s.oid,
        parent: null,
        parentName: null,
        subid: s.subid,
        children: [],
        type: 'OBJECT IDENTIFIER',
        syntax: '',
        access: '',
        status: 'current',
        description: 'Seed node',
        moduleName: 'SNMPv2-SMI',
        mibName: 'SNMPv2-SMI',
      };
      this.seedNodes.push(node);
      this.seedMap.set(s.name, node);
      this.symbolMap.set(`SNMPv2-SMI::${s.name}`, node);

      if (!this.nameMap.has(s.name)) {
        this.nameMap.set(s.name, []);
      }
      this.nameMap.get(s.name)!.push(node);
    });

    // Build seed node parent-child relationships
    // iso -> org -> dod -> internet -> ...
    this.buildSeedHierarchy();
  }

  private buildSeedHierarchy(): void {
    const hierarchy = [
      { child: 'org', parent: 'iso' },
      { child: 'dod', parent: 'org' },
      { child: 'internet', parent: 'dod' },
      { child: 'directory', parent: 'internet' },
      { child: 'mgmt', parent: 'internet' },
      { child: 'experimental', parent: 'internet' },
      { child: 'private', parent: 'internet' },
      { child: 'security', parent: 'internet' },
      { child: 'snmpV2', parent: 'internet' },
      { child: 'mail', parent: 'internet' },
      { child: 'enterprises', parent: 'private' },
      { child: 'mib-2', parent: 'mgmt' },
      { child: 'system', parent: 'mib-2' },
      { child: 'interfaces', parent: 'mib-2' },
      { child: 'at', parent: 'mib-2' },
      { child: 'ip', parent: 'mib-2' },
      { child: 'icmp', parent: 'mib-2' },
      { child: 'tcp', parent: 'mib-2' },
      { child: 'udp', parent: 'mib-2' },
      { child: 'egp', parent: 'mib-2' },
      { child: 'transmission', parent: 'mib-2' },
      { child: 'snmp', parent: 'mib-2' },
    ];

    hierarchy.forEach(({ child, parent }) => {
      const childNode = this.seedMap.get(child);
      const parentNode = this.seedMap.get(parent);

      if (childNode && parentNode) {
        childNode.parent = parentNode.oid;
        childNode.parentName = parent; // Set parent name for duplicate detection
        this.getChildIndex(parentNode).set(this.childKey(childNode), childNode);
        parentNode.children.push(childNode);
      }
    });
  }

  private buildTreeFromSeeds(): MibNode[] {
    // Return root structure from seed nodes (iso node only, or all top-level)
    const isoNode = this.seedMap.get('iso');
    if (isoNode) {
      return [this.convertToMibNode(isoNode)];
    }

    // Fallback: return all seed nodes
    return this.seedNodes.map(n => this.convertToMibNode(n));
  }

  private convertToMibNode(node: TreeBuildNode): MibNode {
    return {
      oid: node.oid,
      name: node.name,
      parent: node.parent,
      type: node.type || '',
      syntax: node.syntax || '',
      access: node.access || '',
      status: node.status || '',
      description: node.description || '',
      children: node.children.map(c => this.convertToMibNode(c as TreeBuildNode)),
      mibName: node.moduleName, // Use moduleName from TreeBuildNode
      fileName: node.fileName, // Include fileName
      isExpanded: false,
    };
  }
}
