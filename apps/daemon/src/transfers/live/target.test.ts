import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunId,
  ThreadId,
  WorkspaceId,
  type PortableHandoff,
  type ThreadStatus,
  type TransferLive,
} from "@ace/protocol";
import { Store } from "../../store.ts";
import { ThreadOwnership } from "./ownership.ts";
import { LiveTarget, maxStartAttempts, uncertainMs, type LiveTargetPorts } from "./target.ts";
import type { ContinueFacts } from "./turn-start.ts";
import { LiveStarts } from "./target-rows.ts";

const id = "0b6f7c1e-1d2a-4c3b-8e9f-1a2b3c4d5e6f";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const runId = RunId.parse("run-1");
/** The one continue message's command key for transfer `x`, first attempt. */
const continueKey = "transfer-live:x:continue:0";

/**
 * A target with a real store and account home. Each continue message has its own fate, by its
 * command id: delivered once sent, unless `held` (the carried session fails to open, so the
 * first one is held unsent) or `fateAt` says otherwise. A retry of a held message dispatches it
 * unless `retryDispatches` is false.
 */
async function target(
  refusals = 0,
  options: {
    refusal?: string;
    held?: boolean;
    retryDispatches?: boolean;
    fateAt?: (clock: number, key: string) => ContinueFacts | undefined;
    /** The thread's status, which a turn the person starts there changes. */
    status?: ThreadStatus;
    /** Called after each wait, with the time it reached. */
    onSleep?: (clock: number) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ace-live-target-"));
  const store = new Store(join(root, "store.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "claude-home");
  const folder = join(root, "final");
  await mkdir(home);
  const sent: string[] = [];
  const sessions: string[] = [];
  const notices: string[] = [];
  const retried: string[] = [];
  const inputs = new Map<string, ContinueFacts>();
  let refused = refusals;
  let clock = 0;
  const ports: LiveTargetPorts = {
    starts: new LiveStarts(store),
    ownership: new ThreadOwnership(store),
    git: { fetchBundle: async () => {}, deleteRef: async () => {} },
    archive: { unpackArchive: async () => ({ entries: 0 }) },
    account: () => ({ instanceId: "claude-cli-default", home }),
    threadCwd: () => "/srv/app",
    threadStatus: () => options.status ?? { state: "new" },
    continueFate: (_thread, key) =>
      options.fateAt?.(clock, key) ??
      inputs.get(key) ?? { fate: { state: "unknown" }, held: false },
    adoptSession: (_thread, session) => sessions.push(`adopt:${session.action}`),
    dropSession: () => sessions.push("drop"),
    adoptHandoff: () => sessions.push("handoff"),
    send: (_thread, key, text) => {
      if (refused > 0) {
        refused--;
        throw new Error(options.refusal ?? "engine_capacity_exceeded");
      }
      sent.push(text);
      const held = options.held && inputs.size === 0;
      inputs.set(
        key,
        held
          ? { fate: { state: "waiting" }, held: true }
          : { fate: { state: "delivered", runId }, held: false },
      );
    },
    retryHeld: (_thread, key) => {
      retried.push(key);
      if (options.retryDispatches === false) return;
      for (const [input, facts] of inputs)
        if (facts.held) inputs.set(input, { fate: { state: "delivered", runId }, held: false });
    },
    atomic: (run) => store.atomic(run),
    notice: (_thread, text) => notices.push(text),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      // A watch that never ends fails the test instead of hanging it.
      if (clock > 48 * 60 * 60_000) throw new Error("the start never ended");
      options.onSleep?.(clock);
    },
    log: () => {},
  };
  return {
    live: new LiveTarget(ports),
    ports,
    sent,
    sessions,
    notices,
    retried,
    home,
    folder,
    store,
    clock: () => clock,
  };
}

const carried = (files: string[]): TransferLive => ({
  epoch: 1,
  sourceThreadId: "t-source" as TransferLive["sourceThreadId"],
  left: { shells: [], children: [], remoteChildren: [], queued: 0 },
  session: { provider: "claude", nativeSessionId: id, sourceCwd: "/Users/me/app", files },
});

async function staged(folder: string) {
  const relative = `projects/-Users-me-app/${id}.jsonl`;
  const path = join(folder, "session", relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "user", cwd: "/Users/me/app" })}\n`);
  return relative;
}

const handoff = {} as PortableHandoff;

type Target = Awaited<ReturnType<typeof target>>;
const result = {
  workspaceId: WorkspaceId.parse("w"),
  path: "/srv/app",
  threadId: ThreadId.parse("n"),
};
const prep = (t: Target, live: TransferLive, transferId = "x") =>
  t.live.prepare({
    transferId,
    deviceId: "macbook-device",
    method: "remote",
    threadId: "n",
    result,
    live,
    folder: t.folder,
  });
async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe("a moved thread starting on this machine", () => {
  it("continues the carried session, tells the agent it moved, and records that it runs", async () => {
    const t = await target();
    const live = carried([await staged(t.folder)]);
    const outcome = await prep(t, live);
    expect(outcome).toEqual({ kind: "native" });
    expect(
      JSON.parse(await readFile(join(t.home, "projects", "-srv-app", `${id}.jsonl`), "utf8")).cwd,
    ).toBe("/srv/app");
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain("Your full conversation came with it.");
    expect(t.live.state("x")).toMatchObject({ running: true, session: { kind: "native" } });
  });

  it("falls back to the summary once when the carried session fails to open", async () => {
    const t = await target(0, { held: true });
    const live = carried([await staged(t.folder)]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sessions).toEqual(["adopt:resume", "drop", "handoff"]);
    // Still one continue message: the one the failed open held unsent goes again.
    expect(t.sent).toHaveLength(1);
    expect(t.retried).toHaveLength(1);
    expect(t.live.state("x")).toMatchObject({ running: true, session: { kind: "summary" } });
  });

  it("records no start while the held message, retried, still isn't sent", async () => {
    // The retry is asked for but never dispatches the held message.
    const t = await target(0, { held: true, retryDispatches: false });
    const live = carried([await staged(t.folder)]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.retried).toHaveLength(1);
    expect(t.live.state("x")).toMatchObject({ running: false });
    expect(t.notices[0]).toContain("its first turn didn't start here");
  });

  it("waits for the continue message itself, not a turn the person started there", async () => {
    // The person's own message (another command id) runs at once; the continue message waits
    // ten minutes. Read by any other id, the start would be recorded at once.
    const t = await target(0, {
      status: { state: "working", agents: 1 },
      fateAt: (clock, key) =>
        key !== continueKey
          ? { fate: { state: "delivered", runId }, held: false }
          : clock < 10 * 60_000
            ? { fate: { state: "waiting" }, held: false }
            : { fate: { state: "delivered", runId }, held: false },
    });
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.clock()).toBeGreaterThanOrEqual(10 * 60_000);
    expect(t.live.state("x")).toMatchObject({ running: true });
  });

  it.each([
    ["stopped the thread", { fate: { state: "waiting" }, held: false, stopped: true }, "stopped"],
    ["took the message out", { fate: { state: "removed" }, held: false }, "took the message out"],
    ["sent it again", { fate: { state: "replaced", by: "c-2" }, held: false }, "sent the message"],
    [
      "stopped it once it was written",
      { fate: { state: "failed", error: "Cancelled before delivery" }, held: false },
      "stopped",
    ],
  ] as const)(
    "completes as not started when the person %s before it ran",
    async (_what, facts, reason) => {
      const t = await target(0, {
        fateAt: (_clock, key) => (key === continueKey ? (facts as ContinueFacts) : undefined),
      });
      const live = carried([]);
      await prep(t, live);
      await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
      expect(t.live.state("x")).toMatchObject({ running: false });
      expect(t.live.receipt("x", "macbook-device")).toMatchObject({
        state: "completed",
        live: { running: false },
      });
      expect(t.ports.starts.get("x")?.failure).toContain(reason);
      // The person's own act shows on the thread; no notice asks them to carry on.
      expect(t.notices).toEqual([]);
    },
  );

  it("keeps reading a continue message it can't place, then gives up on it, bounded", async () => {
    const t = await target(0, {
      fateAt: () => ({ fate: { state: "uncertain" }, held: false }),
    });
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    // Given up on at its bound, not before and not long after.
    expect(t.clock()).toBeGreaterThanOrEqual(uncertainMs);
    expect(t.clock()).toBeLessThanOrEqual(uncertainMs + 1_000);
    expect(t.live.state("x")).toMatchObject({ running: false });
    expect(t.notices[0]).toContain("may not have reached the agent");
  });

  it("keeps the uncertainty deadline across a restart", async () => {
    let first: LiveTarget | undefined;
    const t = await target(0, {
      fateAt: () => ({ fate: { state: "uncertain" }, held: false }),
      // The daemon restarts six minutes into the uncertainty.
      onSleep: (clock) => {
        if (clock >= 6 * 60_000) first?.close();
      },
    });
    first = t.live;
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.live.state("x")?.running).toBeUndefined();
    const restarted = new LiveTarget(t.ports);
    await restarted.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    // Ten minutes from when it first read uncertain, not from the restart.
    expect(t.clock()).toBeLessThanOrEqual(uncertainMs + 1_000);
    expect(restarted.state("x")).toMatchObject({ running: false });
  });

  it("records the start once an uncertain continue message turns out to have run", async () => {
    const t = await target(0, {
      fateAt: (clock) =>
        clock < 60_000
          ? { fate: { state: "uncertain" }, held: false }
          : { fate: { state: "delivered", runId }, held: false },
    });
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.live.state("x")).toMatchObject({ running: true });
  });

  it("starts from the summary, saying why, when the provider's session couldn't come", async () => {
    const t = await target();
    const live: TransferLive = {
      ...carried([]),
      session: undefined,
      unsupported: "pi sessions aren't carried yet",
    };
    expect(await prep(t, live)).toEqual({
      kind: "summary",
      reason: "pi sessions aren't carried yet",
    });
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent[0]).toContain("(pi sessions aren't carried yet)");
  });

  it("keeps the same outcome when a restart prepares it again", async () => {
    const t = await target();
    const live = carried([await staged(t.folder)]);
    await prep(t, live);
    // The session is placed already: preparing again neither fails nor changes how it came.
    expect(await prep(t, live)).toEqual({
      kind: "native",
    });
    expect((await all(t.live.unfinished())).map((start) => start.transferId)).toEqual(["x"]);
  });

  it("records the thread as this machine's, from the machine it moved from", async () => {
    const t = await target();
    t.live.own({
      transferId: "x",
      threadId: "n",
      live: carried([]),
      from: { hostId: "macbook", name: "MacBook" },
    });
    expect(new ThreadOwnership(t.store).get("n")).toMatchObject({
      state: "owned",
      epoch: 1,
      peer: { hostId: "macbook", threadId: "t-source" },
    });
  });

  it("tries again when this machine refuses the continue message for now, keeping the backoff", async () => {
    const t = await target(2);
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent).toHaveLength(1);
    // Waited 1 s, then 2 s, between the refused attempts.
    expect(t.clock()).toBeGreaterThanOrEqual(3_000);
    expect(t.live.state("x")).toMatchObject({ running: true, attempts: 2 });
  });

  it("gives up after refusals for about half an hour: final, said on the thread, answered to the sender", async () => {
    const t = await target(maxStartAttempts);
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent).toEqual([]);
    expect(t.live.state("x")).toMatchObject({ running: false });
    expect(t.notices[0]).toContain("kept refusing it");
    expect(t.live.receipt("x", "macbook-device")).toMatchObject({
      state: "completed",
      live: { running: false },
    });
    expect(await all(t.live.unfinished())).toEqual([]);
  });

  it("answers the sender from its receipt, and only that sender", async () => {
    const t = await target();
    await prep(t, carried([]));
    expect(t.live.receipt("x", "macbook-device")).toMatchObject({
      state: "importing",
      method: "remote",
      result: { threadId: "n" },
    });
    expect(t.live.receipt("x", "someone-else")).toBeUndefined();
    expect(t.live.receipt("unknown", "macbook-device")).toBeUndefined();
  });

  it("finds every start a restart left unfinished, past one batch, and none that finished", async () => {
    const t = await target();
    const ids = Array.from({ length: 70 }, (_, index) => `x${String(index).padStart(3, "0")}`);
    for (const transferId of ids) await prep(t, carried([]), transferId);
    t.ports.starts.started("x000", true, 1);
    const pending = (await all(t.live.unfinished())).map((start) => start.transferId);
    expect(pending).toEqual(ids.slice(1));
  });

  it("sends no second continue message however long the first waits in the queue", async () => {
    // Queued behind other work there for an hour before its turn starts.
    const t = await target(0, {
      fateAt: (clock) =>
        clock < 60 * 60_000
          ? { fate: { state: "waiting" }, held: false }
          : { fate: { state: "delivered", runId }, held: false },
    });
    const live = carried([await staged(t.folder)]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent).toHaveLength(1);
    expect(t.retried).toEqual([]);
    expect(t.live.state("x")).toMatchObject({ running: true, session: { kind: "native" } });
  });

  it("ends the start at once on a refusal that won't pass, with no retries", async () => {
    const t = await target(1, { refusal: "thread_not_found" });
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent).toEqual([]);
    expect(t.live.state("x")).toMatchObject({ running: false, attempts: 0 });
    expect(t.notices[0]).toContain("refused it (thread_not_found)");
  });
});
