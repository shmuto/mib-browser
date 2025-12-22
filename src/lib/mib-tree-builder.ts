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

  constructor() {
    this.symbolMap = new Map();
    this.nameMap = new Map();
    this.importsMap = new Map();
    this.orphanNodes = [];
    this.seedNodes = [];
    this.registerSeedNodes();
  }

  /**
   * Main processing: build tree from multiple parsed modules
   * @param modules ParsedModule array
   * @returns Root node array (MibNode[])
   * @throws Error if orphan nodes remain (missing MIB dependencies)
   */
  public buildTree(modules: ParsedModule[]): MibNode[] {
    console.log(`[MibTreeBuilder] Building tree from ${modules.length} modules`);

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
    console.log('[Pass1] Registering symbols...');
    let totalObjects = 0;

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

          const subidsMatch = Array.isArray(seedSubid) && Array.isArray(objSubid)
            ? seedSubid.length === objSubid.length && seedSubid.every((v, i) => v === objSubid[i])
            : !Array.isArray(seedSubid) && !Array.isArray(objSubid) && seedSubid === objSubid;

          // If seed node exists with same parent and subid, skip this node (use seed node instead)
          if (existingSeedNode.parentName === obj.parentName && subidsMatch) {
            console.log(`[Pass1] Skipping duplicate: ${obj.name} (seed node exists)`);

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

            totalObjects++;
            return; // Skip creating new node
          } else {
            // Debug: log why conditions don't match
            console.log(`[Pass1] Seed node found for "${obj.name}" but conditions don't match:`);
            console.log(`  Seed parentName: "${existingSeedNode.parentName}", MIB parentName: "${obj.parentName}" (match: ${existingSeedNode.parentName === obj.parentName})`);
            console.log(`  Seed subid: ${JSON.stringify(seedSubid)}, MIB subid: ${JSON.stringify(objSubid)} (match: ${subidsMatch})`);
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

        totalObjects++;
      });
    });

    console.log(`[Pass1] Registered ${totalObjects} objects from ${modules.length} modules`);
    console.log(`[Pass1] Symbol Map size: ${this.symbolMap.size}, Name Map size: ${this.nameMap.size}`);
  }

  // === Pass 2: Parent Linking ===
  private pass2_linkParents(): void {
    console.log('[Pass2] Linking parents...');
    let linkedCount = 0;
    let orphanCount = 0;

    for (const node of this.symbolMap.values()) {
      if (!node.parentName) {
        // No parent (root node)
        continue;
      }

      const parentNode = this.resolveParent(node);

      if (parentNode) {
        // Check if already exists in parent's children (avoid duplicates from seed nodes)
        const alreadyLinked = parentNode.children.some(child => child === node);

        if (!alreadyLinked) {
          // Establish parent-child relationship (parent OID will be set in Pass3)
          parentNode.children.push(node);
          linkedCount++;
        }
      } else {
        // Parent not found - add to Orphan List
        this.orphanNodes.push(node);
        orphanCount++;
        console.warn(`[Pass2] Orphan: ${node.name} (parent: ${node.parentName}, module: ${node.moduleName})`);
      }
    }

    console.log(`[Pass2] Linked: ${linkedCount}, Orphans: ${orphanCount}`);
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
    parent = this.seedNodes.find(n => n.name === parentName);
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

    console.log('[Pass2.5] Rescuing orphan nodes...');

    while (this.orphanNodes.length > 0 && retry < maxRetries) {
      const currentOrphans = [...this.orphanNodes];
      this.orphanNodes = [];
      let rescuedCount = 0;

      currentOrphans.forEach(node => {
        const parent = this.resolveParent(node);
        if (parent) {
          // Check if already exists in parent's children (avoid duplicates)
          const alreadyLinked = parent.children.some(child => child === node);

          if (!alreadyLinked) {
            // Establish parent-child relationship (parent OID will be set in Pass3)
            parent.children.push(node);
            rescuedCount++;
            console.log(`[Rescue] ${node.name} rescued (parent: ${parent.name})`);
          }
        } else {
          this.orphanNodes.push(node); // Still orphan
        }
      });

      console.log(`[Pass2.5] Retry ${retry + 1}: Rescued ${rescuedCount}, Remaining orphans: ${this.orphanNodes.length}`);
      retry++;
    }

    if (this.orphanNodes.length > 0) {
      console.error(`[Orphan] ${this.orphanNodes.length} nodes remain orphaned:`,
        this.orphanNodes.map(n => `${n.name}(${n.moduleName}, parent=${n.parentName})`));
    }
  }

  // === Pass 3: OID Computation ===
  private pass3_computeOids(): void {
    console.log('[Pass3] Computing OIDs...');

    // Compute OIDs recursively from seed nodes
    this.seedNodes.forEach(seed => {
      this.computeOidRecursive(seed, new Set());
    });
  }

  private computeOidRecursive(node: TreeBuildNode, visited: Set<string>): void {
    const key = `${node.moduleName}::${node.name}`;

    // Cycle detection
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

      this.computeOidRecursive(childNode, new Set(visited));
    });
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
      this.symbolMap.set(`SNMPv2-SMI::${s.name}`, node);

      if (!this.nameMap.has(s.name)) {
        this.nameMap.set(s.name, []);
      }
      this.nameMap.get(s.name)!.push(node);
    });

    // Build seed node parent-child relationships
    // iso -> org -> dod -> internet -> ...
    this.buildSeedHierarchy();

    console.log(`[SeedNodes] Registered ${this.seedNodes.length} seed nodes`);
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
      const childNode = this.seedNodes.find(n => n.name === child);
      const parentNode = this.seedNodes.find(n => n.name === parent);

      if (childNode && parentNode) {
        childNode.parent = parentNode.oid;
        childNode.parentName = parent; // Set parent name for duplicate detection
        parentNode.children.push(childNode);
      }
    });
  }

  private buildTreeFromSeeds(): MibNode[] {
    // Return root structure from seed nodes (iso node only, or all top-level)
    const isoNode = this.seedNodes.find(n => n.name === 'iso');
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
