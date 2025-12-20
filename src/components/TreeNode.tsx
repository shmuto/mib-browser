import { useCallback, useEffect, useState, useRef } from 'react';
import type { MibNode } from '../types/mib';
import { ChevronRight, ChevronDown, Folder, File } from 'lucide-react';

interface TreeNodeProps {
  node: MibNode;
  level: number;
  onSelect: (node: MibNode) => void;
  selectedOid: string | null;
  searchQuery?: string;
  expandedOids?: Set<string>;
  onToggleExpand?: (oid: string, expanded: boolean) => void;
  compactMode?: boolean;
}

// Collect nodes in a single-child chain
function collectChain(node: MibNode): MibNode[] {
  const chain = [node];
  let current = node;

  while (current.children.length === 1) {
    current = current.children[0];
    chain.push(current);
  }

  return chain;
}

export default function TreeNode({
  node,
  level,
  onSelect,
  selectedOid,
  searchQuery = '',
  expandedOids,
  onToggleExpand,
  compactMode = false
}: TreeNodeProps) {
  const [localExpanded, setLocalExpanded] = useState(node.isExpanded || false);
  const lastClickTime = useRef<number>(0);

  // Collect chain if in compact mode
  const chain = compactMode ? collectChain(node) : [node];
  const lastNode = chain[chain.length - 1];
  const hasChildren = lastNode.children.length > 0;

  // Use expandedOids if provided, otherwise use local state
  // Always check the lastNode's OID for consistent behavior
  const isExpanded = expandedOids ? expandedOids.has(lastNode.oid) : localExpanded;

  useEffect(() => {
    if (expandedOids) {
      setLocalExpanded(expandedOids.has(lastNode.oid));
    }
  }, [expandedOids, lastNode.oid]);

  // Check if any node in the chain is selected
  const isSelected = chain.some(n => n.oid === selectedOid);

  // Check if node matches search query
  const isMatch = searchQuery ?
    chain.some(n =>
      n.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.oid.includes(searchQuery)
    ) : false;

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const newExpanded = !isExpanded;

    if (onToggleExpand) {
      onToggleExpand(lastNode.oid, newExpanded);

      // If collapsing, recursively collapse all descendants
      if (!newExpanded && lastNode.children.length > 0) {
        const collapseRecursively = (children: MibNode[]) => {
          children.forEach(child => {
            onToggleExpand(child.oid, false);
            if (child.children.length > 0) {
              collapseRecursively(child.children);
            }
          });
        };
        collapseRecursively(lastNode.children);
      }
    } else {
      setLocalExpanded(newExpanded);
    }
  }, [isExpanded, lastNode, onToggleExpand]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const now = Date.now();
    const timeSinceLastClick = now - lastClickTime.current;

    // Double-click detected (within 250ms)
    if (timeSinceLastClick < 250 && hasChildren) {
      lastClickTime.current = 0; // Reset
      handleToggle(e);
    } else {
      // Single click - select node
      lastClickTime.current = now;
      onSelect(lastNode);
    }
  }, [lastNode, onSelect, hasChildren, handleToggle]);

  // Display name: either compact (iso/org/dod) or single node name
  const displayName = compactMode && chain.length > 1
    ? chain.map(n => n.name).join(' / ')
    : node.name;

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-1 px-2 cursor-pointer hover:bg-gray-100 rounded ${
          isSelected ? 'bg-blue-100 hover:bg-blue-200' : ''
        } ${isMatch ? 'bg-yellow-50' : ''}`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleClick}
      >
        {hasChildren ? (
          <button onClick={handleToggle} className="p-0.5 hover:bg-gray-200 rounded">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : (
          <span className="w-5" />
        )}

        {hasChildren ? <Folder size={16} className="text-blue-500" /> : <File size={16} className="text-gray-400" />}

        <span className="text-sm font-medium text-gray-700 flex-1 truncate">{displayName}</span>
        <span className="text-xs text-gray-400 font-mono">{lastNode.oid.split('.').pop()}</span>
      </div>

      {hasChildren && isExpanded && (
        <div>
          {lastNode.children.map(child => (
            <TreeNode
              key={child.oid}
              node={child}
              level={level + 1}
              onSelect={onSelect}
              selectedOid={selectedOid}
              searchQuery={searchQuery}
              expandedOids={expandedOids}
              onToggleExpand={onToggleExpand}
              compactMode={compactMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}
