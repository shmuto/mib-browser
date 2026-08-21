/**
 * Drives the rebuild worker from the main thread.
 *
 * The worker keeps the parse cache, so file contents are only sent for files it
 * has not seen — posting every stored MIB across the boundary costs about as
 * much as parsing them (~95 ms for 5 MB), which would undo the point of moving
 * the work off the main thread.
 *
 * Falls back to running the same pipeline inline if a worker cannot be created.
 */

import type { StoredMibData } from '../types/mib';
import { runRebuild, primeParseCache } from './rebuild';
import type { RebuildInputMib, RebuildResult } from './rebuild';
import type { ParsedModule } from '../types/mib';
import type { RebuildRequest, RebuildResponse } from '../workers/rebuild.worker';

type ResultHandler = (result: RebuildResult) => void;

let worker: Worker | null = null;
let workerUnavailable = false;
let nextRequestId = 1;

// Ids whose content the worker has already parsed and cached
let idsKnownToWorker = new Set<string>();

// Parses done on the main thread (reading a module name during upload) that the
// worker has not been told about yet
const pendingPrimes = new Map<string, { content: string; module: ParsedModule }>();

function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;

  try {
    worker = new Worker(new URL('../workers/rebuild.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onerror = () => {
      // A worker that failed at runtime cannot be trusted to hold the cache
      resetWorker();
    };
    return worker;
  } catch (error) {
    console.warn('Rebuild worker unavailable, running on the main thread:', error);
    workerUnavailable = true;
    return null;
  }
}

function resetWorker(): void {
  worker?.terminate();
  worker = null;
  idsKnownToWorker = new Set();
}

/**
 * Record a parse the caller has already done so the next rebuild can skip it.
 * On the main-thread path it goes straight into the shared cache; for the
 * worker it is held until the next request, which carries the content anyway.
 */
export function noteParsedModule(id: string, content: string, module: ParsedModule): void {
  if (getWorker()) {
    pendingPrimes.set(id, { content, module });
    idsKnownToWorker.delete(id);
  } else {
    primeParseCache(id, content, module);
  }
}

/** Content is only sent for files the worker has not cached */
function toInput(mibs: StoredMibData[], sendAll: boolean): RebuildInputMib[] {
  return mibs.map(mib => ({
    id: mib.id,
    fileName: mib.fileName,
    mibName: mib.mibName,
    content: sendAll || !idsKnownToWorker.has(mib.id) ? mib.content : undefined,
  }));
}

function postRebuild(
  activeWorker: Worker,
  mibs: RebuildInputMib[],
  onResult: ResultHandler
): Promise<RebuildResult> {
  const requestId = nextRequestId++;

  return new Promise((resolve, reject) => {
    let received: RebuildResult | null = null;

    const cleanup = () => {
      activeWorker.removeEventListener('message', handler);
    };

    const handler = (event: MessageEvent<RebuildResponse>) => {
      const message = event.data;
      if (message.requestId !== requestId) return;

      if (message.type === 'error') {
        cleanup();
        reject(new Error(message.message));
        return;
      }

      if (message.type === 'result') {
        const { type: _type, requestId: _id, ...result } = message;
        received = result;

        // The caller has to resend with content; do not publish this one
        if (!result.missingContentIds?.length) {
          idsKnownToWorker = new Set(result.cachedIds);
          onResult(result);
        }
        return;
      }

      // persisted
      cleanup();
      resolve(received ?? { ok: false, tree: [], files: [], errorFiles: [], cachedIds: [] });
    };

    activeWorker.addEventListener('message', handler);
    activeWorker.postMessage({ requestId, input: { mibs } } satisfies RebuildRequest);
  });
}

/**
 * Rebuild the merged tree from the given MIBs.
 *
 * `onResult` fires as soon as the tree is ready, before it has been persisted.
 * The returned promise settles once the write has finished.
 */
export async function requestRebuild(
  mibs: StoredMibData[],
  onResult: ResultHandler
): Promise<RebuildResult> {
  const activeWorker = getWorker();

  if (!activeWorker) {
    for (const [id, { content, module }] of pendingPrimes) {
      primeParseCache(id, content, module);
    }
    pendingPrimes.clear();
    return runRebuild({ mibs: toInput(mibs, true) }, onResult);
  }

  pendingPrimes.clear();

  let result = await postRebuild(activeWorker, toInput(mibs, false), onResult);

  // The worker lost a cache entry we thought it had - resend everything once
  if (result.missingContentIds?.length) {
    idsKnownToWorker = new Set();
    result = await postRebuild(activeWorker, toInput(mibs, true), onResult);
  }

  return result;
}
