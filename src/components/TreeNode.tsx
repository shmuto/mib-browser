import { memo, useCallback, useRef } from 'react';
import type { MibNode } from '../types/mib';
import { ChevronRight, ChevronDown, Folder, File } from 'lucide-react';

// Height of a single row in pixels.
// The virtualized list positions rows by index, so this must match the row's
// rendered height (see ROW_HEIGHT_CLASS below).
export const ROW_HEIGHT = 28;
const ROW_HEIGHT_CLASS = 'h-7';

interface TreeNodeProps {
  /** Node this row represents (last node of the chain in compact mode) */
  node: MibNode;
  /** Text shown for the row (joined chain names in compact mode) */
  displayName: string;
  level: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  isMatch: boolean;
  onSelect: (node: MibNode) => void;
  onToggleExpand: (oid: string, expanded: boolean) => void;
}

function TreeNode({
  node,
  displayName,
  level,
  hasChildren,
  isExpanded,
  isSelected,
  isMatch,
  onSelect,
  onToggleExpand,
}: TreeNodeProps) {
  const lastClickTime = useRef<number>(0);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(node.oid, !isExpanded);
  }, [isExpanded, node.oid, onToggleExpand]);

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
      onSelect(node);
    }
  }, [node, onSelect, hasChildren, handleToggle]);

  return (
    <div
      className={`flex items-center gap-2 px-2 cursor-pointer hover:bg-gray-100 rounded ${ROW_HEIGHT_CLASS} ${
        isSelected ? 'bg-blue-100 hover:bg-blue-200' : ''
      } ${isMatch ? 'bg-yellow-200 font-semibold' : ''}`}
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
      <span className="text-xs text-gray-400 font-mono">{node.oid.split('.').pop()}</span>
    </div>
  );
}

export default memo(TreeNode);
