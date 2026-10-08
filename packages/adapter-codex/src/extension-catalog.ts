import type { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { obj } from "./native.ts";
/** Coalesced read-only metadata refreshes; notifications during a read cause one more read. */
export function createExtensionCatalog(
  rpc: JsonRpcPeer,
  cwd: string,
  signal: AbortSignal,
  closed: () => boolean,
  thread: () => string,
  emit: (data: unknown) => void,
) {
  const running = new Map<string, Promise<void>>(),
    dirty = new Set<string>();
  function refresh(method: string): Promise<void> {
    const existing = running.get(method);
    if (existing) {
      dirty.add(method);
      return existing;
    }
    if (closed() || signal.aborted) return Promise.resolve();
    const work = (async () => {
      do {
        dirty.delete(method);
        try {
          const params =
            method === "skills/list"
              ? { cwds: [cwd], forceReload: true }
              : method === "app/list"
                ? { threadId: thread(), limit: 100 }
                : { limit: 100 };
          const data: unknown[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 6; page++) {
            const result = await rpc.request(
              method,
              { ...params, ...(cursor ? { cursor } : {}) },
              { timeoutMs: 5000, signal },
            );
            const body = obj(result);
            if (!Array.isArray(body["data"])) return;
            data.push(...body["data"].slice(0, 512 - data.length));
            cursor = typeof body["nextCursor"] === "string" ? body["nextCursor"] : undefined;
            if (!cursor || data.length >= 512) break;
          }
          if (!closed()) emit({ method, result: { data }, cwd });
        } catch {
          /* Optional APIs preserve the last successful snapshot when unavailable. */
        }
      } while (!closed() && !signal.aborted && dirty.has(method));
    })().finally(() => {
      running.delete(method);
      dirty.delete(method);
    });
    running.set(method, work);
    return work;
  }
  return {
    start() {
      for (const method of ["skills/list", "app/list", "mcpServerStatus/list"])
        void refresh(method);
    },
    changed(method: string) {
      const surface =
        method === "skills/changed"
          ? "skills/list"
          : method === "app/list/updated"
            ? "app/list"
            : method === "mcpServer/updated"
              ? "mcpServerStatus/list"
              : undefined;
      if (surface) void refresh(surface);
    },
  };
}
