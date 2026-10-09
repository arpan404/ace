import { provisionalTitle } from "./thread-title.ts";
import { z } from "zod";
import type { ContentPart, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
const person = `json_extract(item,'$.type')='message' AND json_extract(item,'$.role')='user'
  AND COALESCE(json_extract(item,'$.synthetic'),0)=0
  AND COALESCE(json_extract(item,'$.origin.kind'),'person') IN ('person','queue')`;
/** SQLite maintains the predicate index on insert/update/delete, including old history. */
export function indexTitleInputs(store: Store): void {
  store.atomic((db) =>
    db.exec(
      `CREATE INDEX IF NOT EXISTS engine_first_person_input ON items(thread_id,created_seq) WHERE ${person}`,
    ),
  );
}
/** Seek the first real prose input, skipping empty attachment or handoff envelopes in bounded pages. */
export function oldestTitleInput(store: Store, id: ThreadId): ContentPart[] | undefined {
  for (const row of store
    .statement(`SELECT created_seq FROM items WHERE thread_id=? AND ${person} ORDER BY created_seq`)
    .iterate(id)) {
    const seq = z.number().int().nonnegative().parse(row.created_seq);
    const item = store.readItemPage(id, seq + 1, 1, 256 * 1024).items[0];
    if (item?.type === "message" && provisionalTitle(item.parts) !== "New thread")
      return item.parts;
  }
  return undefined;
}

/** Upgrade old placeholder titles once, preserving every recorded author choice. */
export function backfillThreadTitles(store: Store, at: number): void {
  for (const thread of store.listThreads()) {
    if (thread.title !== "New thread" || thread.titleSource || thread.deletedAt !== undefined)
      continue;
    const parts = oldestTitleInput(store, thread.id);
    const title = parts && provisionalTitle(parts);
    if (title && title !== "New thread")
      store.appendEvents(
        thread.id,
        [{ type: "thread.updated", title, titleSource: "provisional" }],
        at,
      );
  }
}
