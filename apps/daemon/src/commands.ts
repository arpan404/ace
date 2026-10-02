import { randomUUID } from "node:crypto";
import { Thread, type Command, type CommandResult, type WorkspaceId } from "@ace/protocol";
import type { Store } from "./store.ts";

/** The engine appends facts through this store inside the receipt transaction.
 * No network or provider process work may run inside this synchronous port.
 * Future providers should commit an intent here and execute it after commit. */
export interface CommandHandler {
  handle(command: Command, store: Store): CommandResult;
}
export function stubHandler(options: { development?: boolean } = {}): CommandHandler {
  return {
    handle(command, store) {
      const p = command.payload;
      if (p.type === "thread.archive") {
        if (!store.getThread(p.threadId))
          return { commandId: command.id, ok: false, error: "thread_not_found" };
        store.appendEvents(p.threadId, [{ type: "thread.updated", archivedAt: Date.now() }]);
        return { commandId: command.id, ok: true };
      }
      if (p.type === "thread.create" && options.development) {
        const thread = createDevThread(
          store,
          p.workspaceId,
          p.title ?? "Development thread",
          p.provider,
        );
        return { commandId: command.id, ok: Boolean(thread) };
      }
      return { commandId: command.id, ok: false, error: "not_implemented" };
    },
  };
}
export function createDevThread(
  store: Store,
  workspaceId: WorkspaceId,
  title = "Development thread",
  provider: Thread["provider"] = "codex",
): Thread {
  const at = Date.now();
  const thread = Thread.parse({
    id: randomUUID(),
    workspaceId,
    title,
    provider,
    status: { state: "new" },
    createdAt: at,
    updatedAt: at,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }], at);
  return thread;
}
