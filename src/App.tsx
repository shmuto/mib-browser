import { useState, useCallback, useMemo, useEffect } from 'react';
import type { MibNode, StoredMibData } from './types/mib';
import { useMibStorage } from './hooks/useMibStorage';
import { filterTreeByQuery } from './lib/mib-parser';
import { mergeMibs } from './lib/mib-merger';
import { getOidPath } from './lib/oid-utils';

// Components
import FileUploader from './components/FileUploader';
import SavedMibsList from './components/SavedMibsList';
import MibTreeView from './components/MibTreeView';
import SearchBar from './components/SearchBar';
import NodeDetails from './components/NodeDetails';
import StorageManager from './components/StorageManager';
import TreeExpandControls from './components/TreeExpandControls';
import MibContentModal from './components/MibContentModal';
import ResizablePanel from './components/ResizablePanel';
import { Database, Github } from 'lucide-react';

export default function App() {
  const {
    mibs,
    storageInfo,
    loading,
    uploadMib,
    removeMib,
    removeMibs,
    exportData,
    importData,
    clearAll,
  } = useMibStorage();

  const [selectedNode, setSelectedNode] = useState<MibNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedOids, setExpandedOids] = useState<Set<string>>(new Set());
  const [viewingMib, setViewingMib] = useState<StoredMibData | null>(null);

  // Load compact mode from localStorage (default: true)
  const [compactMode, setCompactMode] = useState(() => {
    const saved = localStorage.getItem('mib-browser-compact-mode');
    return saved !== null ? saved === 'true' : true;
  });

  // Save compact mode to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('mib-browser-compact-mode', String(compactMode));
  }, [compactMode]);

  // Merged tree from all MIBs
  const mergedTree = useMemo(() => {
    return mergeMibs(mibs);
  }, [mibs]);

  // Search filtering - show only matching nodes and their ancestors
  const filteredTree = useMemo(() => {
    return filterTreeByQuery(mergedTree, searchQuery);
  }, [mergedTree, searchQuery]);

  const handleDeleteMib = useCallback(async (id: string) => {
    await removeMib(id);
    setSelectedNode(null);
  }, [removeMib]);

  const handleBulkDelete = useCallback(async (ids: string[]) => {
    await removeMibs(ids);
    setSelectedNode(null);
  }, [removeMibs]);

  const handleBulkDownload = useCallback((selectedMibs: StoredMibData[]) => {
    selectedMibs.forEach(mib => {
      // Create a blob from the MIB file content
      const blob = new Blob([mib.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);

      // Create a temporary link and trigger download
      const link = document.createElement('a');
      link.href = url;
      link.download = mib.fileName;
      document.body.appendChild(link);
      link.click();

      // Cleanup
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }, []);

  const handleUpload = useCallback(async (file: File, forceUpload = false) => {
    const result = await uploadMib(file, forceUpload);
    return result;
  }, [uploadMib]);

  // Collect all OIDs in the tree
  const collectAllOids = useCallback((tree: MibNode[]): Set<string> => {
    const oids = new Set<string>();

    function traverse(nodes: MibNode[]) {
      for (const node of nodes) {
        if (node.children.length > 0) {
          oids.add(node.oid);
          traverse(node.children);
        }
      }
    }

    traverse(tree);
    return oids;
  }, []);

  // Expand all nodes
  const handleExpandAll = useCallback(() => {
    const oids = collectAllOids(filteredTree);
    setExpandedOids(oids);
  }, [filteredTree, collectAllOids]);

  // Collapse all nodes
  const handleCollapseAll = useCallback(() => {
    setExpandedOids(new Set());
  }, []);

  // Toggle individual node expand/collapse
  const handleToggleExpand = useCallback((oid: string, expanded: boolean) => {
    setExpandedOids(prev => {
      const newSet = new Set(prev);
      if (expanded) {
        newSet.add(oid);
      } else {
        newSet.delete(oid);
      }
      return newSet;
    });
  }, []);

  // Auto-expand tree to show selected node
  useEffect(() => {
    if (selectedNode) {
      const pathOids = getOidPath(selectedNode.oid);
      setExpandedOids(prev => {
        const newSet = new Set(prev);
        pathOids.forEach(oid => newSet.add(oid));
        return newSet;
      });
    }
  }, [selectedNode]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Database size={32} className="text-blue-500" />
            <div>
              <h1 className="text-2xl font-bold text-gray-800">SNMP MIB Browser</h1>
              <p className="text-sm text-gray-500">Management Information Base Explorer</p>
            </div>
          </div>
          <a
            href="https://github.com/shmuto/mib-browser"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors"
          >
            <Github size={20} />
            <span className="text-sm">GitHub</span>
          </a>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Saved MIBs */}
        <aside className="w-80 bg-white border-r border-gray-200 flex flex-col">
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">Saved MIBs</h2>
            <FileUploader onUpload={handleUpload} />
          </div>

          <div className="flex-1 overflow-y-auto">
            <SavedMibsList
              mibs={mibs}
              activeMibId={null}
              onSelect={setViewingMib}
              onDelete={handleDeleteMib}
              onBulkDelete={handleBulkDelete}
              onBulkDownload={handleBulkDownload}
            />
          </div>

          <StorageManager
            storageInfo={storageInfo}
            onExport={exportData}
            onImport={importData}
            onClearAll={clearAll}
          />
        </aside>

        {/* Resizable Main and Details Panel */}
        <ResizablePanel
          storageKey="mib-browser-panel-width"
          defaultLeftWidth={65}
          minLeftWidth={30}
          maxLeftWidth={85}
          leftPanel={
            <main className="flex-1 flex flex-col bg-white h-full">
              <div className="p-4 border-b border-gray-200">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-semibold text-gray-800">
                    Merged MIB Tree
                  </h2>
                  {mergedTree.length > 0 && (
                    <span className="text-sm text-gray-500">
                      {mibs.length} files / {mergedTree.length} root nodes
                    </span>
                  )}
                </div>
                <div className="mb-3">
                  <SearchBar onSearch={setSearchQuery} />
                </div>
                <TreeExpandControls
                  onExpandAll={handleExpandAll}
                  onCollapseAll={handleCollapseAll}
                  compactMode={compactMode}
                  onToggleCompactMode={() => setCompactMode(!compactMode)}
                />
              </div>

              <div className="flex-1 overflow-hidden">
                <MibTreeView
                  tree={filteredTree}
                  onSelectNode={setSelectedNode}
                  selectedOid={selectedNode?.oid || null}
                  searchQuery={searchQuery}
                  expandedOids={expandedOids}
                  onToggleExpand={handleToggleExpand}
                  compactMode={compactMode}
                />
              </div>
            </main>
          }
          rightPanel={
            <aside className="flex flex-col bg-white h-full">
              <div className="p-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-800">Node Details</h2>
              </div>
              <NodeDetails node={selectedNode} onSelectNode={setSelectedNode} mibs={mibs} onViewMib={setViewingMib} />
            </aside>
          }
        />
      </div>

      {/* MIB Content Viewer Modal */}
      <MibContentModal mib={viewingMib} onClose={() => setViewingMib(null)} />
    </div>
  );
}
