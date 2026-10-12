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

test("a primary shared-worker module error is actionable and retry selects a dedicated worker without stopping another tab", async () => {
  const workers: EventTarget[] = [];
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
    terminate(): void {
      this.close();
    }
  }
  vi.stubGlobal("SharedWorker", Shared);
  vi.stubGlobal("Worker", Dedicated);
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
  expect(failed.state).toBe("fatal");
  expect(failed.error?.message).toContain("Retry");
  await failed.close();
  expect(healthy.state).toBe("ready");
  const retry = createWorkerClient(target, "device");
  if (!retry) throw new Error("Expected dedicated fallback");
  clients.push(retry);
  await retry.start();
  expect(retry.state).toBe("ready");
  expect(healthy.state).toBe("ready");
});

test("an asynchronous module error settles primary attachment before any welcome", async () => {
  const workers: EventTarget[] = [];
  class Broken extends EventTarget {
    port = new Port();
    constructor() {
      super();
      workers.push(this);
    }
  }
  vi.stubGlobal("SharedWorker", Broken);
  const { createWorkerClient } = await import("./worker-client.ts");
  const client = createWorkerClient(
    { url: "ws://localhost:4242", token: "a".repeat(64) },
    "device",
  );
  if (!client) throw new Error("Expected worker client");
  clients.push(client);
  const start = client.start();
  const rejected = expect(start).rejects.toMatchObject({ code: "offline" });
  workers[0]?.dispatchEvent(new Event("error"));
  await rejected;
  expect(client.state).toBe("fatal");
});
