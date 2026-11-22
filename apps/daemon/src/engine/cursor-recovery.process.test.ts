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
import { isDiskFull } from "../sqlite-failure.ts";

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

const nothing = () => {};
/** The notices a crashed thread shows, as `title: text`. */
const said = (crash: { items: Awaited<ReturnType<typeof crashAt>>["items"] }) =>
  crash.items.flatMap((item) =>
    item.type === "notice" ? [`${item.title ?? ""}: ${item.text ?? ""}`] : [],
  );

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
    /** Whether the previous run's process groups can be proven gone when it's asked. */
    verified?: boolean;
    /** The first opens find Cursor's store busy (another writer holds it). */
    busyOpens?: number;
    /** The engine's waits between busy opens. */
    retryMs?: number[];
    /** Cursor's store has a run for the attempted send (it was created before the crash). */
    attemptAdmitted?: boolean;
    /** The dying host creates the attempted send's run while the process check waits. */
    runAppearsDuringProof?: boolean;
    /** The person presses Resume while the reconcile waits on a busy store. */
    resumeWhileBusy?: boolean;
    /**
     * An earlier build's journal: none of this build's records, and this many newer frames
     * past the attempted send, more than the reopen's window reads.
     */
    legacyFrames?: number;
    /** This many more sends held as uncertain beside the attempted one. */
    moreHeld?: number;
    /** The host reopens without reading back the attempt (a legacy search gave up). */
    noAdmission?: boolean;
    /** The re-sent message never reaches Cursor: the host attempts it and nothing follows. */
    resendStalls?: boolean;
    /**
     * Once the busy opens run out, from the reconcile's own write of the failed turn on, each of
     * the engine's transactions fails with the code this gives (none: it goes through).
     */
    failAfterBusy?: () => string | undefined;
    /** The engine closes while the reconcile waits on a busy store. */
    closeWhileBusy?: boolean;
    /** The new host can't open at all, so Cursor's store can't be read. */
    openFails?: boolean;
    /** Whether the person presses Resume; without it only ace acts. */
    resume?: boolean;
  } = {},
) {
  const { stored = "finished", openFails = false, resume = true, attemptAdmitted = false } = host;
  let busy = host.busyOpens ?? 0;
  let runCreated = false;
  let pressResume = nothing;
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
  // Held by earlier restarts as this one held the attempted send: copies of its row as now.
  let holdMore = () => {
    holdMore = nothing;
    for (let n = 1; n <= (host.moreHeld ?? 0); n++)
      store
        .statement(
          "INSERT INTO intents (command_id, thread_id, kind, payload, status, attempts, error, awaiting, acknowledged, delivery, trigger, position, uncertain) SELECT ?, thread_id, kind, payload, status, attempts, error, awaiting, acknowledged, delivery, trigger, position + ?, uncertain FROM intents WHERE command_id='first-command'",
        )
        .run(`held-${n}`, n);
  };
  if (host.legacyFrames) {
    store
      .statement(
        "DELETE FROM engine_state_records WHERE section IN ('cursorAttempt','cursorFrames','cursorRetired')",
      )
      .run();
    store.atomic(() => {
      const last = Number(
        store.statement("SELECT MAX(seq) AS seq FROM engine_provider_frames").get()?.seq ?? 0,
      );
      const insert = store.statement("INSERT INTO engine_provider_frames VALUES (?,?,?,?)");
      for (let n = 1; n <= (host.legacyFrames ?? 0); n++) {
        const data = {
          schemaVersion: 1,
          generation: "old",
          operationId: "noise",
          segment: 0,
          agentId: "native-agent",
          kind: "host-output",
          body: {},
        };
        insert.run(
          threadId,
          "host",
          last + n,
          JSON.stringify({ seq: last + n, t: n, dir: "recv", channel: "sdk", data }),
        );
      }
    });
  }
  let diskFull = nothing;
  // What the test reads is never refused: only the engine's own writes meet the full disk.
  let reading = false;
  const read = <T>(look: () => T): T => {
    reading = true;
    try {
      return look();
    } finally {
      reading = false;
    }
  };
  if (host.failAfterBusy) {
    const atomic = store.atomic.bind(store);
    const fails = host.failAfterBusy;
    // The session's own open failure writes first; the reconcile's write comes after it.
    let skip = -1;
    diskFull = () => (skip = 1);
    store.atomic = ((run: Parameters<typeof atomic>[0]) => {
      if (skip > 0) skip--;
      else if (skip === 0 && !reading) {
        const code = fails();
        if (code)
          throw Object.assign(
            new Error(code === "SQLITE_FULL" ? "database or disk is full" : "database is locked"),
            { code },
          );
      }
      return atomic(run);
    }) as typeof store.atomic;
  }
  /** The waits the failed turn's write was scheduled on, and running the next one. */
  const failureTimers: { ms: number; run: () => void; cancelled: boolean }[] = [];
  const failureTimer = (run: () => void, ms: number) => {
    const timer = { ms, run, cancelled: false };
    failureTimers.push(timer);
    return () => (timer.cancelled = true);
  };
  const errors: unknown[] = [];
  let closing: Promise<void> | undefined;
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
        holdMore();
        if (openFails) throw new Error("Cursor SDK host could not start");
        if (busy-- > 0) {
          if (host.failAfterBusy && whileBusy.length === (host.retryMs?.length ?? 0)) diskFull();
          if (host.closeWhileBusy && !closing) {
            diskFull();
            // A close that meets the full disk itself is not what this checks.
            closing = engine.close().catch(() => {});
          }
          whileBusy.push(store.getThread(threadId)?.status.state);
          if (host.resumeWhileBusy) pressResume();
          // As the Cursor adapter marks it (store-fence.ts).
          throw Object.assign(new Error("SQLITE_BUSY: database is locked"), {
            code: sessionStoreBusy,
          });
        }
        // The reconcile's read of Cursor's store takes a while: room for a racing open.
        if (host.resumeWhileBusy) await new Promise((settle) => setTimeout(settle, 50));
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
        if (unsettled?.attempt && (attemptAdmitted || runCreated)) {
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
        } else if (unsettled?.attempt && !host.noAdmission)
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
            if (host.resendStalls) return;
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
    cursorFailureTimer: failureTimer,
    onError: (error) => errors.push(error),
    // Whether the last run's process groups are proven gone (by default they are).
    cursorPreviousProcessesGone: async () => {
      if (!host.runAppearsDuringProof) return host.verified ?? true;
      // The old host is still exiting: it makes the run, then its groups are gone.
      await new Promise((settle) => setTimeout(settle, 20));
      runCreated = true;
      return true;
    },
  });
  pressResume = () => {
    pressResume = nothing;
    const accepted = engine.handler.handle(
      Command.parse({
        id: "resume-mid-reconcile",
        deviceId: "device",
        payload: {
          type: "thread.resume",
          threadId,
          expectedRevision: engine.queue(threadId).revision,
        },
      }),
      store,
    );
    if (!accepted.ok) throw new Error(`Resume refused: ${accepted.error}`);
  };
  if (host.closeWhileBusy) {
    // Until the closed engine's reconcile has given up on its write.
    await expect.poll(() => errors.length, { timeout: 4_000 }).toBeGreaterThan(0);
    await closing;
  } else await engine.flush();
  const held = read(() => engine.queue(threadId));
  const runs = read(() =>
    store
      .readEvents({ afterSeq: 0, limit: 1000 })
      .flatMap((event) => (event.payload.type === "run.ended" ? [event.payload.state] : [])),
  );
  const status = read(() => store.getThread(threadId)?.status.state);
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
  const userTexts = read(() =>
    store
      .readItems(threadId, store.headSeq() + 1, 200)
      .items.flatMap((item) =>
        item.type === "message" && item.role === "user"
          ? [item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")]
          : [],
      ),
  );
  return {
    held,
    /** How each ended run ended, and the thread's state, before any Resume. */
    runs,
    status,
    /** The thread's state at the end, after anything above ran. */
    statusAfter: () => read(() => store.getThread(threadId)?.status.state),
    /** How each ended run ended, read now. */
    runsAfter: () =>
      read(() =>
        store
          .readEvents({ afterSeq: 0, limit: 1000 })
          .flatMap((event) => (event.payload.type === "run.ended" ? [event.payload.state] : [])),
      ),
    queueAfter: () => read(() => engine.queue(threadId)),
    failureTimers,
    errors,
    /** Runs the next scheduled try of the failed turn's write; its wait. */
    nextFailureTry() {
      const timer = failureTimers.find((pending) => !pending.cancelled);
      if (!timer) throw new Error("No try of the failed turn's write is scheduled");
      timer.cancelled = true;
      timer.run();
      return timer.ms;
    },
    whileBusy,
    opened,
    sent,
    userTexts,
    items: read(() => store.readItems(threadId, store.headSeq() + 1, 200).items),
    async [Symbol.asyncDispose]() {
      await (host.closeWhileBusy ? engine.close().catch(() => {}) : engine.close());
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
  // Proven absent, sent again, and Cursor had it this time: said so.
  expect(said(crash)).toContain(
    "Sent again: ace restarted before Cursor received this message, so it was sent again",
  );
  expect(crash.statusAfter()).toBe("done");
});

it("a send queued again that Cursor hasn't had yet says it is queued, not that it was sent", async () => {
  await using crash = await crashAt("attempted", { resume: false, resendStalls: true });
  expect(crash.sent.filter((text) => text.endsWith("first"))).toHaveLength(1);
  expect(said(crash)).toContain(
    "Queued to send again: ace restarted before Cursor received this message, so it is queued to send again",
  );
  expect(said(crash).join(" | ")).not.toMatch(/Sent again/);
});

it("a send whose attempt the reopened host couldn't read back says ace couldn't confirm it", async () => {
  await using crash = await crashAt("attempted", { resume: false, noAdmission: true });
  expect(crash.sent).toEqual([]);
  expect(crash.held).toMatchObject({ paused: true, reason: "uncertain" });
  expect(said(crash)).toContain(
    "Delivery unconfirmed: ace couldn't confirm whether Cursor received this message. It is held in the queue: check the conversation before sending it again",
  );
  expect(said(crash).join(" | ")).not.toMatch(/not sent/i);
  expect(crash.statusAfter()).toBe("waiting");
});

it("an earlier build's send past the frames its reopen reads is said unconfirmed, and the thread waits", async () => {
  await using crash = await crashAt("attempted", { resume: false, legacyFrames: 4100 });
  // The reopen read no send, so it had no attempt to ask Cursor about, and no command id.
  expect(crash.opened[0]?.unsettled?.attempt).toBeUndefined();
  expect(crash.sent).toEqual([]);
  expect(crash.held).toMatchObject({ paused: true, reason: "uncertain" });
  expect(said(crash)).toContain(
    "Delivery unconfirmed: ace couldn't confirm whether Cursor received this message. It is held in the queue: check the conversation before sending it again",
  );
  expect(crash.statusAfter()).toBe("waiting");
});

it("every send held as uncertain on an earlier build's thread is said unconfirmed, past any batch", async () => {
  await using crash = await crashAt("attempted", {
    resume: false,
    legacyFrames: 4100,
    moreHeld: 70,
  });
  const unconfirmed = said(crash).filter((text) => text.startsWith("Delivery unconfirmed: "));
  // Past a page of 64: every one of the 71.
  expect(unconfirmed).toHaveLength(71);
  expect(said(crash).join(" | ")).not.toMatch(/not sent/i);
  expect(crash.statusAfter()).toBe("waiting");
});

it("a send stays held as uncertain only when Cursor's store can't be read", async () => {
  await using crash = await crashAt("attempted", { openFails: true, resume: false });
  expect(crash.sent).toEqual([]);
  expect(crash.held).toMatchObject({ paused: true, reason: "uncertain" });
  expect(said(crash).join(" | ")).not.toMatch(/not sent/i);
  expect(said(crash).join(" | ")).toMatch(/couldn't confirm whether Cursor received/);
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

it("a send whose run the dying host made during the process check is acknowledged, never sent again", async () => {
  await using crash = await crashAt("attempted", { runAppearsDuringProof: true, resume: false });
  expect(crash.sent).toEqual([]);
  expect(crash.held).toMatchObject({ paused: false, pendingCount: 0 });
  expect(JSON.stringify(crash.items)).toContain("answered before the crash");
  expect(crash.statusAfter()).toBe("done");
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

it("a Resume pressed while the reconcile waits on a busy store leaves one reconcile and one outcome", async () => {
  await using crash = await crashAt("admitted", {
    stored: "finished",
    resume: false,
    busyOpens: 1,
    retryMs: [40],
    resumeWhileBusy: true,
  });
  // Only the reconcile opens the host: the busy try, then the one that reads the store.
  expect(crash.opened).toHaveLength(2);
  expect(crash.runs).toEqual(["completed"]);
  expect(crash.sent).toEqual([]);
  expect(crash.statusAfter()).toBe("done");
});

it("a failed turn that can't be written while the disk stays full is tried again on a capped backoff until it lands", async () => {
  let full = true;
  await using crash = await crashAt("admitted", {
    resume: false,
    busyOpens: 100,
    retryMs: [10, 10],
    failAfterBusy: () => (full ? "SQLITE_FULL" : undefined),
  });
  // The engine's flush came back with the disk still full: it doesn't wait on the retries.
  expect(full).toBe(true);
  expect(crash.runsAfter()).toEqual([]);
  // Well past 60 s of waits, every try fails and the next is scheduled, never more than 60 s on.
  const waits: number[] = [];
  for (let tries = 0; tries < 12; tries++) waits.push(crash.nextFailureTry());
  expect(waits).toEqual([10, 10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240]);
  for (let tries = 0; tries < 6; tries++) waits.push(crash.nextFailureTry());
  expect(waits.slice(-4)).toEqual([60_000, 60_000, 60_000, 60_000]);
  expect(crash.runsAfter()).toEqual([]);
  expect(crash.queueAfter()).toMatchObject({ paused: true, reason: "restart" });
  // Space comes back: the next try writes it, and nothing more is scheduled.
  full = false;
  crash.nextFailureTry();
  expect(crash.runsAfter()).toEqual(["failed"]);
  expect(crash.statusAfter()).not.toBe("working");
  expect(crash.queueAfter()).toMatchObject({ paused: true, reason: "restart" });
  expect(crash.failureTimers.filter((timer) => !timer.cancelled)).toEqual([]);
  expect(crash.sent).toEqual([]);
});

it("a retry that meets a full disk after a busy one reports the full disk, as the first failure would", async () => {
  let tries = 0;
  await using crash = await crashAt("admitted", {
    resume: false,
    busyOpens: 100,
    retryMs: [10, 10],
    // The reconcile's write and its first rewrite meet a busy store; the first retry, a full disk.
    failAfterBusy: () => {
      const n = tries++;
      return n < 2 ? "SQLITE_BUSY" : n < 3 ? "SQLITE_FULL" : undefined;
    },
  });
  // What the reconcile itself reported was the busy store only.
  expect(crash.errors.some((error) => isDiskFull(error))).toBe(false);
  crash.nextFailureTry();
  crash.nextFailureTry();
  expect(crash.runsAfter()).toEqual(["failed"]);
  // Each failed write reached the engine's error report, the daemon's full-disk path.
  expect(crash.errors.some((error) => isDiskFull(error))).toBe(true);
});

it("a reconcile that fails its write after the engine closed schedules nothing", async () => {
  await using crash = await crashAt("admitted", {
    resume: false,
    busyOpens: 100,
    retryMs: [10, 10],
    failAfterBusy: () => "SQLITE_FULL",
    closeWhileBusy: true,
  });
  expect(crash.errors.length).toBeGreaterThan(0);
  expect(crash.failureTimers).toEqual([]);
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

it("a send Cursor never had stays held for the person while the last run's processes can't be proven gone", async () => {
  await using crash = await crashAt("attempted", { resume: false, verified: false });
  // Cursor's store was read and showed no run for it, but a dying host might still have been
  // making one: it is neither sent again nor dropped.
  expect(crash.opened).toHaveLength(1);
  expect(crash.sent).toEqual([]);
  expect(crash.held).toMatchObject({ paused: true, reason: "uncertain" });
  expect(crash.held.pendingCount).toBeGreaterThan(0);
  expect(crash.statusAfter()).toBe("waiting");
  // Nothing claims it wasn't sent: a resend by hand could be a second copy.
  expect(said(crash).join(" | ")).not.toMatch(/not sent/i);
  expect(said(crash).join(" | ")).toMatch(/couldn't confirm whether Cursor received/);
});
