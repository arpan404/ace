import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";
/** Exact artifact ownership, including previous sessions; never grant the artifact's whole directory. */
export function browserArtifactAccess(store: Store): (threadId: string, path: string) => boolean {
  let indexed = false;
  return (threadId, path) => {
    // Upload-only metadata index: browser startup never scans thread history.
    if (!indexed) {
      store.atomic((db) =>
        db.exec(`CREATE INDEX IF NOT EXISTS browser_artifact_paths
        ON items(thread_id, json_extract(item, '$.path'))
        WHERE json_extract(item, '$.type') = 'artifact'`),
      );
      indexed = true;
    }
    const row = store
      .statement(`SELECT 1 AS allowed FROM items
      WHERE thread_id=? AND json_extract(item, '$.type')='artifact'
      AND json_extract(item, '$.path')=? LIMIT 1`)
      .get(ThreadId.parse(threadId), path);
    return z.object({ allowed: z.literal(1) }).safeParse(row).success;
  };
}
