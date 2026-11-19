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
async function source(childMs: number) {
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
      closed.add(threadId);
    },
    shells: () => [],
    terminals: () => [],
    stopTerminals: async () => {},
    localChildren: () => [{ threadId: "child", title: "Write the tests" }],
    // Admission returns at once; the child's own turn ends later.
    stopChild: () => {
      childStopsAt = clock + childMs;
    },
    remoteChildren: () => [],
    queued: () => 0,
    hold: () => {},
    moved: () => {},
    released: () => {},
    send: () => {},
    atomic: (run) => store.atomic(run),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { live: new LiveSource(ports), packedWhile, root, closed, clock: () => clock };
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
    expect(s.clock()).toBeLessThan(31_000);
  });
});
