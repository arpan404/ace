import type { ClientApi } from "@ace/client";
import { RemoteClient } from "@ace/client-worker";

/** `vite --mode perf`: the app against the perf worker's endless agent (?rate=events/s). */
export function bootPerf(): { client: ClientApi; threadId: string } {
  const rate = Number(new URLSearchParams(location.search).get("rate") ?? 5_000);
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
    { rate },
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
  return { client, threadId: "thread-soak" };
}
