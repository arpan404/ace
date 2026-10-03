import { organizationDecision } from "@ace/projection";
export { organizationCommands } from "@ace/projection";
import { ThreadId, type Command, type CommandResult } from "@ace/protocol";
import type { Store } from "./store.ts";

export function organizeThread(store: Store, command: Command, at: number): CommandResult {
  const p = command.payload;
  if (!("threadId" in p)) return { commandId: command.id, ok: false, error: "invalid_command" };
  const thread = store.getThread(ThreadId.parse(p.threadId));
  if (!thread || thread.deletedAt !== undefined)
    return { commandId: command.id, ok: false, error: "thread_not_found" };
  if (p.type === "thread.delete") {
    const pending = store.atomic((db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intents'").get())
        return false;
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM intents WHERE thread_id=? AND (status IN ('pending','queued','running') OR awaiting=1) LIMIT 1",
          )
          .get(thread.id),
      );
    });
    if (pending) return { commandId: command.id, ok: false, error: "thread_busy" };
  }
  const decision = organizationDecision(thread, command, at);
  if (typeof decision === "string") return { commandId: command.id, ok: false, error: decision };
  store.appendEvents(thread.id, [decision], at);
  return { commandId: command.id, ok: true, threadId: thread.id };
}
