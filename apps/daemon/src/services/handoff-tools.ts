import { handoffToolCatalog, type Toolkit } from "@ace/mcp-server";
import { HandoffAccess } from "../handoff-access.ts";
import type { Store } from "../store.ts";

export function handoffToolkit(store: Store): Toolkit {
  const access = new HandoffAccess(store);
  return {
    register(registry) {
      registry.register({
        ...handoffToolCatalog[0],
        async run(input, { caller, signal }) {
          signal.throwIfAborted();
          if (input.streamId) {
            const chunk = access.readStream(
              caller.threadId,
              input.sourceThreadId,
              input.streamId,
              input.offset,
              input.maxBytes,
            );
            return { ...chunk, bytes: chunk.bytes.toString("base64") };
          }
          const through = access.boundary(caller.threadId, input.sourceThreadId);
          return store.readBoundedHistoricalItemPage(
            input.sourceThreadId,
            through,
            Math.min(input.before ?? through + 1, through + 1),
            input.limit,
            128 * 1024,
          );
        },
      });
    },
  };
}
