import { afterEach, expect, test, vi } from "vitest";

// Browser workers are the injected edge. All attachment, freshness and retries use ClientApi.
class Port extends EventTarget {
  postMessage(value: unknown): void {
    if (typeof value !== "object" || value === null || !("t" in value) || value.t !== "connect")
      return;
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent("message", { data: { t: "attached", idPrefix: "tab" } }));
      this.dispatchEvent(
        new MessageEvent("message", { data: { t: "connection", state: "ready" } }),
      );
    });
  }
  start(): void {}
  close(): void {}
}
const clients: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("a primary shared-worker module error recovers through a dedicated worker without stopping another tab, and the desktop log hears why", async () => {
  const workers: EventTarget[] = [];
  const dedicated: EventTarget[] = [];
  let moduleFailed = false;
  class Shared extends EventTarget {
    port = new Port();
    constructor() {
      super();
      workers.push(this);
      if (moduleFailed) {
        this.port.postMessage = () => {
          queueMicrotask(() => this.dispatchEvent(new Event("error")));
        };
      }
    }
  }
  class Dedicated extends Port {
    constructor() {
      super();
      dedicated.push(this);
    }
    terminate(): void {
      this.close();
    }
  }
  const reported: { event: string; data?: Record<string, unknown> }[] = [];
  vi.stubGlobal("SharedWorker", Shared);
  vi.stubGlobal("Worker", Dedicated);
  vi.stubGlobal("ace", {
    diagnostics: { report: (event: (typeof reported)[number]) => reported.push(event) },
  });
  const { createWorkerClient } = await import("./worker-client.ts");
  const target = { url: "ws://localhost:4242", token: "a".repeat(64) };
  const failed = createWorkerClient(target, "device");
  const healthy = createWorkerClient(target, "device");
  if (!failed || !healthy) throw new Error("Expected worker clients");
  clients.push(failed, healthy);
  await Promise.all([failed.start(), healthy.start()]);
  const read = failed.request({ type: "diagnostics.health" });
  const rejected = expect(read).rejects.toMatchObject({ code: "offline" });
  moduleFailed = true;
  workers[0]?.dispatchEvent(new Event("error"));
  await rejected;
  expect(failed.state).not.toBe("fatal");
  // No Retry: the client brings up a dedicated worker on its own and is ready again.
  await vi.waitFor(() => expect(failed.state).toBe("ready"));
  expect(dedicated).toHaveLength(1);
  expect(healthy.state).toBe("ready");
  expect(reported).toContainEqual({
    event: "client-worker.lost",
    data: expect.objectContaining({ cause: "error" }),
  });
  expect(reported).toContainEqual({
    event: "client-worker.recovered",
    data: expect.objectContaining({ kind: "dedicated" }),
  });
  expect(JSON.stringify(reported)).not.toContain(target.token);
});

test("an asynchronous module error before any welcome recovers instead of failing the start", async () => {
  const workers: EventTarget[] = [];
  class Broken extends EventTarget {
    port = new Port();
    constructor() {
      super();
      workers.push(this);
    }
  }
  class Dedicated extends Port {
    terminate(): void {
      this.close();
    }
  }
  vi.stubGlobal("SharedWorker", Broken);
  vi.stubGlobal("Worker", Dedicated);
  vi.stubGlobal("console", { ...console, warn: () => {} });
  const { createWorkerClient } = await import("./worker-client.ts");
  const client = createWorkerClient(
    { url: "ws://localhost:4242", token: "a".repeat(64) },
    "device",
  );
  if (!client) throw new Error("Expected worker client");
  clients.push(client);
  const start = client.start();
  workers[0]?.dispatchEvent(new Event("error"));
  expect(client.state).toBe("reconnecting");
  await start;
  expect(client.state).toBe("ready");
});
