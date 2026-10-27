import { threadCleaning } from "./thread-cleanup-journal.ts";
import { organizationDecision } from "@ace/projection";
export { organizationCommands } from "@ace/projection";
import { ThreadId, type Command, type CommandResult, type ContentPart } from "@ace/protocol";
import type { Store } from "./store.ts";
import { oldestTitleInput } from "./engine/title-input.ts";
import { provisionalTitle } from "./engine/thread-title.ts";

export function organizeThread(
  store: Store,
  command: Command,
  at: number,
  ownsWork: (id: ThreadId) => boolean = noOwnedWork,
  /** A thread named again from its opening request: the utility model's title can follow. */
  renamed?: (id: ThreadId, opening: ContentPart[]) => void,
): CommandResult {
  const p = command.payload;
  if (!("threadId" in p)) return { commandId: command.id, ok: false, error: "invalid_command" };
  const thread = store.getThread(ThreadId.parse(p.threadId));
  if (!thread || thread.deletedAt !== undefined)
    return { commandId: command.id, ok: false, error: "thread_not_found" };
  if (threadCleaning(store, thread.id))
    return { commandId: command.id, ok: false, error: "thread_deleting" };
  if (p.type === "thread.delete") {
    if (threadHasPendingWork(store, thread.id, ownsWork))
      return { commandId: command.id, ok: false, error: "thread_busy" };
  }
  if (p.type === "thread.title.regenerate") {
    // Named again from its opening request, as a new thread is: its first words now; the
    // utility model's title follows (`ThreadTitles.regenerate`) and replaces them only.
    const opening = oldestTitleInput(store, thread.id);
    if (!opening) return { commandId: command.id, ok: false, error: "thread_title_unavailable" };
    store.appendEvents(
      thread.id,
      [{ type: "thread.updated", title: provisionalTitle(opening), titleSource: "provisional" }],
      at,
    );
    renamed?.(thread.id, opening);
    return { commandId: command.id, ok: true, threadId: thread.id };
  }
  const decision = organizationDecision(thread, command, at);
  if (typeof decision === "string") return { commandId: command.id, ok: false, error: decision };
  store.appendEvents(thread.id, [decision], at);
  return { commandId: command.id, ok: true, threadId: thread.id };
}
function noOwnedWork(): boolean {
  return false;
}

/** Terminal ownership and durable inputs supplement the whole-tree status. */
export function threadHasPendingWork(
  store: Store,
  id: ThreadId,
  ownsWork: (id: ThreadId) => boolean,
): boolean {
  if (ownsWork(id)) return true;
  return store.atomic((db) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intents'").get())
      return false;
    const held = db.prepare("SELECT 1 FROM sqlite_master WHERE name='engine_queue'").get()
      ? " AND NOT EXISTS (SELECT 1 FROM engine_queue q WHERE q.thread_id=intents.thread_id AND (q.paused=1 OR q.limited=1))"
      : "";
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM intents WHERE thread_id=? AND (status='running' OR awaiting=1 OR (status IN ('pending','queued')${held})) LIMIT 1`,
        )
        .get(id),
    );
  });
}
