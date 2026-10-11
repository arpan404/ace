import { ThreadId } from "@ace/protocol";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialRegistry, ToolRegistry, startMcpServer, type Scheduler } from "./index.ts";
import { deferred, harness, scope } from "./test-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const input = z.strictObject({});
const output = z.strictObject({ done: z.boolean() });

for (const mode of ["modern", "legacy"] as const) {
  it(`cancels a ${mode} HTTP tool at its backend boundary`, async () => {
    const h = await harness(cleanups);
    const started = deferred<void>();
    const aborted = deferred<void>();
    const release = deferred<void>();
    h.registry.register({
      name: "ace_wait",
      description: "Wait",
      input,
      output,
      capability: null,
      timeoutMs: 10_000,
      async run(_, context) {
        context.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            release.resolve();
          },
          { once: true },
        );
        started.resolve();
        await release.promise;
        return { done: true };
      },
    });
    const { client } = await h.connect(scope(), mode);
    const cancellation = new AbortController();
    const result = client.callTool({ name: "ace_wait" }, { signal: cancellation.signal });
    const rejected = expect(result).rejects.toThrow();
    await started.promise;
    cancellation.abort();
    await rejected;
    await aborted.promise;
  });
}

it("revocation aborts a running tool and prevents a late success", async () => {
  const h = await harness(cleanups);
  const started = deferred<void>();
  const aborted = deferred<void>();
  h.registry.register({
    name: "ace_wait",
    description: "Wait",
    input,
    output,
    capability: null,
    timeoutMs: 10_000,
    async run(_, context) {
      context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      await aborted.promise;
      return { done: true };
    },
  });
  const { client, lease } = await h.connect();
  const result = client.callTool({ name: "ace_wait" });
  await started.promise;
  lease.end();
  await aborted.promise;
  expect(await result).toMatchObject({ isError: true });
  expect(
    await h.registry.call("ace_wait", {}, lease.principal, new AbortController().signal),
  ).toMatchObject({ isError: true, content: [{ text: "Session ended" }] });
});

it("timeouts abort the tool using an injected timer and suppress late results", async () => {
  const timerReady = deferred<() => void>();
  const scheduler: Scheduler = {
    after(_, callback) {
      timerReady.resolve(callback);
      return () => {};
    },
  };
  const h = await harness(cleanups, scheduler);
  const started = deferred<void>();
  const aborted = deferred<void>();
  h.registry.register({
    name: "ace_wait",
    description: "Wait",
    input,
    output,
    capability: null,
    timeoutMs: 99,
    async run(_, context) {
      context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      await aborted.promise;
      return { done: true };
    },
  });
  const { client } = await h.connect();
  const result = client.callTool({ name: "ace_wait" });
  await started.promise;
  (await timerReady.promise)();
  expect(await result).toMatchObject({ isError: true, content: [{ text: "Tool timed out" }] });
  await aborted.promise;
});

it("retains capacity for a backend that ignores timeout until it finishes", async () => {
  const timer = deferred<() => void>();
  const registry = new ToolRegistry({
    scheduler: {
      after(_, callback) {
        timer.resolve(callback);
        return () => {};
      },
    },
    maxCalls: 1,
  });
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(scope(), new AbortController().signal);
  const release = deferred<void>();
  const finished = deferred<void>();
  registry.register({
    name: "ace_wait",
    description: "Wait",
    input,
    output,
    capability: null,
    timeoutMs: 1,
    async run() {
      await release.promise;
      finished.resolve();
      return { done: true };
    },
  });
  const signal = new AbortController().signal;
  const first = registry.call("ace_wait", {}, lease.principal, signal);
  (await timer.promise)();
  expect(await first).toMatchObject({ isError: true, content: [{ text: "Tool timed out" }] });
  expect(await registry.call("ace_wait", {}, lease.principal, signal)).toMatchObject({
    isError: true,
    content: [{ text: "Tool capacity reached" }],
  });
  release.resolve();
  await finished.promise;
  // The next event-loop turn runs after the settled backend's microtasks.
  await setImmediate();
  expect(await registry.call("ace_wait", {}, lease.principal, signal)).toMatchObject({
    structuredContent: { done: true },
  });
});

it("validates both tool boundaries and never exposes backend errors", async () => {
  const h = await harness(cleanups);
  let effects = 0;
  h.registry.register({
    name: "ace_echo",
    description: "Echo",
    input: z.strictObject({ n: z.number() }),
    output: z.strictObject({ n: z.number().positive() }),
    capability: null,
    timeoutMs: 1000,
    async run(value) {
      effects++;
      if (value.n === 42) throw new Error("secret bearer material");
      return value;
    },
  });
  const { client } = await h.connect();
  expect(await client.callTool({ name: "ace_echo", arguments: { n: "bad" } })).toMatchObject({
    isError: true,
  });
  expect(effects).toBe(0);
  expect(await client.callTool({ name: "ace_echo", arguments: { n: -1 } })).toMatchObject({
    isError: true,
  });
  const response = await client.callTool({ name: "ace_echo", arguments: { n: 42 } });
  expect(response).toMatchObject({ isError: true });
  expect(JSON.stringify(response)).not.toContain("secret");
});

