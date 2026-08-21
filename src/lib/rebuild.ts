/**
 * The rebuild pipeline: parse every stored MIB, merge them into one tree,
 * work out the per-file bookkeeping, and persist the tree.
 *
 * Lives here rather than in the hook so it can run either in a Web Worker or,
 * if workers are unavailable, on the main thread. It deliberately takes and
 * returns plain data: everything crossing the worker boundary is structured
 * cloned, so file contents are only sent for files the parse cache does not
 * already hold.
 */

import type {
  MibNode,
  MibConflict,
  ParsedModule,
  TextualConvention,
} from '../types/mib';
import { parseMibModule, flattenTree } from './mib-parser';
import { MibTreeBuilder } from './mib-tree-builder';
import { saveMergedTree, clearMergedTree } from './indexeddb';

/** One stored MIB, with its content omitted when the cache already holds it */
export interface RebuildInputMib {
  id: string;
  fileName: string;
  mibName?: string;
  content?: string;
}

export interface RebuildInput {
  mibs: RebuildInputMib[];
}

/** What the rebuild worked out about one file */
export interface RebuildFileResult {
  id: string;
  nodeCount: number;
  conflicts?: MibConflict[];
  error?: string;
  missingDependencies?: string[];
}

export interface RebuildResult {
  /** false when no tree could be built at all; the stored tree is cleared */
  ok: boolean;
  tree: MibNode[];
  textualConventions?: TextualConvention[];
  files: RebuildFileResult[];
  /** File names excluded from the build because a dependency was missing */
  errorFiles: string[];
  /** Ids whose parse is now cached, so the caller can skip sending them next time */
  cachedIds: string[];
  /**
   * Ids that arrived without content and were not in the cache. When this is
   * set the result is meaningless and the caller must resend with content.
   */
  missingContentIds?: string[];
}

// Parsed modules from earlier in this session, keyed by MIB id. Only the file
// that changed can have a different body, so the rest are reused. Held in
// memory on purpose: a page reload does not rebuild - it renders the stored
// tree - so persisting this would buy nothing and cost a serialization round trip.
const parseCache = new Map<string, { content: string; module: ParsedModule }>();

/** Seed the cache with a parse that has already been done elsewhere */
export function primeParseCache(id: string, content: string, module: ParsedModule): void {
  parseCache.set(id, { content, module });
}

export function getCachedIds(): string[] {
  return Array.from(parseCache.keys());
}

/**
 * Run a full rebuild.
 *
 * `onResult` is called with the finished result *before* the tree is written,
 * so a caller can show it without waiting on the slowest step.
 */
