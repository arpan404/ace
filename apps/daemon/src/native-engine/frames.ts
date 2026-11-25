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
        token: number;
      };
      // The snapshot is Rust's: the shell calls back for this token, never rebuilding it.
      const snapshot: BufferedSnapshot = {
        persist: () => {
          native.persistLive?.(entry.token);
        },
        committed: () => {
          native.committedLive?.(entry.token);
        },
        discarded: () => {
          native.discardLive?.(entry.token);
        },
      };
      try {
        store.bufferLiveWrite(entry.thread, entry.events, entry.at, snapshot);
        return null;
      } catch (error) {
        return String((error as Error).message ?? error);
      }
    },
    // The pump task the deadline and retry timer ask for (step 16): the scheduled-attempt path,
    // never `flush()`, so a pinned batch still retries.
    runScheduled: () => store.streaming.runScheduled(),
    flushLiveWrites: () => store.flushLiveWrites(),
    isStoreRetry: (message: string) => isStoreRetry(new Error(message)),
  });
  // With the engine attached the buffer's own timer asks the pump instead of attempting inline.
  store.streaming.setEngineFlush(() => {
    native.actorFlushDue?.();
  });
  // The store's quarantine notification (E5.3 step 8): its pin is already removed, so the
  // engine evicts that snapshot and tells the actor, whether or not one exists.
  const stopQuarantine = store.onLiveWriteQuarantine((thread, error) => {
    native.liveQuarantined?.(thread, String(error.message ?? error));
  });
  return () => {
    store.streaming.setEngineFlush(undefined);
    stopQuarantine();
  };
}
