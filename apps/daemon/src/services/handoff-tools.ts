import { handoffToolCatalog, type Toolkit } from "@ace/mcp-server";
import { HandoffAccess } from "../handoff-access.ts";
import type { Store } from "../store.ts";

export function handoffToolkit(store: Store): Toolkit {
  const access = new HandoffAccess(store);
  return {
    register(registry) {
      registry.register({
        ...handoffToolCatalog[0],
        async run(page, { caller, signal }) {
          signal.throwIfAborted();
          const through = access.boundary(caller.threadId, page.sourceThreadId);
          return store.readItemPage(
            page.sourceThreadId,
            Math.min(page.before ?? through + 1, through + 1),
            page.limit,
            128 * 1024,
          );
        },
      });
      registry.register({
        ...handoffToolCatalog[1],
        async run(chunk, { caller, signal }) {
          signal.throwIfAborted();
          const encoding = access.stream(caller.threadId, chunk.sourceThreadId, chunk.streamId);
          return { ...store.readOutput(chunk.streamId, chunk.offset, chunk.limit), encoding };
        },
      });
    },
  };
}
