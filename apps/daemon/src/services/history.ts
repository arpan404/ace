import { logError, logFields } from "@ace/diagnostics";
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
    onError(error, operation) {
      context.log.log(
        "warn",
        "Past sessions operation failed",
        logFields([
          ["operation", operation],
          ["error", logError(error)],
        ]),
      );
      options.history?.onError?.(error, operation);
    },
  });
  resources.own(() => history.close());
  services.history = history;
  context.readiness?.(() => {
    const scan = history.scanStatus();
    return {
      state:
        scan.state === "scanning" ? "starting" : scan.state === "failed" ? "degraded" : "ready",
      ...(scan.error ? { error: `Service history: ${scan.error}` } : {}),
    };
  });
  context.onListen.push((server) => {
    resources.own(history.subscribeScan((scan) => server.broadcastHistoryScan(scan)));
    server.broadcastHistoryScan(history.scanStatus());
  });
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createHistorySession(context: SocketContext): SocketService {
  const { options, authorize, canReadThread, send, fail, tasks, connected } = context;
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
          const scope =
            message.type === "history.list" ||
            (message.type === "history.scan" && message.action === "status")
              ? "read"
              : "operate";
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
          if (tasks.size >= 8) {
            fail("history_busy", "Too many history requests", false, correlation);
            return true;
          }
          const readable = () =>
            connected() &&
            authorize(scope) &&
            (message.type !== "history.continue" || canReadThread(message.threadId));
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
            .finally(() => tasks.delete(task));
          tasks.add(task);
          return true;
        }
      }
      return false;
    },
  };
}
