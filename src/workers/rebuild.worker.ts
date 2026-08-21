/// <reference lib="webworker" />
/**
 * Runs the rebuild pipeline off the main thread.
 *
 * Two messages come back per request: the result as soon as it is ready, then
 * a `persisted` message once the merged tree has been written. Splitting them
 * lets the UI render the new tree while the write is still going on, on this
 * thread rather than the main one.
 */

import { runRebuild } from '../lib/rebuild';
import type { RebuildInput, RebuildResult } from '../lib/rebuild';

export interface RebuildRequest {
  requestId: number;
  input: RebuildInput;
}

export type RebuildResponse =
  | ({ type: 'result'; requestId: number } & RebuildResult)
  | { type: 'persisted'; requestId: number }
  | { type: 'error'; requestId: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<RebuildRequest>) => {
  const { requestId, input } = event.data;

  try {
    await runRebuild(input, result => {
      ctx.postMessage({ type: 'result', requestId, ...result } satisfies RebuildResponse);
    });
    ctx.postMessage({ type: 'persisted', requestId } satisfies RebuildResponse);
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : 'Unknown error',
    } satisfies RebuildResponse);
  }
};
