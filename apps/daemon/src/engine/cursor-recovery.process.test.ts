import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import {
  CursorJournal,
  CursorTranslator,
  cursorCapabilities,
  type CursorEnvelope,
} from "@ace/adapter-cursor";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Command, ThreadId } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";

const deliver = (context: SessionContext, value: CursorEnvelope) => {
  const payload = new ProviderPayload(JSON.stringify(value));
  return context.onFrame({
    seq: (value.boundaryOffset ?? 0) * 1024,
    t: 1,
    dir: value.kind === "send" ? "send" : "recv",
    channel: "sdk",
    data: payload.data,
    payload,
  });
};

it("recovers a killed daemon's committed deltas once and holds new input until explicit pinned-checkpoint continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-daemon-recovery-"));
  const path = join(root, "state.sqlite");
  const child = fork(new URL("./cursor-recovery-child.ts", import.meta.url), [path, root], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  let store: Store | undefined;
  let engine: Engine | undefined;
  try {
    const message = once(child, "message");
    const exit = once(child, "exit");
    await Promise.race([
      message,
      exit.then(() => {
        throw new Error("Recovery fixture exited before committing its boundary");
      }),
    ]);
    child.kill("SIGKILL");
    await exit;
    store = new Store(path);
    const before = store.getThread(ThreadId.parse("crashed-thread"));
    expect(before?.status.state).toBe("working");
    const journal = new CursorJournal(root, 65536, 4096);
    const registry = new AdapterRegistry();
    let operation = "open";
    let after = -1;
    registry.register(
      {
        provider: "cursor",
        backend: "cursor-sdk",
        capabilities: () => cursorCapabilities,
        createTranslator: (init) => new CursorTranslator(init),
        async openSession(context) {
          expect(context.resume).toMatchObject({
            nativeSessionId: "native-agent",
            instanceId: "account-a",
            backend: "cursor-sdk",
          });
          after = context.resume?.afterFrameOffset ?? -1;
          await journal.recover(after, async (value) => {
            await deliver(context, value);
          });
          // An intentionally repeated committed delta must not reach core again.
          await deliver(context, {
            schemaVersion: 1,
            generation: "before-crash",
            operationId: "first-command",
            segment: 0,
            boundaryOffset: 3,
            kind: "delta",
            body: { type: "text-delta", text: "before" },
            replayed: true,
          });
          context.onSessionIdentity?.({
            backend: "cursor-sdk",
            instanceId: "account-a",
            nativeSessionId: "native-agent",
          });
          const emit = async (kind: string, body: unknown) =>
            deliver(
              context,
              await journal.append({
                schemaVersion: 1,
                generation: "after-crash",
                operationId: operation,
                segment: 0,
                agentId: "native-agent",
                kind,
                body,
              }),
            );
          await emit("open", { cwd: root, model: "composer-2.5" });
          return {
            nativeSessionId: "native-agent",
            backend: "cursor-sdk",
            instanceId: "account-a",
            async send(input, _delivery, intent) {
              operation = intent ?? "missing-intent";
              await emit("send", { input });
              await emit("delta", { type: "text-delta", text: "before after" });
              await emit("result", { status: "finished" });
            },
            async interrupt() {},
            async resolve() {},
            async stopTask() {},
            async close() {
              await journal.close();
            },
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "offline" },
    );
    engine = new Engine(store, { registry, selectInstance: () => "account-b" });
    // The failed native run is retained while explicit continuation keeps the queue waiting.
    expect(store.getThread(ThreadId.parse("crashed-thread"))?.status.state).toBe("waiting");
    const terminal = store
      .readEvents({ afterSeq: 0, limit: 256 })
      .findLast((event) => event.payload.type === "run.ended")?.payload;
    expect(terminal).toMatchObject({ type: "run.ended", state: "failed" });
    const recoveryNotices = store
      .readItems(ThreadId.parse("crashed-thread"), store.headSeq() + 1, 200)
      .items.filter((item) => item.type === "notice");
    expect(
      recoveryNotices.some(
        (item) => item.type === "notice" && item.text.includes("outcomes remain uncertain"),
      ),
    ).toBe(true);
    const command = Command.parse({
      id: "new-command",
      deviceId: "device",
      payload: {
        type: "thread.send",
        threadId: "crashed-thread",
        delivery: "queue",
        input: [{ type: "text", text: "new input" }],
      },
    });
    expect(engine.handler.handle(command, store)).toMatchObject({ ok: true });
    await engine.flush();
    expect(after).toBe(-1);
    expect(
      engine.queue(
        command.payload.type === "thread.send"
          ? command.payload.threadId
          : ThreadId.parse("crashed-thread"),
      ),
    ).toMatchObject({ paused: true, reason: "restart" });
    const threadId = ThreadId.parse("crashed-thread");
    expect(
      engine.handler.handle(
        Command.parse({
          id: "resume-command",
          deviceId: "device",
          payload: {
            type: "queue.resume",
            threadId,
            expectedRevision: engine.queue(threadId).revision,
          },
        }),
        store,
      ),
    ).toMatchObject({ ok: true });
    await engine.flush();
    expect(after).toBe(3);
    const items = store.readItems(ThreadId.parse("crashed-thread"), store.headSeq() + 1, 200).items;
    const answers = items.filter((item) => item.type === "message" && item.role === "assistant");
    expect(answers).toHaveLength(3);
    expect(answers.map((item) => (item.type === "message" ? item.parts : []))).toEqual([
      [{ type: "text", text: "before after" }],
      [{ type: "text", text: "before after" }],
      [{ type: "text", text: "before after" }],
    ]);
    expect(new Set(answers.map((item) => item.runId)).size).toBe(3);
    expect(store.getThread(ThreadId.parse("crashed-thread"))?.status.state).toBe("done");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await engine?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
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

it("an SDK delta burst coalesces canonical writes while retaining every committed boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-burst-"));
  const store = new Store(join(root, "events.sqlite"));
  const registry = new AdapterRegistry();
  let context: SessionContext | undefined;
  let offset = 0;
  const frame = (kind: string, body: unknown) => {
    if (!context) throw new Error("Missing session");
    return deliver(context, {
      schemaVersion: 1,
      generation: "burst",
      operationId: "burst",
      segment: 0,
      agentId: "native-agent",
      boundaryOffset: ++offset,
      kind,
      body,
    });
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
    // This durable boundary prevents a resumed adapter from replaying acknowledged frames.
    const boundary = store
      .statement("SELECT offset FROM engine_provider_cursors WHERE thread_id=?")
      .get(result.threadId);
    expect(Number(boundary?.offset)).toBe(1002);
  } finally {
    await engine.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
