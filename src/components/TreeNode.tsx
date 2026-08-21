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
  // Rows are recycled by position, so the OID of the last click is tracked
  // alongside its timestamp: without it, two quick clicks on a row whose node
  // changed in between would be read as a double-click on the second node.
  const lastClick = useRef<{ oid: string; time: number }>({ oid: '', time: 0 });

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(node.oid, !isExpanded);
  }, [isExpanded, node.oid, onToggleExpand]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const now = Date.now();
    const previous = lastClick.current;
    const isSecondClick = previous.oid === node.oid && now - previous.time < 250;

    // Double-click detected (same node, within 250ms)
    if (isSecondClick && hasChildren) {
      lastClick.current = { oid: '', time: 0 }; // Reset
      handleToggle(e);
    } else {
      // Single click - select node
      lastClick.current = { oid: node.oid, time: now };
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
