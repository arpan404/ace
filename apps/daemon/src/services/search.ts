import type { SocketContext, SocketService } from "./socket.ts";
export function createSearchSession(context: SocketContext): SocketService {
  return {
    handle(message) {
      if (message.type !== "search.status" && message.type !== "search.query") return false;
      if (!context.authorize("read")) {
        context.fail("forbidden", "Read scope required");
        return true;
      }
      if (message.type === "search.status")
        context.send({
          type: "search.progress",
          requestId: message.requestId,
          ...context.options.store.search.status(context.options.store.headSeq()),
        });
      else {
        const task = context.options.store.searchQueries
          .query(message)
          .then(
            (results) => {
              if (context.connected() && context.authorize("read"))
                context.send({ type: "search.results", requestId: message.requestId, ...results });
            },
            (error: unknown) => {
              const code =
                error instanceof Error &&
                (error.message === "search_cursor_stale" ||
                  error.message === "search_invalid_query")
                  ? error.message
                  : "search_failed";
              if (context.connected() && context.authorize("read"))
                context.send({ type: "search.error", requestId: message.requestId, code });
            },
          )
          .finally(() => context.tasks.delete(task));
        context.tasks.add(task);
      }
      return true;
    },
  };
}
