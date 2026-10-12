import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type { StorageOwner } from "./types.ts";

/** An idle-only operation on a separate connection, outside every receipt transaction. */
export async function compactStorage(owner: StorageOwner): Promise<"complete" | "deferred"> {
  const idle = () =>
    !owner.store.isHistoryWriting() &&
    !owner.services.browser?.hasActiveSessions &&
    !owner.store
      .statement(
        "SELECT 1 FROM threads WHERE json_extract(status,'$.state') NOT IN ('new','done','failed') LIMIT 1",
      )
      .get() &&
    (!owner.services.engine || owner.services.engine.workload().activeSessions === 0);
  if (!idle()) return "deferred";
  const free = await statfs(owner.root);
  if (!idle()) return "deferred";
  const db = new DatabaseSync(join(owner.root, "events.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0");
    const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
    const pages = Number(db.prepare("PRAGMA page_count").get()?.page_count);
    if (free.bavail * free.bsize < pages * pageSize * 3) return "deferred";
    // No awaits after the idle check. The daemon cannot admit another event while SQLite runs.
    const mode = Number(db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum);
    if (mode === 2) db.exec("PRAGMA incremental_vacuum(256)");
    else db.exec("VACUUM");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return Number(checkpoint?.busy) === 0 ? "complete" : "deferred";
  } catch {
    return "deferred";
  } finally {
    db.close();
  }
}
