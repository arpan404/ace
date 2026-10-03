import { createDaemonUsage, loadUsageSettings } from "../usage.ts";
import type { ServiceContext } from "./types.ts";
export async function startUsage(context: ServiceContext): Promise<void> {
  const { config, store, resources, services, log } = context;

  const usage = createDaemonUsage(
    config.dataDir,
    store,
    await loadUsageSettings(config.dataDir),
    () => log.log("error", "Usage analytics failure"),
  );
  resources.own(() => usage.close());
  services.usage = usage;
  await usage.start();
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createUsageSession(context: SocketContext): SocketService {
  const { options, authorize, connected, send, fail } = context;

  return {
    async handle(message) {
      switch (message.type) {
        case "usage.summary":
        case "usage.series": {
          if (!authorize("read")) {
            fail("forbidden", "Read scope required");
            return true;
          }
          if (!options.usage) {
            fail("usage_unavailable", "Usage analytics unavailable");
            return true;
          }
          try {
            const kind = message.type === "usage.summary" ? "summary" : "series";
            const result = await options.usage[kind](message.query);
            if (connected())
              send({ type: "usage.result", requestId: message.requestId, kind, result });
          } catch {
            fail("usage_failed", "Usage query rejected");
          }
          return true;
        }
      }
      return false;
    },
  };
}
