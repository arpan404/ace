import { randomUUID } from "node:crypto";
import { Thread, type Command, type CommandResult, type WorkspaceId } from "@ace/protocol";
import type { Store } from "./store.ts";

export type CommandContext = Pick<
  Store,
  "appendEvents" | "getThread" | "readEvents" | "getInteraction"
>;
export function commandContext(store: Store): CommandContext {
  return {
    appendEvents: store.appendEvents.bind(store),
    getThread: store.getThread.bind(store),
    getInteraction: store.getInteraction.bind(store),
    readEvents: store.readEvents.bind(store),
  };
}

/** The engine appends facts through this store inside the receipt transaction.
 * No network or provider process work may run inside this synchronous port.
 * Future providers should commit an intent here and execute it after commit. */
export interface CommandHandler {
  handle(command: Command, store: CommandContext): CommandResult;
}
export function stubHandler(
  options: { development?: boolean; now?: () => number } = {},
): CommandHandler {
  const now = options.now ?? Date.now;
  return {
    handle(command, store) {
      const p = command.payload;
      if (p.type === "interaction.resolve") {
        const interaction = store.getInteraction(p.interactionId);
        if (!interaction)
          return { commandId: command.id, ok: false, error: "interaction_not_found" };
        if (interaction.state !== "pending")
          return { commandId: command.id, ok: false, error: "already_resolved" };
        if (interaction.request.kind !== p.resolution.kind)
          return { commandId: command.id, ok: false, error: "invalid_resolution" };
        store.appendEvents(interaction.threadId, [
          {
            type: "interaction.closed",
            interactionId: interaction.id,
            state: "resolved",
            closedAt: now(),
            resolvedBy: command.deviceId,
            resolution: p.resolution,
          },
        ]);
        return { commandId: command.id, ok: true };
      }
      if (p.type === "thread.archive") {
        if (!store.getThread(p.threadId))
          return { commandId: command.id, ok: false, error: "thread_not_found" };
        store.appendEvents(p.threadId, [{ type: "thread.updated", archivedAt: now() }]);
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
  store: Pick<CommandContext, "appendEvents">,
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
