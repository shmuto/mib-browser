// MIB node type definition
export interface MibNode {
  oid: string;              // e.g., "1.3.6.1.2.1.1.1"
  name: string;             // e.g., "sysDescr"
  parent: string | null;    // Parent OID
  type: string;             // e.g., "OBJECT-TYPE", "OBJECT IDENTIFIER"
  syntax: string;           // e.g., "DisplayString", "INTEGER"
  access: string;           // e.g., "read-only", "read-write"
  status: string;           // e.g., "current", "deprecated"
  description: string;      // Description text
  children: MibNode[];      // Child nodes
  isExpanded?: boolean;     // For tree display: expansion state
  mibName?: string;         // MIB module name (e.g., "IF-MIB")
  fileName?: string;        // Source file name (e.g., "IF-MIB.txt")
}

// Flat MIB node (immediately after parsing)
export interface FlatMibNode {
  oid: string;
  name: string;
  parent: string | null;
  type: string;
  syntax: string;
  access: string;
  status: string;
  description: string;
  mibName?: string;
  fileName?: string;
}

// MIB data for storage
export interface StoredMibData {
  id: string;               // Unique ID (UUID)
  fileName: string;         // File name
  content: string;          // Original MIB file content
  nodeCount: number;        // Number of nodes contributed by this MIB
  uploadedAt: number;       // Upload timestamp
  lastAccessedAt: number;   // Last access timestamp
  size: number;             // File size (bytes)
  mibName?: string;         // MIB module name (e.g., "IF-MIB")
  conflicts?: MibConflict[]; // Conflicts with other MIBs (if any)
  error?: string;           // Error message if tree building failed
  missingDependencies?: string[]; // List of missing MIB dependencies
}

// Application state
export interface AppState {
  savedMibs: StoredMibData[];
  activeMibId: string | null;
  selectedNode: MibNode | null;
  searchQuery: string;
}

// Parse error information
export interface ParseError {
  line: number;
  message: string;
  context?: string;
}

// Parse result
export interface ParseResult {
  success: boolean;
  nodes: FlatMibNode[];
  errors: ParseError[];
}

// Storage information
export interface StorageInfo {
  used: number;       // Bytes used
  available: number;  // Bytes available (estimated)
  percentage: number; // Usage percentage (0-100)
}

// Conflict information when uploading MIB files
export interface MibConflict {
  oid: string;
  name: string;
  existingFile: string;
  newFile: string;
  differences: {
    field: string;
    existingValue: string;
    newValue: string;
  }[];
}

// Upload result with conflict information
export interface UploadResult {
  success: boolean;
  conflicts?: MibConflict[];
  error?: string;
}

// === 3-pass approach type definitions ===

// TEXTUAL-CONVENTION definition
export interface TextualConvention {
  name: string;
  status?: string;
  description?: string;
  displayHint?: string;
  syntax: string;                           // e.g., "INTEGER", "OCTET STRING"
  enumValues?: Array<{ name: string; value: number }>; // For enumerated types
  ranges?: Array<{ min: number; max: number }>;        // For size/range constraints
}

// Parsed module (intermediate representation after parsing, before OID resolution)
export interface ParsedModule {
  moduleName: string;
  fileName: string;             // Source file name
  imports: Map<string, string>; // { "SymbolName": "SourceModuleName" }
  objects: RawMibObject[];
  textualConventions?: TextualConvention[];
}

// Raw MIB object (parsed but OIDs not yet resolved)
export interface RawMibObject {
  name: string;
  parentName: string;           // Unresolved parent name
  subid: number | number[];     // Support for multiple SubIDs
  type: string;                 // "OBJECT-TYPE" | "OBJECT IDENTIFIER" | "MODULE-IDENTITY" | "OBJECT-IDENTITY"
  description?: string;
  syntax?: string;
  access?: string;
  status?: string;
  fileName?: string;            // Source file name
}

// Tree building node (internal node for tree construction)
export interface TreeBuildNode extends MibNode {
  parentName?: string | null;   // Unresolved parent name
  subid?: number | number[];    // SubID(s)
  moduleName: string;            // Source module name
}
