import type { ClientApi } from "@ace/client";
import { RemoteClient } from "@ace/client-worker";

/**
 * `vite --mode perf`: the app against the perf worker's endless agent (`?rate=` events/s,
 * `?history=` items of older history to page back through), or with `?long=1` the synthetic
 * five-day thread of a million items with its turn index (`?rate=` live items/s).
 */
export function bootPerf(): { client: ClientApi; threadId: string } {
  const search = new URLSearchParams(location.search);
  const rate = Number(search.get("rate") ?? 5_000);
  // Items of made-up history below the live stream (`?history=1000000` for a 1M-item thread).
  const history = Number(search.get("history") ?? 0);
  const long = search.get("long") === "1";
  const worker = new Worker(new URL("./perf-worker.ts", import.meta.url), {
    type: "module",
    name: "ace-perf-client",
  });
  const stats = { events: 0 };
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data === "object" && data !== null && "t" in data && data.t === "perf")
      if ("events" in data && typeof data.events === "number") stats.events = data.events;
  });
  // Read by tools/web-perf.
  Object.assign(globalThis, { acePerf: stats });
  const client = new RemoteClient(
    worker,
    { rate, history, long },
    {
      scheduler: {
        set(delayMs, callback) {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      visibility: {
        visible: () => document.visibilityState === "visible",
        watch(changed) {
          document.addEventListener("visibilitychange", changed);
          return () => document.removeEventListener("visibilitychange", changed);
        },
      },
    },
  );
  return { client, threadId: long ? "thread-multi-day" : "thread-soak" };
}
