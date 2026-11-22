import { useState, useCallback, useMemo, useEffect, useDeferredValue } from 'react';
import type { MibNode, StoredMibData } from './types/mib';
import { useMibStorage } from './hooks/useMibStorage';
import { filterTreeByQuery, filterTreeToNotifications, isNotificationNode, countTreeNodes, findNodeByOid } from './lib/mib-parser';
import { getOidPath } from './lib/oid-utils';
import { sanitizeFileName, readSetting, writeSetting } from './lib/storage';
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
import LicensesModal from './components/LicensesModal';
import ResizablePanel from './components/ResizablePanel';
import ConflictNotificationPanel from './components/ConflictNotificationPanel';
import NotificationPanel, { useNotifications } from './components/NotificationPanel';
import { Database, Scale } from 'lucide-react';

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
    textualConventions,
    storageInfo,
    loading,
    uploadMib,
    uploadMibFromText,
    removeMib,
    removeMibs,
    clearAll,
    rebuildTree,
  } = useMibStorage({ onNotification: addNotification });

  const [selectedNode, setSelectedNode] = useState<MibNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedOids, setExpandedOids] = useState<Set<string>>(new Set());
  const [viewingMib, setViewingMib] = useState<StoredMibData | null>(null);
  const [showLicenses, setShowLicenses] = useState(false);

  // Load compact mode from localStorage (default: true)
  const [compactMode, setCompactMode] = useState(() => {
    const saved = readSetting('mib-browser-compact-mode');
    return saved !== null ? saved === 'true' : true;
  });

  // Save compact mode to localStorage whenever it changes
  useEffect(() => {
    writeSetting('mib-browser-compact-mode', String(compactMode));
  }, [compactMode]);

  // Load the notifications-only filter from localStorage (default: off)
  const [notificationsOnly, setNotificationsOnly] = useState(() => {
    return readSetting('mib-browser-notifications-only') === 'true';
  });

  useEffect(() => {
    writeSetting('mib-browser-notifications-only', String(notificationsOnly));
  }, [notificationsOnly]);

  // Filtering a large tree is expensive, so it runs against a deferred copy of
  // the query: typing stays responsive and React re-filters at low priority.
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // "Traps only" filtering - keep notification nodes (NOTIFICATION-TYPE and
  // SMIv1 TRAP-TYPE) and their ancestors.
  // Applied before the search so the two compose: searching while the filter is
  // on searches the notifications.
  const typeFilteredTree = useMemo(() => {
    return notificationsOnly ? filterTreeToNotifications(mergedTree) : mergedTree;
  }, [mergedTree, notificationsOnly]);

  // Search filtering - show only matching nodes and their ancestors
  const filteredTree = useMemo(() => {
    return filterTreeByQuery(typeFilteredTree, deferredSearchQuery);
  }, [typeFilteredTree, deferredSearchQuery]);

  // Count total nodes in filtered tree
  const searchResultCount = useMemo(() => {
    if (!deferredSearchQuery) return undefined;
    return countTreeNodes(filteredTree);
  }, [filteredTree, deferredSearchQuery]);

  // How many notifications survive the current filters, for the tree header
  const notificationCount = useMemo(() => {
    if (!notificationsOnly) return 0;
    return countTreeNodes(filteredTree, isNotificationNode);
  }, [filteredTree, notificationsOnly]);

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
      // Security: Sanitize filename to prevent path traversal attacks
      const link = document.createElement('a');
      link.href = url;
      link.download = sanitizeFileName(mib.fileName);
      document.body.appendChild(link);
      link.click();

      document.body.removeChild(link);

      // Revoking straight away can cancel a download the browser has not
      // started reading yet, which is how a multi-file download ends up
      // saving only some of the files
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  }, []);

  const handleUpload = useCallback(async (file: File, forceUpload = false, skipReload = false) => {
    const result = await uploadMib(file, forceUpload, skipReload);
    return result;
  }, [uploadMib]);

  // Recovery after a batch upload that did not finish cleanly. Only the last
  // file of a batch triggers the rebuild, so a batch whose last file is
  // rejected leaves the earlier ones stored but absent from the tree - reading
  // the stored tree back would just show that stale tree, so rebuild instead.
  const handleUploadRecovery = useCallback(async () => {
    try {
      await rebuildTree();
    } catch {
      // rebuildTree has already reloaded whatever state it could
    }
  }, [rebuildTree]);

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

  // With "Traps Only" on, only the branches leading to notifications are left,
  // so they are expanded automatically - otherwise every trap would still be
  // several clicks deep. Runs again whenever the filtered tree changes, so a
  // search inside the filter also lands on visible rows.
  useEffect(() => {
    if (!notificationsOnly) return;

    const oids = collectAllOids(filteredTree);

    setExpandedOids(prev => {
      let next: Set<string> | null = null;

      for (const oid of oids) {
        if (!prev.has(oid)) {
          if (!next) next = new Set(prev);
          next.add(oid);
        }
      }

      return next ?? prev;
    });
  }, [notificationsOnly, filteredTree, collectAllOids]);

  // Toggle individual node expand/collapse.
  // Collapsing also drops every expanded descendant in the same update; doing it
  // one node at a time meant copying the whole Set per descendant.
  const handleToggleExpand = useCallback((oid: string, expanded: boolean) => {
    setExpandedOids(prev => {
      if (expanded) {
        if (prev.has(oid)) return prev;
        const newSet = new Set(prev);
        newSet.add(oid);
        return newSet;
      }

      const descendantPrefix = `${oid}.`;
      const newSet = new Set<string>();
      let changed = false;

      for (const expandedOid of prev) {
        if (expandedOid === oid || expandedOid.startsWith(descendantPrefix)) {
          changed = true;
          continue;
        }
        newSet.add(expandedOid);
      }

      return changed ? newSet : prev;
    });
  }, []);

  // Re-resolve the selection against a tree that has just been rebuilt.
  // `selectedNode` holds a node object, and every rebuild produces new ones, so
  // without this the details panel keeps showing the state the node was in
  // before the upload or delete - an outdated children list, a description from
  // a file that has since been replaced - or a node that no longer exists at all.
  useEffect(() => {
    if (!selectedNode) return;

    const refreshed = findNodeByOid(mergedTree, selectedNode.oid, selectedNode.name);
    if (refreshed === selectedNode) return;

    // null when the node is gone: its file was deleted, or it moved
    setSelectedNode(refreshed);
  }, [mergedTree, selectedNode]);

  // Auto-expand tree to show selected node.
  // Returns the previous Set unchanged when the path is already expanded -
  // handing back a new Set would invalidate the tree view's row model and make
  // every click rebuild it, which is most of a frame once the tree is large.
  useEffect(() => {
    if (!selectedNode) return;

    const pathOids = getOidPath(selectedNode.oid);

    // Expanding the node itself only means something when it has children;
    // for a leaf it would add an OID that nothing ever reads, while still
    // invalidating the row model. Leaves are most of what gets clicked.
    const lastIndex = selectedNode.children.length > 0 ? pathOids.length : pathOids.length - 1;

    setExpandedOids(prev => {
      let next: Set<string> | null = null;

      for (let i = 0; i < lastIndex; i++) {
        const oid = pathOids[i];
        if (!prev.has(oid)) {
          if (!next) next = new Set(prev);
          next.add(oid);
        }
      }

      return next ?? prev;
    });
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
      <header className="bg-white border-b border-gray-200 px-6 py-4 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Database size={32} className="text-blue-500" />
            <div>
              <h1 className="text-2xl font-bold text-gray-800">SNMP MIB Browser</h1>
              <p className="text-sm text-gray-500">Management Information Base Explorer</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowLicenses(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:text-gray-800 transition-colors"
              title="Open Source Licenses"
            >
              <Scale size={16} />
              <span className="text-sm">Licenses</span>
            </button>
            <a
              href="https://github.com/shmuto/mib-browser"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors"
            >
              <svg
                width={20}
                height={20}
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              <span className="text-sm">GitHub</span>
            </a>
          </div>
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
                <FileUploader onUpload={handleUpload} onUploadFromText={uploadMibFromText} onReload={handleUploadRecovery} onNotification={addNotification} />
              </div>

              <div className="flex-1 overflow-y-auto">
                <SavedMibsList
                  mibs={mibs}
                  onSelect={setViewingMib}
                  onDelete={handleDeleteMib}
                  onBulkDelete={handleBulkDelete}
                  onBulkDownload={handleBulkDownload}
                />
              </div>

              <StorageManager
                storageInfo={storageInfo}
                onClearAll={clearAll}
                onRebuildTree={rebuildTree}
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
                      {notificationsOnly
                        ? `${notificationCount} trap${notificationCount !== 1 ? 's' : ''}`
                        : `${mibs.length} file${mibs.length !== 1 ? 's' : ''} / ${mergedTree.length} root node${mergedTree.length !== 1 ? 's' : ''}`}
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
                  notificationsOnly={notificationsOnly}
                  onToggleNotificationsOnly={() => setNotificationsOnly(!notificationsOnly)}
                />
              </div>

              <div className="flex-1 overflow-hidden">
                <MibTreeView
                  tree={filteredTree}
                  onSelectNode={setSelectedNode}
                  selectedOid={selectedNode?.oid || null}
                  searchQuery={deferredSearchQuery}
                  expandedOids={expandedOids}
                  onToggleExpand={handleToggleExpand}
                  compactMode={compactMode}
                  emptyTitle={mergedTree.length === 0 ? 'No MIB files loaded' : 'Nothing to show'}
                  emptyHint={
                    mergedTree.length === 0
                      ? 'Upload a new file to get started'
                      : notificationsOnly
                        ? 'No notification definitions match. Turn off "Traps Only" to see the whole tree.'
                        : 'No node matches the search.'
                  }
                />
              </div>
            </main>
          }
          rightPanel={
            <aside className="flex flex-col bg-white h-full">
              <div className="p-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-800">Node Details</h2>
              </div>
              <NodeDetails
                node={selectedNode}
                onSelectNode={setSelectedNode}
                mibs={mibs}
                onViewMib={setViewingMib}
                tree={mergedTree}
                textualConventions={textualConventions}
              />
            </aside>
          }
            />
          }
        />
      </div>

      {/* MIB Content Viewer Modal */}
      <MibContentModal mib={viewingMib} onClose={() => setViewingMib(null)} />

      {/* Open Source Licenses Modal */}
      <LicensesModal isOpen={showLicenses} onClose={() => setShowLicenses(false)} />

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
