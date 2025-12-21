import { ChevronRight, Home } from 'lucide-react';
import type { MibNode } from '../types/mib';
import { getOidPath } from '../lib/oid-utils';

interface OidBreadcrumbProps {
  node: MibNode;
  tree: MibNode[];
  onNavigate: (node: MibNode) => void;
}

export default function OidBreadcrumb({ node, tree, onNavigate }: OidBreadcrumbProps) {
  // Get OID path from root to current node
  const oidPath = getOidPath(node.oid);

  // Find node by OID in the tree
  const findNodeByOid = (nodes: MibNode[], targetOid: string): MibNode | null => {
    for (const n of nodes) {
      if (n.oid === targetOid) return n;
      if (n.children.length > 0) {
        const found = findNodeByOid(n.children, targetOid);
        if (found) return found;
      }
    }
    return null;
  };

  // Build breadcrumb items
  const breadcrumbItems = oidPath.map(oid => {
    const foundNode = findNodeByOid(tree, oid);
    return {
      oid,
      name: foundNode?.name || oid,
      node: foundNode,
    };
  }).filter(item => item.node !== null);

  if (breadcrumbItems.length === 0) return null;

  return (
    <nav className="flex items-center gap-1 text-sm text-gray-600 mb-3 overflow-x-auto pb-2">
      <button
        onClick={() => breadcrumbItems[0].node && onNavigate(breadcrumbItems[0].node)}
        className="flex items-center hover:text-blue-600 transition-colors flex-shrink-0"
        title="Go to root"
      >
        <Home size={14} />
      </button>

      {breadcrumbItems.map((item, index) => {
        const isLast = index === breadcrumbItems.length - 1;
        const isCurrent = item.oid === node.oid;

        return (
          <div key={item.oid} className="flex items-center gap-1 flex-shrink-0">
            <ChevronRight size={14} className="text-gray-400" />
            {isLast || isCurrent ? (
              <span className="font-semibold text-gray-800">{item.name}</span>
            ) : (
              <button
                onClick={() => item.node && onNavigate(item.node)}
                className="hover:text-blue-600 hover:underline transition-colors"
                title={`${item.name} (${item.oid})`}
              >
                {item.name}
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
