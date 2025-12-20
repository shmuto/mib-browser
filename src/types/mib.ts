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
}

// MIB data for storage
export interface StoredMibData {
  id: string;               // Unique ID (UUID)
  fileName: string;         // File name
  content: string;          // Original MIB file content
  parsedData: MibNode[];    // Parsed tree data
  uploadedAt: number;       // Upload timestamp
  lastAccessedAt: number;   // Last access timestamp
  size: number;             // File size (bytes)
  mibName?: string;         // MIB module name (e.g., "IF-MIB")
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
