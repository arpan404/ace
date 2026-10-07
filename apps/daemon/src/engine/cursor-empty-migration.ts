import { cursorDefaultInstanceId, cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

/** Only unused CLI threads can continue directly; native ACP identities never become SDK IDs. */
export function migrateEmptyCursorThreads(store: Store): void {
  store.atomic((db) => {
    const candidates = db.prepare(`SELECT t.id,s.instance_id,t.updated_at FROM threads t
      JOIN engine_sessions s ON s.thread_id=t.id
      JOIN thread_state snapshot ON snapshot.thread_id=t.id
      WHERE t.provider='cursor' AND COALESCE(json_extract(t.provider_metadata,'$.backend'),'acp')<>'cursor-sdk'
      AND s.native_session_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM items WHERE thread_id=t.id)
      AND json_extract(snapshot.state,'$.hasRun')=0
      AND NOT EXISTS (SELECT 1 FROM intents WHERE thread_id=t.id AND status IN ('pending','queued','running'))`);
    for (const row of candidates.iterate()) {
      const id = ThreadId.parse(row.id);
      const instanceId =
        row.instance_id == null
          ? cursorDefaultInstanceId
          : cursorInstanceId(String(row.instance_id));
      db.prepare(
        "UPDATE engine_sessions SET backend='cursor-sdk',instance_id=? WHERE thread_id=?",
      ).run(instanceId ?? cursorDefaultInstanceId, id);
      store.appendEvents(
        id,
        [{ type: "thread.updated", backend: "cursor-sdk" }],
        Number(row.updated_at),
      );
    }
  });
}