it("refuses new credentials at capacity and permanently closes authority on shutdown", () => {
  let next = 0;
  const credentials = new CredentialRegistry(() => (++next).toString(16).padStart(64, "0"), 1);
  const signal = new AbortController().signal;
  const first = credentials.issue(scope(), signal);
  expect(() => credentials.issue(scope("child"), signal)).toThrow("capacity");
  first.end();
  const second = credentials.issue(scope("child"), signal);
  first.end();
  expect(credentials.authenticate(second.bearer)?.scope.agentId).toBe("child");
  credentials.close();
  expect(credentials.authenticate(second.bearer)).toBeUndefined();
  expect(() => credentials.issue(scope(), signal)).toThrow("closed");
});

it("rejects oversized, cyclic and deeply nested results before output validation or serialization", async () => {
  const h = await harness(cleanups);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) deep = { next: deep };
  h.registry.register({
    name: "ace_large",
    description: "Large output",
    input: z.strictObject({ kind: z.enum(["large", "cycle", "deep", "small"]) }),
    output: z.strictObject({ data: z.unknown() }),
    capability: null,
    timeoutMs: 1000,
    async run(value) {
      return {
        data:
          value.kind === "large"
            ? "x".repeat(256 * 1024 + 1)
            : value.kind === "cycle"
              ? cycle
              : value.kind === "deep"
                ? deep
                : "small",
      };
    },
  });
  const { client } = await h.connect();
  for (const kind of ["large", "cycle", "deep"])
    expect(await client.callTool({ name: "ace_large", arguments: { kind } })).toMatchObject({
      isError: true,
      content: [{ text: "Tool result too large" }],
    });
  expect(await client.callTool({ name: "ace_large", arguments: { kind: "small" } })).toMatchObject({
    structuredContent: { data: "small" },
  });
});

it("expiry revokes credentials and aborts an in-flight tool before a late result can succeed", async () => {
  const deadline = deferred<() => void>();
  const credentials = new CredentialRegistry(() => "b".repeat(64), 1, {
    maxAgeMs: 60_000,
    scheduler: {
      after(_delay, callback) {
        deadline.resolve(callback);
        return () => {};
      },
    },
  });
  const registry = new ToolRegistry({
    scheduler: {
      after() {
        return () => {};
      },
    },
  });
  const lease = credentials.issue(scope(), new AbortController().signal);
  const started = deferred<void>();
  const aborted = deferred<void>();
  registry.register({
    name: "ace_wait",
    description: "Wait",
    input,
    output,
    capability: null,
    timeoutMs: 120_000,
    async run(_input, context) {
      context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      await aborted.promise;
      return { done: true };
    },
  });
  const result = registry.call("ace_wait", {}, lease.principal, new AbortController().signal);
  await started.promise;
  (await deadline.promise)();
  await aborted.promise;
  expect(await result).toMatchObject({ isError: true, content: [{ text: "Tool cancelled" }] });
  expect(credentials.authenticate(lease.bearer)).toBeUndefined();
});

it("a default lease stays usable beyond one hour and is revoked only when its provider session ends", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const server = await startMcpServer({ registry });
  cleanups.push(() => server.close());
  const lifetime = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const lease = server.credentials.issue(scope(), lifetime.signal);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    expect(lease.principal.signal.aborted).toBe(false);
    expect(server.credentials.authenticate(lease.bearer)?.scope.agentId).toBe("root");
    expect(await registry.call("missing", {}, lease.principal, lifetime.signal)).toMatchObject({
      content: [{ text: "Tool unavailable or capability denied" }],
    });
    lifetime.abort();
    expect(server.credentials.authenticate(lease.bearer)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("one busy thread cannot consume another thread's tool slots, and its own slots recover after completion", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  let id = 0;
  const credentials = new CredentialRegistry(() => (++id).toString(16).padStart(64, "0"));
  const lifetime = new AbortController();
  const busy = credentials.issue(scope(), lifetime.signal);
  const other = credentials.issue(
    { ...scope("other"), threadId: ThreadId.parse("other") },
    lifetime.signal,
  );
  const released = deferred<void>();
  registry.register({
    name: "ace_wait",
    description: "Wait",
    input: z.object({ wait: z.boolean() }),
    output,
    capability: null,
    timeoutMs: 300_000,
    async run(value) {
      if (value.wait) await released.promise;
      return { done: true };
    },
  });
  const pending = Array.from({ length: 16 }, () =>
    registry.call("ace_wait", { wait: true }, busy.principal, lifetime.signal),
  );
  try {
    expect(
      await registry.call("ace_wait", { wait: false }, busy.principal, lifetime.signal),
    ).toMatchObject({ isError: true });
    expect(
      await registry.call("ace_wait", { wait: false }, other.principal, lifetime.signal),
    ).toMatchObject({ structuredContent: { done: true } });
  } finally {
    released.resolve();
    await Promise.all(pending);
    expect(
      await registry.call("ace_wait", { wait: false }, busy.principal, lifetime.signal),
    ).toMatchObject({ structuredContent: { done: true } });
    credentials.close();
  }
});
