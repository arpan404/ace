import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ThreadId,
  WorkspaceId,
  type PortableHandoff,
  type ThreadStatus,
  type TransferLive,
} from "@ace/protocol";
import { Store } from "../../store.ts";
import { ThreadOwnership } from "./ownership.ts";
import { LiveTarget, maxStartAttempts, type LiveTargetPorts } from "./target.ts";
import { LiveStarts } from "./target-rows.ts";

const id = "0b6f7c1e-1d2a-4c3b-8e9f-1a2b3c4d5e6f";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A target with a real store and account home; the thread's status follows `statuses`. */
async function target(statuses: ThreadStatus[], refusals = 0) {
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
  let refused = refusals;
  let clock = 0;
  const ports: LiveTargetPorts = {
    starts: new LiveStarts(store),
    ownership: new ThreadOwnership(store),
    git: { fetchBundle: async () => {}, deleteRef: async () => {} },
    archive: { unpackArchive: async () => ({ entries: 0 }) },
    account: () => ({ instanceId: "claude-cli-default", home }),
    threadCwd: () => "/srv/app",
    // The thread answers each continue message with the next status, and stays there.
    threadStatus: () => statuses[Math.min(sent.length, statuses.length) - 1] ?? { state: "new" },
    adoptSession: (_thread, session) => sessions.push(`adopt:${session.action}`),
    dropSession: () => sessions.push("drop"),
    adoptHandoff: () => sessions.push("handoff"),
    send: (_thread, _key, text) => {
      if (refused > 0) {
        refused--;
        throw new Error("engine full");
      }
      sent.push(text);
    },
    notice: (_thread, text) => notices.push(text),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
  };
  return {
    live: new LiveTarget(ports),
    ports,
    sent,
    sessions,
    notices,
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
    const t = await target([{ state: "working", agents: 1 }]);
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
    const t = await target([{ state: "failed" }, { state: "working", agents: 1 }]);
    const live = carried([await staged(t.folder)]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sessions).toEqual(["adopt:resume", "drop", "handoff"]);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]).toContain("Your conversation came as the summary above");
    expect(t.live.state("x")).toMatchObject({ running: true, session: { kind: "summary" } });
  });

  it("starts from the summary, saying why, when the provider's session couldn't come", async () => {
    const t = await target([{ state: "working", agents: 1 }]);
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
    const t = await target([]);
    const live = carried([await staged(t.folder)]);
    await prep(t, live);
    // The session is placed already: preparing again neither fails nor changes how it came.
    expect(await prep(t, live)).toEqual({
      kind: "native",
    });
    expect((await all(t.live.unfinished())).map((start) => start.transferId)).toEqual(["x"]);
  });

  it("records the thread as this machine's, from the machine it moved from", async () => {
    const t = await target([]);
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
    const t = await target([{ state: "working", agents: 1 }], 2);
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent).toHaveLength(1);
    // Waited 1 s, then 2 s, between the refused attempts.
    expect(t.clock()).toBeGreaterThanOrEqual(3_000);
    expect(t.live.state("x")).toMatchObject({ running: true, attempts: 2 });
  });

  it("gives up after refusals for about half an hour: final, said on the thread, answered to the sender", async () => {
    const t = await target([], maxStartAttempts);
    const live = carried([]);
    await prep(t, live);
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent).toEqual([]);
    expect(t.live.state("x")).toMatchObject({ running: false });
    expect(t.notices[0]).toContain("couldn't start");
    expect(t.live.receipt("x", "macbook-device")).toMatchObject({
      state: "completed",
      live: { running: false },
    });
    expect(await all(t.live.unfinished())).toEqual([]);
  });

  it("answers the sender from its receipt, and only that sender", async () => {
    const t = await target([]);
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
    const t = await target([]);
    const ids = Array.from({ length: 70 }, (_, index) => `x${String(index).padStart(3, "0")}`);
    for (const transferId of ids) await prep(t, carried([]), transferId);
    t.ports.starts.started("x000", true, 1);
    const pending = (await all(t.live.unfinished())).map((start) => start.transferId);
    expect(pending).toEqual(ids.slice(1));
  });
});
