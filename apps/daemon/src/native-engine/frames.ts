// SPDX-License-Identifier: Apache-2.0
/**
 * The connection's one live buffer, reached from the engine (E5.2 step 16). The engine appends to
 * the same buffer the shell drives, and the shell's public store methods are what it calls.
 */
import type { EventPayload, ThreadId } from "@ace/protocol";
import type { BufferedSnapshot } from "../live-write-buffer.ts";
import { isStoreRetry } from "../store-busy.ts";
import type { Store } from "../store.ts";
import type { NativeEngineHandle } from "./engine.ts";

/** The snapshot an engine live write carries: E5.3 supplies the real one. */
const engineSnapshot: BufferedSnapshot = {
  persist() {},
  committed() {},
};

/**
 * Installs the engine's live-buffer hooks over the store's public methods. Returns the
 * unsubscribe the facade's terminal cleanup calls.
 */
export function liveStorePort(store: Store, native: NativeEngineHandle): () => void {
  const attach = native.attachLiveStore;
  if (typeof attach !== "function") return () => {};
  const settle = native.settlePromise?.bind(native);
  attach.call(native, {
    writableNow: () => store.writableNow(),
    writable: (id: number) => {
      store.writable().then(
        () => settle?.(id, true),
        (error: unknown) => settle?.(id, false, String(error)),
      );
    },
    historyWriting: () => store.isHistoryWriting(),
    liveWriteBlocked: () => store.liveWriteBlocked(),
    prepareLiveWrite: (bytes: number) => {
      try {
        store.prepareLiveWrite(bytes);
        return null;
      } catch (error) {
        return String((error as Error).message ?? error);
      }
    },
    bufferLiveWrite: (json: string) => {
      const entry = JSON.parse(json) as {
        thread: ThreadId;
        events: EventPayload[];
        at: number;
      };
      try {
        store.bufferLiveWrite(entry.thread, entry.events, entry.at, engineSnapshot);
        return null;
      } catch (error) {
        return String((error as Error).message ?? error);
      }
    },
    // Step 16's pumped flush (`runScheduled`) replaces this with the store's own attempt.
    flushDue: () => store.flushLiveWrites(),
    flushLiveWrites: () => store.flushLiveWrites(),
    isStoreRetry: (message: string) => isStoreRetry(new Error(message)),
  });
  // The store's quarantine notification (E5.3 step 8): its pin is already removed, so the
  // engine evicts that snapshot whether or not an actor exists.
  const stopQuarantine = store.onLiveWriteQuarantine((thread, error) => {
    native.liveQuarantined?.(thread, String(error.message ?? error));
  });
  return () => stopQuarantine();
}
