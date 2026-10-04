import { ThreadId } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

export function createLongThreadSession(context: SocketContext): SocketService {
  const store = context.options.store;
  return {
    handle(message, device) {
      if (
        message.type !== "turns.page" &&
        message.type !== "items.window" &&
        message.type !== "thread.search" &&
        message.type !== "thread.catchUp" &&
        message.type !== "thread.readState"
      )
        return false;
      if (!context.authorize("read") || !context.canReadThread(message.threadId)) {
        context.fail("forbidden", "Thread is not readable", false, {
          requestId: message.requestId,
        });
        return true;
      }
      try {
        switch (message.type) {
          case "turns.page": {
            const page = store.turnsPage(message);
            if (
              page.turns.some((turn) =>
                turn.subagents.some(
                  (agent) => agent.threadId && !context.canReadThread(agent.threadId),
                ),
              )
            )
              throw new Error("forbidden");
            context.send(page);
            break;
          }
          case "items.window":
            context.send(store.itemsWindow(message));
            break;
          case "thread.search":
            context.send(store.threadSearch(message, context.canReadThread));
            break;
          case "thread.catchUp":
            context.send(store.threadCatchUp(message, context.canReadThread));
            break;
          case "thread.readState":
            context.send(store.threadReadState(message.threadId, device, message.requestId));
            break;
        }
      } catch (error) {
        const code =
          error instanceof Error &&
          [
            "thread_not_found",
            "turn_target_unavailable",
            "thread_tree_too_large",
            "forbidden",
            "search_cursor_stale",
            "search_invalid_query",
          ].includes(error.message)
            ? error.message
            : "long_thread_read_failed";
        context.fail(code, "Long-thread read failed", false, { requestId: message.requestId });
      }
      return true;
    },
    command: {
      types: ["thread.markRead"],
      scope: () => "read",
      accept(command, device) {
        if (command.payload.type !== "thread.markRead") return;
        const receipt = store.commandReceipt(command.id, device);
        if (receipt) {
          context.send({ type: "commandResult", ...receipt });
          return;
        }
        const payload = command.payload;
        if (!context.canReadThread(ThreadId.parse(payload.threadId))) {
          context.send({
            type: "commandResult",
            commandId: command.id,
            ok: false,
            error: "forbidden",
          });
          return;
        }
        const result = store.recordCommand(command.id, device, () => {
          store.markThreadRead(payload.threadId, device, payload.lastSeenSeq);
          return { commandId: command.id, ok: true };
        });
        context.send({ type: "commandResult", ...result });
      },
    },
  };
}
