import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PortableHandoff, ThreadStatus, TransferLive } from "@ace/protocol";
import { Store } from "../../store.ts";
import { ThreadOwnership } from "./ownership.ts";
import { LiveTarget, type LiveTargetPorts } from "./target.ts";
import { LiveStarts } from "./target-rows.ts";

const id = "0b6f7c1e-1d2a-4c3b-8e9f-1a2b3c4d5e6f";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A target with a real store and account home; the thread's status follows `statuses`. */
async function target(statuses: ThreadStatus[]) {
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
  let clock = 0;
  const ports: LiveTargetPorts = {
    starts: new LiveStarts(store),
    ownership: new ThreadOwnership(store),
    git: { fetchBundle: async () => {}, deleteRef: async () => {} },
    archive: { unpackArchive: async () => ({ entries: 0 }) },
    account: () => ({ instanceId: "claude-cli-default", home }),
    threadCwd: () => "/srv/app",
    threadStatus: () => (sent.length ? (statuses.shift() ?? { state: "new" }) : { state: "new" }),
    adoptSession: (_thread, session) => sessions.push(`adopt:${session.action}`),
    dropSession: () => sessions.push("drop"),
    adoptHandoff: () => sessions.push("handoff"),
    send: (_thread, _key, text) => sent.push(text),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
  };
  return { live: new LiveTarget(ports), sent, sessions, home, folder, store };
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

describe("a moved thread starting on this machine", () => {
  it("continues the carried session, tells the agent it moved, and records that it runs", async () => {
    const t = await target([{ state: "working", agents: 1 }]);
    const live = carried([await staged(t.folder)]);
    const outcome = await t.live.prepare({
      transferId: "x",
      threadId: "n",
      live,
      folder: t.folder,
    });
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
    await t.live.prepare({ transferId: "x", threadId: "n", live, folder: t.folder });
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
    expect(
      await t.live.prepare({ transferId: "x", threadId: "n", live, folder: t.folder }),
    ).toEqual({
      kind: "summary",
      reason: "pi sessions aren't carried yet",
    });
    await t.live.start({ transferId: "x", live, from: "MacBook", path: "/srv/app", handoff });
    expect(t.sent[0]).toContain("(pi sessions aren't carried yet)");
  });

  it("keeps the same outcome when a restart prepares it again", async () => {
    const t = await target([]);
    const live = carried([await staged(t.folder)]);
    await t.live.prepare({ transferId: "x", threadId: "n", live, folder: t.folder });
    // The session is placed already: preparing again neither fails nor changes how it came.
    expect(
      await t.live.prepare({ transferId: "x", threadId: "n", live, folder: t.folder }),
    ).toEqual({
      kind: "native",
    });
    expect(t.live.unfinished().map((start) => start.transferId)).toEqual(["x"]);
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
});
