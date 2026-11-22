import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { CursorTranslator, cursorCapabilities, type CursorEnvelope } from "@ace/adapter-cursor";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Command, ThreadId } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";

const deliver = (context: SessionContext, value: CursorEnvelope, seq: number) => {
  const payload = new ProviderPayload(JSON.stringify(value));
  return context.onFrame({
    seq,
    t: seq,
    dir: value.kind === "send" ? "send" : "recv",
    channel: "sdk",
    data: payload.data,
    payload,
  });
};
const threadId = ThreadId.parse("crashed-thread");

/**
 * Kills a daemon (a real process) at `window` of its first send, then starts a new one on the
 * same database with a fake Cursor host that speaks the host's frames, and lets the person
 * resume. Returns what the new host was told and asked to send.
 */
async function crashAt(window: "submitted" | "attempted" | "admitted") {
  const root = await mkdtemp(join(tmpdir(), "cursor-daemon-recovery-"));
  const path = join(root, "state.sqlite");
  const child = fork(new URL("./cursor-recovery-child.ts", import.meta.url), [path, root, window], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exit.then(() => {
        throw new Error("Recovery fixture exited before its crash point");
      }),
    ]);
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
  const store = new Store(path);
  const registry = new AdapterRegistry();
  const opened: SessionContext["resume"][] = [];
  const sent: string[] = [];
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession(context) {
        opened.push(context.resume);
        let seq = 0;
        let operationId = "open";
        const emit = (kind: string, body: unknown, extra: Partial<CursorEnvelope> = {}) =>
          deliver(
            context,
            {
              schemaVersion: 1,
              generation: `after-crash-${opened.length}`,
              operationId,
              segment: 0,
              agentId: "native-agent",
              kind,
              body,
              ...extra,
            },
            ++seq,
          );
        context.onSessionIdentity?.({
          backend: "cursor-sdk",
          instanceId: "account-a",
          nativeSessionId: "native-agent",
        });
        await emit("open", { cwd: root, model: "composer-2.5" });
        // As the host does: what the daemon's record lacks is read back from Cursor's store.
        const unsettled = context.resume?.unsettled;
        if (unsettled?.attempt) await emit("admission", { ...unsettled.attempt, admitted: false });
        for (const run of unsettled?.runs ?? [])
          await emit(
            "recovery",
            { nativeStatus: "finished", interrupted: false, result: "finished after the crash" },
            { runId: run.runId },
          );
        return {
          nativeSessionId: "native-agent",
          backend: "cursor-sdk",
          instanceId: "account-a",
          async send(input, _delivery, intent) {
            sent.push(input.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
            operationId = intent ?? "resent";
            await emit("send", { input, attemptedAt: 1 });
            await emit("segment", { nativeRunId: "run-2" }, { runId: "run-2" });
            await emit("result", { status: "finished" }, { runId: "run-2" });
          },
          async interrupt() {},
          async resolve() {},
          async stopTask() {},
          async close() {},
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  const engine = new Engine(store, { registry, selectInstance: () => "account-a" });
  await engine.flush();
  const held = engine.queue(threadId);
  for (const type of ["queue.resume", "thread.resume"] as const) {
    engine.handler.handle(
      Command.parse({
        id: `${type}-command`,
        deviceId: "device",
        payload: { type, threadId, expectedRevision: engine.queue(threadId).revision },
      }),
      store,
    );
    await engine.flush();
  }
  const userTexts = store
    .readItems(threadId, store.headSeq() + 1, 200)
    .items.flatMap((item) =>
      item.type === "message" && item.role === "user"
        ? [item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")]
        : [],
    );
  return {
    held,
    opened,
    sent,
    userTexts,
    items: store.readItems(threadId, store.headSeq() + 1, 200).items,
    async [Symbol.asyncDispose]() {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("a send the daemon recorded but the host never attempted is delivered again once, not held as uncertain", async () => {
  await using crash = await crashAt("submitted");
  expect(crash.held.reason).not.toBe("uncertain");
  expect(crash.sent.filter((text) => text.endsWith("first"))).toHaveLength(1);
  expect(crash.userTexts.filter((text) => text === "first")).toHaveLength(1);
});

it("a send the host attempted but Cursor never admitted is never sent twice and never lost", async () => {
  await using crash = await crashAt("attempted");
  expect(crash.sent.filter((text) => text.endsWith("first"))).toEqual([]);
  // Held for the person, still in the queue: whether Cursor got it is not known to the daemon.
  expect(crash.held).toMatchObject({ paused: true, reason: "uncertain" });
  expect(crash.held.pendingCount).toBeGreaterThan(0);
});

it("a send Cursor admitted before the crash is acknowledged, not resent, and its run is read back on reopen", async () => {
  await using crash = await crashAt("admitted");
  // Only the restart's own continuation waits; the person's message is Cursor's.
  expect(crash.held.messages).toEqual([]);
  expect(crash.sent.filter((text) => text.endsWith("first"))).toEqual([]);
  expect(crash.opened.at(-1)?.unsettled).toEqual({ runs: [{ runId: "run-1", through: 1 }] });
  const answers = crash.items.filter(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expect(JSON.stringify(answers)).toContain("finished after the crash");
});

it("pins the selected account when create is accepted and honors an explicit account override", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-create-account-"));
  const store = new Store(join(root, "state.sqlite"));
  const registry = new AdapterRegistry();
  const opened: string[] = [];
  let selected = "account-a";
  let next = 0;
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession(context) {
        if (!context.instanceId) throw new Error("Account was not pinned at admission");
        const instanceId = context.instanceId;
        opened.push(instanceId);
        context.onSessionIdentity?.({
          backend: "cursor-sdk",
          instanceId,
          nativeSessionId: `native-${context.threadId}`,
        });
        return {
          backend: "cursor-sdk",
          instanceId,
          nativeSessionId: `native-${context.threadId}`,
          async send() {},
          async interrupt() {},
          async resolve() {},
          async stopTask() {},
          async close() {},
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  const engine = new Engine(store, {
    registry,
    selectInstance: () => selected,
    threadId: () => `thread-${++next}`,
  });
  try {
    const workspaceId = store.createWorkspace(root, "Account workspace");
    for (const [id, instanceId] of [
      ["selected", undefined],
      ["explicit", "account-c"],
    ] as const) {
      const command = Command.parse({
        id,
        deviceId: "device",
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "cursor",
          input: [{ type: "text", text: "offline account selection" }],
          ...(instanceId ? { instanceId } : {}),
        },
      });
      expect(engine.handler.handle(command, store)).toMatchObject({ ok: true });
      selected = "account-b";
      await engine.flush();
    }
    expect(opened).toEqual(["account-a", "account-c"]);
  } finally {
    await engine.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("an SDK delta burst coalesces canonical writes and keeps every chunk", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-burst-"));
  const store = new Store(join(root, "events.sqlite"));
  const registry = new AdapterRegistry();
  let context: SessionContext | undefined;
  let offset = 0;
  const frame = (kind: string, body: unknown) => {
    if (!context) throw new Error("Missing session");
    return deliver(
      context,
      {
        schemaVersion: 1,
        generation: "burst",
        operationId: "burst",
        segment: 0,
        agentId: "native-agent",
        kind,
        body,
      },
      ++offset,
    );
  };
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession(ctx) {
        context = ctx;
        await frame("open", { cwd: root, model: "composer-2.5" });
        return {
          nativeSessionId: "native-agent",
          backend: "cursor-sdk",
          instanceId: "fixture",
          async send(input) {
            await frame("send", { input });
            await frame("segment", { nativeRunId: "run" });
          },
          async interrupt() {},
          async resolve() {},
          async stopTask() {},
          async close() {},
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  const engine = new Engine(store, { registry });
  try {
    const workspaceId = store.createWorkspace(root, "Fixture");
    const command = Command.parse({
      id: "burst",
      deviceId: "fixture",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "cursor",
        input: [{ type: "text", text: "fixture" }],
      },
    });
    const result = engine.handler.handle(command, store);
    if (!result.threadId) throw new Error("Missing thread");
    await engine.flush();
    const afterSeq = store.headSeq();
    const acknowledgements = Array.from({ length: 1000 }, () =>
      frame("delta", { type: "text-delta", text: "x" }),
    );
    await engine.flush();
    await Promise.all(acknowledgements);
    const deltas = store
      .readEvents({ afterSeq, limit: 2000 })
      .filter((event) => event.payload.type === "item.delta");
    expect(deltas.length).toBeLessThan(10);
    const view = store.snapshotThread(result.threadId);
    expect(
      view.itemOrder
        .map((id) => view.items[id])
        .some(
          (item) =>
            item?.type === "message" &&
            item.parts.some((part) => part.type === "text" && part.text === "x".repeat(1000)),
        ),
    ).toBe(true);
  } finally {
    await engine.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
