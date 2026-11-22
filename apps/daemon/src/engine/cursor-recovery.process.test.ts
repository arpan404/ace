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
import { sessionStoreBusy } from "@ace/provider-kit/open-error";

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
async function crashAt(
  window: "submitted" | "attempted" | "admitted",
  host: {
    /** What Cursor's store says of the cut-off run. */
    stored?: "finished" | "running";
    /** Startup's proof that the previous run's processes are gone. */
    verified?: boolean;
    /** The first opens find Cursor's store busy (another writer holds it). */
    busyOpens?: number;
    /** The engine's waits between busy opens. */
    retryMs?: number[];
    /** Cursor's store has a run for the attempted send (it was created before the crash). */
    attemptAdmitted?: boolean;
    /** The new host can't open at all, so Cursor's store can't be read. */
    openFails?: boolean;
    /** Whether the person presses Resume; without it only ace acts. */
    resume?: boolean;
  } = {},
) {
  const { stored = "finished", openFails = false, resume = true, attemptAdmitted = false } = host;
  let busy = host.busyOpens ?? 0;
  /** The thread's state each time an open found the store busy. */
  const whileBusy: (string | undefined)[] = [];
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
        if (openFails) throw new Error("Cursor SDK host could not start");
        if (busy-- > 0) {
          whileBusy.push(store.getThread(threadId)?.status.state);
          // As the Cursor adapter marks it (store-fence.ts).
          throw Object.assign(new Error("SQLITE_BUSY: database is locked"), {
            code: sessionStoreBusy,
          });
        }
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
        if (unsettled?.attempt && attemptAdmitted) {
          await emit(
            "admission",
            { ...unsettled.attempt, admitted: true, nativeRunId: "run-1" },
            { runId: "run-1" },
          );
          await emit(
            "recovery",
            { nativeStatus: "finished", interrupted: false, result: "answered before the crash" },
            { runId: "run-1" },
          );
        } else if (unsettled?.attempt)
          await emit("admission", { ...unsettled.attempt, admitted: false });
        for (const run of unsettled?.runs ?? []) {
          // The tail Cursor's store has past the daemon's record: the rest of the answer.
          if (stored === "finished")
            await emit(
              "recovered",
              {
                type: "assistant",
                message: { content: [{ type: "text", text: " finished after the crash" }] },
              },
              { runId: run.runId },
            );
          await emit(
            "recovery",
            stored === "finished"
              ? { nativeStatus: "finished", interrupted: false, result: "finished after the crash" }
              : { nativeStatus: "running", interrupted: true },
            { runId: run.runId },
          );
        }
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
  const engine = new Engine(store, {
    registry,
    selectInstance: () => "account-a",
    ...(host.retryMs ? { cursorReconcileRetryMs: host.retryMs } : {}),
    ...(host.verified === undefined
      ? {}
      : { previousProcessesVerified: Promise.resolve(host.verified) }),
  });
  await engine.flush();
  const held = engine.queue(threadId);
  const runs = store
    .readEvents({ afterSeq: 0, limit: 1000 })
    .flatMap((event) => (event.payload.type === "run.ended" ? [event.payload.state] : []));
  const status = store.getThread(threadId)?.status.state;
  for (const type of resume ? (["queue.resume", "thread.resume"] as const) : []) {
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
    /** How each ended run ended, and the thread's state, before any Resume. */
    runs,
    status,
    whileBusy,
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

it("a run Cursor finished just before the daemon crashed ends finished, with no continuation turn", async () => {
  await using crash = await crashAt("admitted", { stored: "finished", resume: false });
  expect(crash.runs).toEqual(["completed"]);
  expect(crash.status).toBe("done");
  expect(crash.held).toMatchObject({ paused: false, pendingCount: 0 });
  expect(crash.sent).toEqual([]);
  expect(JSON.stringify(crash.items)).toContain("finished after the crash");
});

it("a run the crash really cut off fails and its continuation waits for the person", async () => {
  await using crash = await crashAt("admitted", { stored: "running", resume: false });
  expect(crash.runs).toEqual(["failed"]);
  expect(crash.held).toMatchObject({ paused: true, reason: "restart" });
  expect(crash.sent).toEqual([]);
});

it("a send Cursor never received goes back in the queue by itself and is sent once", async () => {
  await using crash = await crashAt("attempted", { resume: false });
  expect(crash.opened[0]?.unsettled?.attempt).toMatchObject({ operationId: "first-command" });
  expect(crash.sent.filter((text) => text.endsWith("first"))).toHaveLength(1);
  expect(crash.held.reason).not.toBe("uncertain");
  expect(crash.userTexts.filter((text) => text === "first")).toHaveLength(1);
});

it("a send stays held as uncertain only when Cursor's store can't be read", async () => {
  await using crash = await crashAt("attempted", { openFails: true, resume: false });
  expect(crash.sent).toEqual([]);
  expect(crash.held).toMatchObject({ paused: true, reason: "uncertain" });
});

it("a send Cursor had already made a run for is acknowledged on reopen, never held for a resend", async () => {
  await using crash = await crashAt("attempted", { attemptAdmitted: true, resume: false });
  expect(crash.sent).toEqual([]);
  expect(crash.held).toMatchObject({ paused: false, pendingCount: 0 });
  expect(crash.held.reason).not.toBe("uncertain");
  expect(JSON.stringify(crash.items)).toContain("answered before the crash");
  expect(
    crash.items.some((item) => item.type === "notice" && item.code === "delivery_uncertain"),
  ).toBe(false);
});

it("a busy Cursor store at reconcile is tried again, and the thread shows working until it reads", async () => {
  await using crash = await crashAt("admitted", {
    stored: "finished",
    resume: false,
    busyOpens: 2,
    retryMs: [20, 20, 20],
  });
  expect(crash.whileBusy).toEqual(["working", "working"]);
  expect(crash.runs).toEqual(["completed"]);
  expect(crash.status).toBe("done");
});

it("a store still busy when the retries run out fails the turn and keeps what waits in the queue", async () => {
  await using crash = await crashAt("admitted", {
    resume: false,
    busyOpens: 100,
    retryMs: [10, 10],
  });
  expect(crash.whileBusy).toHaveLength(3);
  expect(crash.runs).toEqual(["failed"]);
  expect(crash.held).toMatchObject({ paused: true, reason: "restart" });
  expect(crash.sent).toEqual([]);
});

it("without proof the last run's processes are gone, a send in doubt is never re-queued and Cursor's store is not read", async () => {
  await using crash = await crashAt("attempted", { resume: false, verified: false });
  expect(crash.opened).toEqual([]);
  expect(crash.sent).toEqual([]);
  expect(crash.held).toMatchObject({ paused: true, reason: "uncertain" });
});

it("without that proof a cut-off run fails as a restart fails it instead of reading the store", async () => {
  await using crash = await crashAt("admitted", {
    stored: "finished",
    resume: false,
    verified: false,
  });
  expect(crash.opened).toEqual([]);
  expect(crash.runs).toEqual(["failed"]);
});
