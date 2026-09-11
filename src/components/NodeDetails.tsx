import { useState, useMemo, useRef } from 'react';
import { Copy, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import type { MibNode, StoredMibData, TextualConvention } from '../types/mib';
import OidBreadcrumb from './OidBreadcrumb';
import { parseMibModule, parseSyntaxValues } from '../lib/mib-parser';

// TEXTUAL-CONVENTION index: type name -> definition.
// Parsing every stored MIB is expensive, so the index is built once per MIB
// list (and only the first time a node with a SYNTAX is actually selected).
interface TcIndex {
  mibs: StoredMibData[];
  byName: Map<string, TextualConvention>;
}

function buildTcIndex(mibs: StoredMibData[]): TcIndex {
  const byName = new Map<string, TextualConvention>();

  for (const mib of mibs) {
    if (!mib.content) continue;
    try {
      const parsed = parseMibModule(mib.content, mib.fileName);
      if (!parsed.textualConventions) continue;
      for (const tc of parsed.textualConventions) {
        // First definition wins, matching the previous first-match-by-file order
        if (!byName.has(tc.name)) {
          byName.set(tc.name, tc);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { mibs, byName };
}

interface NodeDetailsProps {
  node: MibNode | null;
  onSelectNode?: (node: MibNode) => void;
  mibs: StoredMibData[];
  onViewMib?: (mib: StoredMibData) => void;
  tree: MibNode[];
  /** Collected during the tree rebuild. Undefined for trees stored before they were persisted. */
  textualConventions?: TextualConvention[];
}

export default function NodeDetails({ node, onSelectNode, mibs, onViewMib, tree, textualConventions }: NodeDetailsProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const tcIndexRef = useRef<TcIndex | null>(null);

  // Index the TEXTUAL-CONVENTIONs that came with the tree
  const storedTcIndex = useMemo(() => {
    if (!textualConventions) return null;

    const byName = new Map<string, TextualConvention>();
    for (const tc of textualConventions) {
      if (!byName.has(tc.name)) byName.set(tc.name, tc);
    }
    return byName;
  }, [textualConventions]);

  // Split the node's own SYNTAX into its base type and the values it allows.
  // An OBJECT-TYPE usually spells its enumeration out inline rather than
  // naming a TEXTUAL-CONVENTION.
  const ownSyntax = useMemo(
    () => (node?.syntax ? parseSyntaxValues(node.syntax) : null),
    [node?.syntax]
  );

  // Look up the TEXTUAL-CONVENTION matching this node's syntax
  // Must be called before any conditional returns (React hooks rule)
  const matchingTC = useMemo((): TextualConvention | null => {
    if (!node?.syntax) return null;

    // The base type is what a TEXTUAL-CONVENTION is named after: "DisplayString"
    // out of "DisplayString (SIZE (0..255))"
    const syntaxTypeName = ownSyntax?.syntax ?? node.syntax;

    if (storedTcIndex) {
      return storedTcIndex.get(syntaxTypeName) || null;
    }

    // Fallback for a tree stored before TEXTUAL-CONVENTIONs were persisted:
    // parse the stored MIBs once, and only when a lookup is actually needed.
    if (!tcIndexRef.current || tcIndexRef.current.mibs !== mibs) {
      tcIndexRef.current = buildTcIndex(mibs);
    }

    return tcIndexRef.current.byName.get(syntaxTypeName) || null;
  }, [node?.syntax, ownSyntax, mibs, storedTcIndex]);

  // Resolve a notification's varbinds to nodes, so each one can be clicked
  // through to. A module can carry objects it imports, so some of them may not
  // be in the tree at all - those stay as plain text.
  const variableNodes = useMemo((): Map<string, MibNode> => {
    const found = new Map<string, MibNode>();
    if (!node?.variables || node.variables.length === 0) return found;

    const wanted = new Set(node.variables);
    const stack = [...tree];
    while (stack.length > 0 && found.size < wanted.size) {
      const current = stack.pop()!;
      if (wanted.has(current.name) && !found.has(current.name)) {
        found.set(current.name, current);
      }
      for (const child of current.children) stack.push(child);
    }
    return found;
  }, [node?.variables, tree]);

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

  // Find which MIB file contains this node.
  // The file the node actually came from is matched first: when several files
  // declare the same module - which is exactly the case the conflict panel
  // reports - matching on the module name alone points at whichever of them
  // happens to be stored first, not the one this node was read from.
  const findSourceMib = (): StoredMibData | null => {
    if (node.fileName) {
      const byFile = mibs.find(mib => mib.fileName === node.fileName);
      if (byFile) return byFile;
    }

    if (!node.mibName) return null;
    return mibs.find(mib => mib.mibName === node.mibName) || null;
  };

  const sourceMib = findSourceMib();
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
      node.variables?.length ? `Variables: ${node.variables.join(', ')}` : '',
      node.description ? `Description: ${node.description}` : '',
    ].filter(Boolean).join('\n');

    copyToClipboard(details, 'all');
  };

  // An inline enumeration wins over the TEXTUAL-CONVENTION lookup: it is this
  // object's own, and it is the one the SYNTAX row would otherwise repeat
  const enumValues = ownSyntax?.enumValues ?? matchingTC?.enumValues;
  const enumSource = ownSyntax?.enumValues ? null : matchingTC?.name;
  const enumSyntax = ownSyntax?.syntax ?? node.syntax;

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

        {node.syntax && (
          // With the values listed below, the row shows the type they belong to
          <DetailRow label="Syntax" value={enumValues ? enumSyntax : node.syntax} />
        )}

        {/* Enumerated values, either the node's own or its TEXTUAL-CONVENTION's */}
        {enumValues && enumValues.length > 0 && (
          <div>
            <dt className="text-sm font-medium text-gray-600 mb-1">
              Values
              {enumSource && <span className="text-xs text-gray-400"> ({enumSource})</span>}
            </dt>
            <dd className="text-sm text-gray-800 bg-purple-50 p-3 rounded border border-purple-200">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                {enumValues.map(ev => (
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

        {node.variables && node.variables.length > 0 && (
          <div>
            <dt className="text-sm font-medium text-gray-600 mb-1">
              Variables <span className="text-xs text-gray-400">({node.variables.length})</span>
            </dt>
            <dd className="text-sm text-gray-800 bg-amber-50 p-3 rounded border border-amber-200">
              <div className="flex flex-wrap gap-2">
                {node.variables.map(variable => {
                  const target = variableNodes.get(variable);
                  return target ? (
                    <button
                      key={variable}
                      onClick={() => onSelectNode?.(target)}
                      className="px-2 py-1 bg-amber-100 text-amber-800 rounded text-xs font-mono hover:bg-amber-200 transition-colors cursor-pointer"
                      title={target.oid}
                    >
                      {variable}
                    </button>
                  ) : (
                    <span
                      key={variable}
                      className="px-2 py-1 bg-gray-100 text-gray-500 rounded text-xs font-mono"
                      title="Not in the loaded tree"
                    >
                      {variable}
                    </span>
                  );
                })}
              </div>
            </dd>
          </div>
        )}

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
