import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../store.ts";
import type { OutgoingRecord } from "../outgoing-rows.ts";
import { ThreadOwnership } from "./ownership.ts";
import { LiveSource, type LiveSourcePorts } from "./source.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * A source whose thread has one subagent thread here that keeps writing for `childMs` after it
 * is told to stop. The final payload records whether the child was still running when packed.
 */
async function source(
  childMs: number,
  close: (threadId: string) => Promise<void> = async () => {},
) {
  const root = await mkdtemp(join(tmpdir(), "ace-live-source-"));
  const store = new Store(join(root, "store.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let clock = 0;
  let childStopsAt: number | undefined;
  const closed = new Set<string>();
  const childRunning = () =>
    !closed.has("child") && (childStopsAt === undefined || clock < childStopsAt);
  const packedWhile: boolean[] = [];
  const grandchildAtPack: boolean[] = [];
  const tree = [{ threadId: "child", title: "Write the tests", live: true }];
  const ports: LiveSourcePorts = {
    ownership: new ThreadOwnership(store),
    git: {
      bundleRefs: async () => ({ branches: [], tags: [], originTracking: [] }),
      captureChanges: async () => undefined,
      createBundle: async () => ({ empty: true }),
      pinRef: async () => {},
    } as unknown as LiveSourcePorts["git"],
    archive: {
      packFolder: async () => {
        packedWhile.push(childRunning());
        if (tree.some((entry) => entry.threadId === "grandchild"))
          grandchildAtPack.push(!closed.has("grandchild"));
        return { bytes: 1024, sha256: "a".repeat(64), entries: 0, skipped: 0, files: 0 };
      },
    } as unknown as LiveSourcePorts["archive"],
    session: () => undefined,
    turnFacts: (threadId) => ({
      turnRunning: threadId === "child" ? childRunning() : false,
      toolsRunning: 0,
      streaming: 0,
    }),
    interrupt: () => {},
    stopProvider: async (threadId) => {
      await close(threadId);
      closed.add(threadId);
    },
    shells: () => [],
    terminals: () => [],
    stopTerminals: async () => {},
    descendants: () => tree,
    // The engine's own process set: a thread has one until its provider was closed.
    withProcess: (ids) => ids.filter((id) => !closed.has(id)),
    // Admission returns at once; the child's own turn ends later.
    stopChild: () => {
      childStopsAt = clock + childMs;
    },
    remoteChildren: () => [],
    queued: () => 0,
    hold: () => {},
    moved: () => {},
    released: () => {},
    resume: () => {},
    atomic: (run) => store.atomic(run),
    now: () => clock,
    // A turn of the event loop first, as a real timer gives work already settling.
    sleep: async (ms) => {
      await new Promise((resolve) => setImmediate(resolve));
      clock += ms;
    },
  };
  return {
    live: new LiveSource(ports),
    packedWhile,
    grandchildAtPack,
    tree,
    root,
    closed,
    clock: () => clock,
  };
}

const record = {
  transfer: {
    transferId: "x",
    threadId: "t",
    method: "archive",
    target: { hostId: "studio", name: "Studio" },
  },
  request: { includeChanges: true },
} as unknown as OutgoingRecord;

describe("stopping a working thread's subagents before its final snapshot", () => {
  it("waits for a subagent that keeps writing after it was told to stop", async () => {
    const s = await source(5_000);
    const stopped = await s.live.stop({
      record,
      plan: { source: s.root, name: "app" },
      directory: s.root,
      signal: new AbortController().signal,
      interrupted: () => {},
    });
    expect(s.packedWhile).toEqual([false]);
    expect(s.clock()).toBeGreaterThanOrEqual(5_000);
    expect(stopped.carried.left.children).toEqual(["Write the tests"]);
  });

  it("closes a subagent that never stops within 30 seconds, then takes the snapshot", async () => {
    const s = await source(10 * 60_000);
    await s.live.stop({
      record,
      plan: { source: s.root, name: "app" },
      directory: s.root,
      signal: new AbortController().signal,
      interrupted: () => {},
    });
    expect(s.closed.has("child")).toBe(true);
    expect(s.packedWhile).toEqual([false]);
  });

  it("fails the move, taking no snapshot, when a subagent's process never exits", async () => {
    // Its close never returns: without a bound the move would hang here.
    const s = await source(0, (threadId) =>
      threadId === "child" ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    await expect(
      s.live.stop({
        record,
        plan: { source: s.root, name: "app" },
        directory: s.root,
        signal: new AbortController().signal,
        interrupted: () => {},
      }),
    ).rejects.toMatchObject({ code: "process_still_running" });
    expect(s.packedWhile).toEqual([]);
    expect(s.clock()).toBeLessThanOrEqual(40_000);
  });

  it("waits for a grandchild's process too: the whole tree, not only direct subagents", async () => {
    const s = await source(0);
    // A subagent of the subagent, which ignores the cascading interrupt and keeps writing.
    s.tree.push({ threadId: "grandchild", title: "Fix the flaky test", live: true });
    await s.live.stop({
      record,
      plan: { source: s.root, name: "app" },
      directory: s.root,
      signal: new AbortController().signal,
      interrupted: () => {},
    });
    expect(s.closed.has("grandchild")).toBe(true);
    expect(s.packedWhile).toEqual([false]);
    expect(s.grandchildAtPack).toEqual([false]);
  });

  it("fails the move when a grandchild's process never exits", async () => {
    const s = await source(0, (threadId) =>
      threadId === "grandchild" ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    s.tree.push({ threadId: "grandchild", title: "Fix the flaky test", live: true });
    await expect(
      s.live.stop({
        record,
        plan: { source: s.root, name: "app" },
        directory: s.root,
        signal: new AbortController().signal,
        interrupted: () => {},
      }),
    ).rejects.toMatchObject({
      code: "process_still_running",
      message: expect.stringContaining("Fix the flaky test"),
    });
    expect(s.packedWhile).toEqual([]);
  });
});
