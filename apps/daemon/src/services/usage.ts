import { logError, logFields } from "@ace/diagnostics";
import { createDaemonUsage, loadUsageSettings } from "../usage.ts";
import type { ServiceContext } from "./types.ts";
export async function startUsage(context: ServiceContext): Promise<void> {
  const { config, store, resources, services, log } = context;

  const usage = createDaemonUsage(
    config.dataDir,
    store,
    await loadUsageSettings(config.dataDir),
    (error, failure) =>
      log.log(
        "error",
        "Usage analytics failure",
        logFields([
          ["error", logError(error)],
          ...(failure
            ? ([
                ["attempt", failure.attempt],
                ["retryInMs", failure.retryInMs],
              ] as const)
            : []),
        ]),
      ),
    undefined,
    context.now,
    services.accounts,
  );
  resources.own(() => usage.close());
  services.usage = usage;
  // Opening reads only the saved cursor. Replaying the history behind it is derived data: it runs
  // after start, one bounded page per turn of the event loop, resuming from the cursor that each
  // committed page advances, while summaries fill in as it goes (ADR 0170). A failed page retries
  // with backoff (`createDaemonUsage`) instead of holding the service in "starting".
  await usage.start();
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createUsageSession(context: SocketContext): SocketService {
  const { options, authorize, connected, send, fail } = context;
  let stop: (() => void) | undefined;

  return {
    authenticated(channel) {
      if (channel !== undefined || stop || !authorize("read")) return;
      stop = options.usage?.subscribeLimits?.((account) => {
        if (connected() && authorize("read")) send({ type: "usage.limits_changed", account });
      });
    },
    close() {
      stop?.();
    },
    async handle(message) {
      const reject = (code: string, detail: string) =>
        fail(
          code,
          detail,
          false,
          "requestId" in message && message.requestId !== undefined
            ? { requestId: message.requestId }
            : {},
        );
      switch (message.type) {
        case "usage.session_totals": {
          if (!authorize("read") || !context.canReadThread(message.query.thread)) {
            reject("forbidden", "Thread read scope required");
            return true;
          }
          if (!options.usage?.sessionTotals) {
            reject("usage_unavailable", "Inclusive usage estimates unavailable");
            return true;
          }
          try {
            const totals = await options.usage.sessionTotals(message.query);
            if (connected())
              send({ type: "usage.session_totals.result", requestId: message.requestId, totals });
          } catch {
            reject("usage_failed", "Usage snapshot query rejected");
          }
          return true;
        }
        case "usage.summary":
        case "usage.series": {
          if (!authorize("read")) {
            reject("forbidden", "Read scope required");
            return true;
          }
          if (!options.usage) {
            reject("usage_unavailable", "Usage analytics unavailable");
            return true;
          }
          try {
            const kind = message.type === "usage.summary" ? "summary" : "series";
            const result = await options.usage[kind](message.query);
            if (connected())
              send({ type: "usage.result", requestId: message.requestId, kind, result });
          } catch {
            reject("usage_failed", "Usage query rejected");
          }
          return true;
        }
      }
      return false;
    },
  };
}