export async function runRebuild(
  input: RebuildInput,
  onResult?: (result: RebuildResult) => void
): Promise<RebuildResult> {
  const { mibs } = input;

  // Drop cache entries for MIBs that no longer exist
  const liveIds = new Set(mibs.map(mib => mib.id));
  for (const id of parseCache.keys()) {
    if (!liveIds.has(id)) parseCache.delete(id);
  }

  // Resolve every file to a parsed module, reusing unchanged parses
  const missingContentIds: string[] = [];
  const moduleByFileName = new Map<string, ParsedModule>();
  const allModules: ParsedModule[] = [];

  for (const mib of mibs) {
    const cached = parseCache.get(mib.id);

    if (mib.content === undefined) {
      if (!cached) {
        missingContentIds.push(mib.id);
        continue;
      }
      allModules.push(cached.module);
      moduleByFileName.set(mib.fileName, cached.module);
      continue;
    }

    if (cached && cached.content === mib.content) {
      allModules.push(cached.module);
      moduleByFileName.set(mib.fileName, cached.module);
      continue;
    }

    try {
      const module = parseMibModule(mib.content, mib.fileName);
      parseCache.set(mib.id, { content: mib.content, module });
      allModules.push(module);
      moduleByFileName.set(mib.fileName, module);
    } catch (error) {
      console.error(`Failed to parse ${mib.fileName}:`, error);
    }
  }

  if (missingContentIds.length > 0) {
    return {
      ok: false,
      tree: [],
      files: [],
      errorFiles: [],
      cachedIds: getCachedIds(),
      missingContentIds,
    };
  }

  const mibsById = new Map(mibs.map(mib => [mib.id, mib]));
  const mibsByFileName = new Map(mibs.map(mib => [mib.fileName, mib]));
  const fileResults = new Map<string, RebuildFileResult>();

  // Build the tree, dropping modules whose dependencies are missing and retrying
  let tree: MibNode[] | undefined;
  let modules = [...allModules];
  const errorFiles = new Set<string>();
  let lastMissingMibs: string[] = [];

  const maxRetries = 10;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    const builder = new MibTreeBuilder();
    try {
      tree = builder.buildTree(modules);
      break;
    } catch (buildError) {
      const errorMessage = buildError instanceof Error ? buildError.message : 'Unknown error';
      const match = errorMessage.match(/Missing MIB dependencies: ([^.]+)/);

      if (match) {
        const missingMibs = match[1].split(',').map(s => s.trim());

        // Exit if looping on the same missing MIBs
        if (JSON.stringify(missingMibs.sort()) === JSON.stringify(lastMissingMibs.sort())) {
          break;
        }
        lastMissingMibs = missingMibs;

        const modulesToRemove: string[] = [];
        for (const module of modules) {
          const dependsOnMissing = missingMibs.filter(missingMib =>
            Array.from(module.imports.values()).includes(missingMib)
          );

          if (dependsOnMissing.length > 0) {
            modulesToRemove.push(module.fileName);
            errorFiles.add(module.fileName);

            const mib = mibsByFileName.get(module.fileName);
            if (mib) {
              fileResults.set(mib.id, {
                id: mib.id,
                nodeCount: 0,
                error: `Missing MIB dependencies: ${dependsOnMissing.join(', ')}`,
                missingDependencies: dependsOnMissing,
              });
            }
          }
        }

        if (modulesToRemove.length > 0) {
          modules = modules.filter(m => !modulesToRemove.includes(m.fileName));
          retryCount++;
          continue;
        }
      }

      break;
    }
  }

  // Nothing could be built - report the dependency errors and clear the tree
  if (!tree || modules.length === 0) {
    const failed: RebuildResult = {
      ok: false,
      tree: [],
      files: Array.from(fileResults.values()),
      errorFiles: Array.from(errorFiles),
      cachedIds: getCachedIds(),
    };
    onResult?.(failed);
    await clearMergedTree();
    return failed;
  }

  const flatTree = flattenTree(tree);

  // Collect the TEXTUAL-CONVENTIONs seen while parsing, including from files
  // excluded from the build, so a type defined in a file with a missing
  // dependency still resolves in the details panel
  const textualConventions: TextualConvention[] = [];
  const seenTcNames = new Set<string>();
  for (const module of allModules) {
    for (const tc of module.textualConventions ?? []) {
      if (!seenTcNames.has(tc.name)) {
        seenTcNames.add(tc.name);
        textualConventions.push(tc);
      }
    }
  }

  // Nodes contributed by each file
  const nodeCountByFile = new Map<string, number>();
  for (const node of flatTree) {
    if (node.fileName) {
      nodeCountByFile.set(node.fileName, (nodeCountByFile.get(node.fileName) || 0) + 1);
    }
  }

  // Index tree nodes by "module::name" so conflict reporting can look up a
  // node's OID directly instead of scanning the whole flat tree each time
  const nodeByModuleAndName = new Map<string, MibNode>();
  for (const node of flatTree) {
    const key = `${node.mibName}::${node.name}`;
    if (!nodeByModuleAndName.has(key)) {
      nodeByModuleAndName.set(key, node);
    }
  }

  const validMibs = mibs.filter(mib => !errorFiles.has(mib.fileName));
  const builtModuleByFileName = new Map(modules.map(m => [m.fileName, m]));

  // Group files by module name so duplicate definitions can be compared
  const mibsByModuleName = new Map<string, RebuildInputMib[]>();
  for (const mib of validMibs) {
    const key = mib.mibName ?? '';
    if (!mibsByModuleName.has(key)) mibsByModuleName.set(key, []);
    mibsByModuleName.get(key)!.push(mib);
  }

  for (const mib of validMibs) {
    const conflicts: MibConflict[] = [];
    const moduleName = mib.mibName ?? '';
    const sameModuleMibs = mibsByModuleName.get(moduleName);

    if (sameModuleMibs && sameModuleMibs.length > 1) {
      const thisModule = builtModuleByFileName.get(mib.fileName);

      if (thisModule) {
        for (const otherMib of sameModuleMibs) {
          if (otherMib.id === mib.id) continue;

          const otherModule = builtModuleByFileName.get(otherMib.fileName);
          if (!otherModule) continue;

          const thisObjects = new Map(thisModule.objects.map(o => [o.name, o]));
          const otherObjects = new Map(otherModule.objects.map(o => [o.name, o]));

          for (const [name, thisObj] of thisObjects) {
            const otherObj = otherObjects.get(name);
            if (!otherObj) continue;

            const differences: { field: string; existingValue: string; newValue: string }[] = [];
            const fieldsToCheck: (keyof typeof thisObj)[] = ['type', 'syntax', 'access', 'status', 'description'];

            for (const field of fieldsToCheck) {
              const thisValue = String(thisObj[field] || '');
              const otherValue = String(otherObj[field] || '');

              if (thisValue && otherValue && thisValue !== otherValue) {
                differences.push({
                  field,
                  existingValue: otherValue.length > 200 ? otherValue.substring(0, 200) + '...' : otherValue,
                  newValue: thisValue.length > 200 ? thisValue.substring(0, 200) + '...' : thisValue,
                });
              }
            }

            if (differences.length > 0) {
              const treeNode = nodeByModuleAndName.get(`${moduleName}::${name}`);
              conflicts.push({
                oid: treeNode?.oid || 'unknown',
                name,
                existingFile: otherMib.fileName,
                newFile: mib.fileName,
                differences,
              });
            }
          }
        }
      }
    }

    fileResults.set(mib.id, {
      id: mib.id,
      nodeCount: nodeCountByFile.get(mib.fileName) || 0,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      error: undefined,
      missingDependencies: undefined,
    });
  }

  // Files that were excluded keep the error recorded during the retry loop
  for (const fileName of errorFiles) {
    const mib = mibsByFileName.get(fileName);
    if (mib && !fileResults.has(mib.id)) {
      fileResults.set(mib.id, { id: mib.id, nodeCount: 0 });
    }
  }

  const result: RebuildResult = {
    ok: true,
    tree,
    textualConventions,
    files: Array.from(fileResults.values()).filter(f => mibsById.has(f.id)),
    errorFiles: Array.from(errorFiles),
    cachedIds: getCachedIds(),
  };

  // Hand the result over before persisting: writing the tree is the slowest
  // step and nothing on screen depends on it having finished
  onResult?.(result);

  await saveMergedTree(tree, textualConventions);

  return result;
}
