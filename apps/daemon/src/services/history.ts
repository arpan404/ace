import { openDaemonHistory } from "../history.ts";
import type { ServiceContext } from "./types.ts";
export async function startHistory(context: ServiceContext): Promise<void> {
  const { config, options, store, resources, services } = context;

  if (!options.history) return;
  const history = await openDaemonHistory(config.dataDir, store, options.history);
  resources.own(() => history.close());
  services.history = history;
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createHistorySession(context: SocketContext): SocketService {
  const { options, authorize, canReadThread, send, fail } = context;
  const historyLifetime = new AbortController();
  return {
    close() {
      historyLifetime.abort();
    },
    async handle(message) {
      switch (message.type) {
        case "history.scan":
        case "history.list":
        case "history.import":
        case "history.continue": {
          const scope = message.type === "history.list" ? "read" : "operate";
          if (!authorize(scope)) {
            fail("forbidden", `${scope} scope required`);
            return true;
          }
          if (message.type === "history.continue" && !canReadThread(message.threadId)) {
            fail("read_denied", "Thread is not readable");
            return true;
          }
          if (!options.history) {
            fail("history_unavailable", "History is not configured");
            return true;
          }
          try {
            send(await options.history.handle(message, historyLifetime.signal));
          } catch {
            fail("history_rejected", "History operation rejected");
          }
          return true;
        }
      }
      return false;
    },
  };
}
