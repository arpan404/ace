import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { startCompactionProcess } from "./compaction-process.ts";
import type { StorageOwner } from "./types.ts";

/** Reserve maintenance admission and parent writes before starting the separate SQLite process. */
export async function compactStorage(owner: StorageOwner): Promise<"complete" | "deferred"> {
  const idle = () =>
    !owner.store.isHistoryWriting() &&
    !owner.maintenance?.hasPendingWork &&
    !owner.services.workspaceActions?.hasActiveTerminals &&
    !owner.services.browser?.hasActiveSessions &&
    !owner.store
      .statement(
        "SELECT 1 FROM threads WHERE json_extract(status,'$.state') NOT IN ('new','done','failed') LIMIT 1",
      )
      .get() &&
    (!owner.services.engine || owner.services.engine.workload().activeSessions === 0);
  if (!idle()) return "deferred";
  const free = await statfs(owner.root);
  if (!idle() || owner.signal?.aborted) return "deferred";
  const release = owner.maintenance?.storageLease();
  let worker: ReturnType<typeof startCompactionProcess> | undefined;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      owner.store.endStorageCompaction();
    } finally {
      release?.();
    }
  };
  try {
    owner.store.beginStorageCompaction();
    worker = startCompactionProcess(
      { database: join(owner.root, "events.sqlite"), availableBytes: free.bavail * free.bsize },
      owner.signal ?? new AbortController().signal,
      owner.compaction,
    );
    const result = await worker.result;
    if (!result.confirmed) {
      // Unknown termination cannot release a writer fence. Keep it until the owned process exits.
      void worker.exited.then(restore).catch(() => {});
      return "deferred";
    }
    restore();
    return result.status;
  } catch {
    if (!worker) restore();
    return "deferred";
  }
}
