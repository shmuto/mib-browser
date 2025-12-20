import type { MibNode } from '../types/mib';
import TreeNode from './TreeNode';
import { FileQuestion } from 'lucide-react';

interface MibTreeViewProps {
  tree: MibNode[];
  onSelectNode: (node: MibNode) => void;
  selectedOid: string | null;
  searchQuery?: string;
  expandedOids?: Set<string>;
  onToggleExpand?: (oid: string, expanded: boolean) => void;
  compactMode?: boolean;
}

export default function MibTreeView({
  tree,
  onSelectNode,
  selectedOid,
  searchQuery,
  expandedOids,
  onToggleExpand,
  compactMode = false
}: MibTreeViewProps) {
  if (tree.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 p-8">
        <FileQuestion size={64} className="mb-4" />
        <p className="text-lg font-medium">No MIB files loaded</p>
        <p className="text-sm mt-2">Upload a new file to get started</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      {tree.map(node => (
        <TreeNode
          key={node.oid}
          node={node}
          level={0}
          onSelect={onSelectNode}
          selectedOid={selectedOid}
          searchQuery={searchQuery}
          expandedOids={expandedOids}
          onToggleExpand={onToggleExpand}
          compactMode={compactMode}
        />
      ))}
    </div>
  );
}
