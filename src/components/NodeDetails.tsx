import { useState, useMemo } from 'react';
import { Copy, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import type { MibNode, StoredMibData, TextualConvention } from '../types/mib';
import OidBreadcrumb from './OidBreadcrumb';
import { parseMibModule } from '../lib/mib-parser';

interface NodeDetailsProps {
  node: MibNode | null;
  onSelectNode?: (node: MibNode) => void;
  mibs: StoredMibData[];
  onViewMib?: (mib: StoredMibData) => void;
  tree: MibNode[];
}

export default function NodeDetails({ node, onSelectNode, mibs, onViewMib, tree }: NodeDetailsProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Parse TEXTUAL-CONVENTIONs from all loaded MIBs and find matching TC for this node's syntax
  // Must be called before any conditional returns (React hooks rule)
  const matchingTC = useMemo((): TextualConvention | null => {
    if (!node?.syntax) return null;

    // Extract the type name from syntax (e.g., "DisplayString" from "DisplayString (SIZE (0..255))")
    const syntaxTypeName = node.syntax.split(/\s*\(/)[0].trim();

    // Search all MIBs for matching TC
    for (const mib of mibs) {
      if (!mib.content) continue;
      try {
        const parsed = parseMibModule(mib.content, mib.fileName);
        if (parsed.textualConventions) {
          const tc = parsed.textualConventions.find(tc => tc.name === syntaxTypeName);
          if (tc) return tc;
        }
      } catch {
        // Ignore parse errors
      }
    }
    return null;
  }, [node?.syntax, mibs]);

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000);
      toast.success('✓ Copied to clipboard');
    } catch (err) {
      console.error('Failed to copy:', err);
      toast.error('✗ Failed to copy');
    }
  };

  if (!node) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400">
        <p>Select a node</p>
      </div>
    );
  }

  // Find which MIB file contains this node by matching mibName
  const findSourceMib = (mibName?: string): StoredMibData | null => {
    if (!mibName) return null;

    // Find MIB by matching mibName (module name) with stored MIB's mibName
    return mibs.find(mib => mib.mibName === mibName) || null;
  };

  const sourceMib = findSourceMib(node.mibName);
  const mibNotation = node.mibName ? `${node.mibName}::${node.name}` : null;

  const copyAllDetails = () => {
    const details = [
      `Name: ${node.name}`,
      `OID: ${node.oid}`,
      mibNotation ? `Notation: ${mibNotation}` : '',
      `Type: ${node.type}`,
      node.syntax ? `Syntax: ${node.syntax}` : '',
      node.access ? `Access: ${node.access}` : '',
      node.status ? `Status: ${node.status}` : '',
      node.description ? `Description: ${node.description}` : '',
    ].filter(Boolean).join('\n');

    copyToClipboard(details, 'all');
  };

  const CopyButton = ({ fieldName, text }: { fieldName: string; text: string }) => {
    const isCopied = copiedField === fieldName;
    return (
      <button
        onClick={() => copyToClipboard(text, fieldName)}
        className="ml-2 p-1 hover:bg-gray-100 rounded transition-colors text-gray-500 hover:text-gray-700"
        title="Copy to clipboard"
      >
        {isCopied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
      </button>
    );
  };

  return (
    <div className="p-4 overflow-y-auto h-full">
      {/* OID Breadcrumb */}
      {onSelectNode && (
        <OidBreadcrumb node={node} tree={tree} onNavigate={onSelectNode} />
      )}

      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-800 flex items-center">
          {node.name}
          <CopyButton fieldName="name" text={node.name} />
        </h3>
        <button
          onClick={copyAllDetails}
          className="px-3 py-1.5 bg-blue-500 text-white rounded text-sm font-medium hover:bg-blue-600 transition-colors flex items-center gap-1.5"
        >
          {copiedField === 'all' ? <Check size={14} /> : <Copy size={14} />}
          Copy All
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <dt className="text-sm font-medium text-gray-600 mb-1">OID</dt>
          <dd className="text-sm text-gray-800 font-mono space-y-1">
            <div className="flex items-center text-blue-600">
              {node.oid}
              <CopyButton fieldName="oid" text={node.oid} />
            </div>
            {mibNotation && (
              <div className="flex items-center text-gray-600 text-xs">
                {mibNotation}
                <CopyButton fieldName="notation" text={mibNotation} />
              </div>
            )}
          </dd>
        </div>

        {sourceMib && (
          <div>
            <dt className="text-sm font-medium text-gray-600 mb-1">Source File</dt>
            <dd
              className="text-sm text-gray-800 bg-blue-50 px-2 py-1 rounded border border-blue-200 font-mono cursor-pointer hover:bg-blue-100 transition-colors"
              onClick={() => onViewMib?.(sourceMib)}
            >
              {sourceMib.fileName}
            </dd>
          </div>
        )}

        <DetailRow label="Type" value={node.type} />

        {node.syntax && <DetailRow label="Syntax" value={node.syntax} />}

        {/* TEXTUAL-CONVENTION enum values */}
        {matchingTC?.enumValues && matchingTC.enumValues.length > 0 && (
          <div>
            <dt className="text-sm font-medium text-gray-600 mb-1">
              Values <span className="text-xs text-gray-400">({matchingTC.name})</span>
            </dt>
            <dd className="text-sm text-gray-800 bg-purple-50 p-3 rounded border border-purple-200">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                {matchingTC.enumValues.map(ev => (
                  <div key={ev.value} className="flex justify-between">
                    <span className="text-purple-700">{ev.name}</span>
                    <span className="text-gray-500">({ev.value})</span>
                  </div>
                ))}
              </div>
            </dd>
          </div>
        )}

        {node.access && <DetailRow label="Access" value={node.access} />}
        {node.status && <DetailRow label="Status" value={node.status} />}

        {node.description && (
          <div>
            <dt className="text-sm font-medium text-gray-600 mb-1">Description</dt>
            <dd className="text-sm text-gray-800 bg-gray-50 p-3 rounded border border-gray-200 whitespace-pre-wrap">
              {node.description}
            </dd>
          </div>
        )}

        {node.children.length > 0 && (
          <div>
            <dt className="text-sm font-medium text-gray-600 mb-1">Children ({node.children.length})</dt>
            <dd className="text-sm text-gray-800 bg-gray-50 p-3 rounded border border-gray-200">
              <div className="flex flex-wrap gap-2">
                {node.children.map(child => (
                  <button
                    key={child.oid}
                    onClick={() => onSelectNode?.(child)}
                    className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs font-mono hover:bg-blue-200 transition-colors cursor-pointer"
                  >
                    {child.name}
                  </button>
                ))}
              </div>
            </dd>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <dt className="text-sm font-medium text-gray-600">{label}</dt>
      <dd className="col-span-2 text-sm text-gray-800 font-mono">{value}</dd>
    </div>
  );
}
