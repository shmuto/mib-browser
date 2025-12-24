import { useState, useCallback, useMemo, useEffect } from 'react';
import type { MibNode, StoredMibData } from './types/mib';
import { useMibStorage } from './hooks/useMibStorage';
import { filterTreeByQuery } from './lib/mib-parser';
import { getOidPath } from './lib/oid-utils';
import { sanitizeFileName } from './lib/storage';
import toast, { Toaster } from 'react-hot-toast';

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
import ConflictNotificationPanel from './components/ConflictNotificationPanel';
import NotificationPanel, { useNotifications } from './components/NotificationPanel';
import { Database } from 'lucide-react';
import { SiGithub } from 'react-icons/si';

export default function App() {
  // Notification panel (must be before useMibStorage to pass callback)
  const {
    notifications,
    addNotification,
    dismissNotification,
    clearAllNotifications,
  } = useNotifications();

  const {
    mibs,
    mergedTree,
    storageInfo,
    loading,
    uploadMib,
    uploadMibFromText,
    removeMib,
    removeMibs,
    clearAll,
    reload,
  } = useMibStorage({ onNotification: addNotification });

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

  // Search filtering - show only matching nodes and their ancestors
  const filteredTree = useMemo(() => {
    return filterTreeByQuery(mergedTree, searchQuery);
  }, [mergedTree, searchQuery]);

  // Count total nodes in filtered tree
  const searchResultCount = useMemo(() => {
    if (!searchQuery) return undefined;

    const countNodes = (nodes: MibNode[]): number => {
      return nodes.reduce((count, node) => {
        return count + 1 + countNodes(node.children);
      }, 0);
    };

    return countNodes(filteredTree);
  }, [filteredTree, searchQuery]);

  const handleDeleteMib = useCallback(async (id: string) => {
    const mib = mibs.find(m => m.id === id);
    await removeMib(id);
    setSelectedNode(null);
    if (mib) {
      toast.success(`✓ ${mib.fileName} deleted`);
    }
  }, [removeMib, mibs]);

  const handleBulkDelete = useCallback(async (ids: string[]) => {
    await removeMibs(ids);
    setSelectedNode(null);
    toast.success(`✓ ${ids.length} file(s) deleted`);
  }, [removeMibs]);

  const handleConflictDelete = useCallback(async (id: string) => {
    const mib = mibs.find(m => m.id === id);
    await removeMib(id);
    if (mib) {
      toast.success(`✓ ${mib.fileName} deleted`);
    }
  }, [removeMib, mibs]);

  const handleBulkDownload = useCallback((selectedMibs: StoredMibData[]) => {
    selectedMibs.forEach(mib => {
      // Create a blob from the MIB file content
      const blob = new Blob([mib.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);

      // Create a temporary link and trigger download
      // セキュリティ: ファイル名をサニタイズしてパストラバーサル攻撃を防止
      const link = document.createElement('a');
      link.href = url;
      link.download = sanitizeFileName(mib.fileName);
      document.body.appendChild(link);
      link.click();

      // Cleanup
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }, []);

  const handleUpload = useCallback(async (file: File, forceUpload = false, skipReload = false) => {
    const result = await uploadMib(file, forceUpload, skipReload);
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
            <SiGithub size={20} />
            <span className="text-sm">GitHub</span>
          </a>
        </div>
      </header>

      {/* Conflict Notification Panel */}
      <ConflictNotificationPanel mibs={mibs} onDeleteFile={handleConflictDelete} />

      {/* Upload Error Notification Panel */}
      <NotificationPanel
        notifications={notifications}
        onDismiss={dismissNotification}
        onClearAll={clearAllNotifications}
      />

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Resizable Sidebar and Main Content */}
        <ResizablePanel
          storageKey="mib-browser-sidebar-width"
          defaultLeftWidth={25}
          minLeftWidth={15}
          maxLeftWidth={40}
          leftPanel={
            <aside className="bg-white border-r border-gray-200 flex flex-col h-full">
              <div className="p-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-800 mb-4">Saved MIBs</h2>
                <FileUploader onUpload={handleUpload} onUploadFromText={uploadMibFromText} onReload={reload} onNotification={addNotification} />
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
                onClearAll={clearAll}
              />
            </aside>
          }
          rightPanel={
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
                  <SearchBar onSearch={setSearchQuery} resultCount={searchResultCount} />
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
              <NodeDetails node={selectedNode} onSelectNode={setSelectedNode} mibs={mibs} onViewMib={setViewingMib} tree={mergedTree} />
            </aside>
          }
            />
          }
        />
      </div>

      {/* MIB Content Viewer Modal */}
      <MibContentModal mib={viewingMib} onClose={() => setViewingMib(null)} />

      {/* Toast Notifications */}
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: {
            background: '#363636',
            color: '#fff',
          },
          success: {
            duration: 3000,
            iconTheme: {
              primary: '#10b981',
              secondary: '#fff',
            },
          },
          error: {
            duration: 5000,
            iconTheme: {
              primary: '#ef4444',
              secondary: '#fff',
            },
          },
        }}
      />
    </div>
  );
}
