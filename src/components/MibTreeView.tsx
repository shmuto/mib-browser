import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MibNode } from '../types/mib';
import TreeNode, { ROW_HEIGHT } from './TreeNode';
import { FileQuestion } from 'lucide-react';

// Extra rows rendered above and below the viewport to avoid blank space while scrolling
const OVERSCAN = 8;

interface MibTreeViewProps {
  tree: MibNode[];
  onSelectNode: (node: MibNode) => void;
  selectedOid: string | null;
  searchQuery?: string;
  expandedOids?: Set<string>;
  onToggleExpand?: (oid: string, expanded: boolean) => void;
  compactMode?: boolean;
  /** Heading shown when there is nothing to render */
  emptyTitle?: string;
  /** Second line shown when there is nothing to render */
  emptyHint?: string;
}

// One visible row of the tree
interface TreeRow {
  /** Node the row acts on (last node of the chain in compact mode) */
  node: MibNode;
  displayName: string;
  level: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isMatch: boolean;
  /** OIDs of every node folded into this row (compact mode) */
  chainOids: string[];
}

/**
 * Flatten the tree into the rows that are currently visible.
 *
 * Only expanded branches are walked, so the cost is proportional to the number
 * of visible rows rather than to the size of the whole tree.
 */
function flattenVisibleRows(
  tree: MibNode[],
  expandedOids: Set<string> | undefined,
  compactMode: boolean,
  searchQuery: string
): TreeRow[] {
  const rows: TreeRow[] = [];
  const lowerQuery = searchQuery ? searchQuery.toLowerCase() : '';

  function visit(node: MibNode, level: number) {
    // In compact mode, fold a chain of single-child nodes into one row
    let last = node;
    const chainOids = [node.oid];
    const chainNames = [node.name];

    if (compactMode) {
      while (last.children.length === 1) {
        last = last.children[0];
        chainOids.push(last.oid);
        chainNames.push(last.name);
      }
    }

    const hasChildren = last.children.length > 0;
    const isExpanded = expandedOids ? expandedOids.has(last.oid) : false;

    let isMatch = false;
    if (lowerQuery) {
      for (let i = 0; i < chainOids.length; i++) {
        if (chainNames[i].toLowerCase().includes(lowerQuery) || chainOids[i].includes(searchQuery)) {
          isMatch = true;
          break;
        }
      }
    }

    rows.push({
      node: last,
      displayName: chainNames.length > 1 ? chainNames.join(' / ') : node.name,
      level,
      hasChildren,
      isExpanded,
      isMatch,
      chainOids,
    });

    if (hasChildren && isExpanded) {
      for (const child of last.children) {
        visit(child, level + 1);
      }
    }
  }

  for (const node of tree) {
    visit(node, 0);
  }

  return rows;
}

export default function MibTreeView({
  tree,
  onSelectNode,
  selectedOid,
  searchQuery,
  expandedOids,
  onToggleExpand,
  compactMode = false,
  emptyTitle = 'No MIB files loaded',
  emptyHint = 'Upload a new file to get started'
}: MibTreeViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Fallback expansion state, used only when the parent does not control it
  const [internalExpandedOids, setInternalExpandedOids] = useState<Set<string>>(new Set());
  const effectiveExpandedOids = expandedOids ?? internalExpandedOids;

  const rows = useMemo(
    () => flattenVisibleRows(tree, effectiveExpandedOids, compactMode, searchQuery || ''),
    [tree, effectiveExpandedOids, compactMode, searchQuery]
  );

  const isEmpty = tree.length === 0;

  // Track the viewport height so the visible window can be computed
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    setViewportHeight(element.clientHeight);

    const observer = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight);
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [isEmpty]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const handleToggleExpand = useCallback((oid: string, expanded: boolean) => {
    if (onToggleExpand) {
      onToggleExpand(oid, expanded);
      return;
    }

    setInternalExpandedOids(prev => {
      const next = new Set(prev);
      if (expanded) {
        next.add(oid);
      } else {
        // Collapse descendants too, in a single update
        const descendantPrefix = `${oid}.`;
        for (const expandedOid of prev) {
          if (expandedOid === oid || expandedOid.startsWith(descendantPrefix)) {
            next.delete(expandedOid);
          }
        }
      }
      return next;
    });
  }, [onToggleExpand]);

  // Keep the scroll position valid when the row count shrinks (e.g. collapse all)
  const maxScrollTop = Math.max(0, rows.length * ROW_HEIGHT - viewportHeight);
  const effectiveScrollTop = Math.min(scrollTop, maxScrollTop);

  const startIndex = Math.max(0, Math.floor(effectiveScrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil((viewportHeight || 600) / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const visibleRows = rows.slice(startIndex, endIndex);

  if (isEmpty) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 p-8">
        <FileQuestion size={64} className="mb-4" />
        <p className="text-lg font-medium">{emptyTitle}</p>
        <p className="text-sm mt-2">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto p-2">
      {/* Spacer sized to the full list; only the visible window is rendered */}
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        <div style={{ position: 'absolute', top: startIndex * ROW_HEIGHT, left: 0, right: 0 }}>
          {visibleRows.map((row, index) => (
            <TreeNode
              // Rows are positional: keying by index lets React reuse the DOM
              // nodes of the window while scrolling.
              key={startIndex + index}
              node={row.node}
              displayName={row.displayName}
              level={row.level}
              hasChildren={row.hasChildren}
              isExpanded={row.isExpanded}
              isSelected={selectedOid !== null && row.chainOids.includes(selectedOid)}
              isMatch={row.isMatch}
              onSelect={onSelectNode}
              onToggleExpand={handleToggleExpand}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
