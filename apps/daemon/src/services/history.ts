import { openDaemonHistory } from "../history.ts";
import type { ServiceContext } from "./types.ts";
export async function startHistory(context: ServiceContext): Promise<void> {
  const { config, options, store, resources, services } = context;

  if (!options.history) return;
  const history = await openDaemonHistory(config.dataDir, store, {
    ...options.history,
    ...((options.history.adapters ?? services.historyAdapters)
      ? { adapters: options.history.adapters ?? services.historyAdapters }
      : {}),
    signal: context.signal,
    log: context.log.child("history"),
  });
  resources.own(() => history.close());
  services.history = history;
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createHistorySession(context: SocketContext): SocketService {
  const { options, authorize, canReadThread, send, fail, tasks, connected } = context;
  const historyLifetime = new AbortController();
  let pending = 0;
  return {
    close() {
      historyLifetime.abort();
    },
    async handle(message) {
      switch (message.type) {
        case "history.release":
        case "history.list":
        case "history.import":
        case "history.continue": {
          // Listing reads provider files on the person's behalf, so it needs operate scope.
          const scope = message.type === "history.release" ? "read" : "operate";
          const correlation =
            "requestId" in message && message.requestId ? { requestId: message.requestId } : {};
          if (!authorize(scope)) {
            fail("forbidden", `${scope} scope required`, false, correlation);
            return true;
          }
          if (message.type === "history.continue" && !canReadThread(message.threadId)) {
            fail("read_denied", "Thread is not readable", false, correlation);
            return true;
          }
          if (!options.history) {
            fail("history_unavailable", "History is not configured", false, correlation);
            return true;
          }
          if (pending >= 8) {
            fail("history_busy", "Too many history requests", false, correlation);
            return true;
          }
          const readable = () =>
            connected() &&
            authorize(scope) &&
            (message.type !== "history.continue" || canReadThread(message.threadId));
          pending++;
          const task = options.history
            .handle(message, historyLifetime.signal, (event) => {
              if (readable()) send(event);
            })
            .then((result) => {
              if (readable()) send(result);
            })
            .catch(() => {
              if (connected())
                fail("history_rejected", "History operation rejected", false, correlation);
            })
            .finally(() => {
              pending--;
              tasks.delete(task);
            });
          tasks.add(task);
          return true;
        }
      }
      return false;
    },
  };
}
