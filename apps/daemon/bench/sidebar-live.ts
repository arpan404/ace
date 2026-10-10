import { performance } from "node:perf_hooks";
import { Thread } from "@ace/protocol";
import { Store } from "../src/store.ts";
import { subscribe } from "../src/subscription.ts";

// Temp in-memory database; no user projects, provider sessions or network access.
const store = new Store(":memory:");
try {
  const workspace = store.createWorkspace("/bench", "Benchmark", 1);
  store.atomic(() => {
    for (let index = 0; index < 10_000; index++) {
      const thread = Thread.parse({
        id: `thread-${index}`,
        workspaceId: workspace,
        provider: "codex",
        title: `Task ${index}`,
        status: { state: "done" },
        createdAt: 1,
        updatedAt: index + 2,
        activityAt: index + 2,
        settledAt: 20_000,
        hasSentMessage: true,
      });
      store.appendEvents(thread.id, [{ type: "thread.created", thread }], index + 2);
    }
  });
  const active = Thread.parse({
    id: "active",
    workspaceId: workspace,
    provider: "codex",
    title: "Live",
    status: { state: "working", agents: 1 },
    createdAt: 1,
    updatedAt: 20_000,
    hasSentMessage: true,
  });
  store.appendEvents(active.id, [{ type: "thread.created", thread: active }], 20_000);
  for (const limit of [20, 1_000, 10_000]) {
    let payloads = 0,
      patches = 0;
    const stop = subscribe(
      store,
      "bench",
      { kind: "threads", window: { limit } },
      undefined,
      50_000,
      (message) => {
        if (message.type === "threads.patch") {
          patches++;
          payloads += Object.keys(message.threads).length;
        }
      },
    );
    const start = performance.now();
    for (let index = 0; index < 100; index++)
      store.appendEvents(
        active.id,
        [{ type: "thread.updated", title: `Update ${index}` }],
        30_000 + index,
      );
    const ms = performance.now() - start;
    stop();
    process.stdout.write(
      JSON.stringify({
        history: 10_000,
        loaded: limit,
        updates: patches,
        payloads,
        ms: Math.round(ms * 100) / 100,
      }) + "\n",
    );
    if (patches !== 100 || payloads !== 100)
      throw new Error("Unchanged history was republished or an update was lost");
  }
} finally {
  store.close();
}
