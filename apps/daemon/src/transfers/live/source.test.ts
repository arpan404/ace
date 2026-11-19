import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CommandId, HostId, ThreadId, WorkspaceId } from "@ace/protocol";
import { Store } from "../../store.ts";
import type { OutgoingRecord } from "../outgoing-rows.ts";
import { ThreadOwnership } from "./ownership.ts";
import { LiveSource, type LiveSourcePorts } from "./source.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const record: OutgoingRecord = {
  transfer: {
    transferId: "move",
    commandId: "c-move" as CommandId,
    kind: "thread",
    threadId: "t-1" as ThreadId,
    workspaceId: "w" as WorkspaceId,
    target: { hostId: "studio" as HostId, name: "Studio" },
    phase: "sending",
    method: "archive",
    sentBytes: 0,
    startedAt: 5_000,
    updatedAt: 5_000,
  },
  request: {
    hostId: "studio" as HostId,
    profile: "studio",
    includeChanges: true,
    includeIgnored: false,
    live: true,
  },
  delivered: true,
};

const unused = async (): Promise<never> => {
  throw new Error("Git is never read in an archive move");
};

/** A source whose tree is at rest once stopped; `over` says what else still runs. */
async function source(over: Partial<LiveSourcePorts>) {
  const root = await mkdtemp(join(tmpdir(), "ace-live-source-"));
  const store = new Store(join(root, "store.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const ownership = new ThreadOwnership(store);
  const clock = { now: 10_000 };
  const ports: LiveSourcePorts = {
    ownership,
    // An archive move: the checkout's Git is never read.
    git: {
      bundleRefs: unused,
      captureChanges: unused,
      createBundle: unused,
      pinRef: unused,
    },
    archive: {
      packFolder: async () => ({
        bytes: 1,
        sha256: "0".repeat(64),
        entries: 0,
        skipped: 0,
        files: 0,
      }),
    },
    session: () => undefined,
    stop: () => undefined,
    atRest: () => true,
    shells: () => [],
    terminals: () => [],
    stopTerminals: async () => undefined,
    children: () => [],
    remoteChildren: () => ({ running: [], unconfirmed: [] }),
    queued: () => 0,
    hold: () => undefined,
    moved: () => undefined,
    released: () => undefined,
    resume: () => undefined,
    atomic: (run) => run(),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    ...over,
  };
  const stop = () =>
    new LiveSource(ports).stop({
      record,
      plan: { source: root, name: "app" },
      directory: root,
      signal: new AbortController().signal,
      interrupted: () => undefined,
    });
  return { stop, ownership };
}

it("waits for a build the finished turn left running to end before it holds the thread", async () => {
  let checks = 0;
  const { stop, ownership } = await source({
    // The thread reads done throughout; the build ends on the third look.
    shells: () => (++checks < 3 ? ["npm run build"] : []),
  });
  await stop();
  expect(checks).toBeGreaterThanOrEqual(3);
  expect(ownership.get("t-1")?.state).toBe("stopping");
});

it("fails before the hand-over when a background process never stops", async () => {
  const { stop, ownership } = await source({ shells: () => ["npm run build"] });
  await expect(stop()).rejects.toMatchObject({ code: "process_still_running" });
  expect(ownership.get("t-1")).toBeUndefined();
});

it("fails before the hand-over when a child on another machine never confirmed its stop", async () => {
  const { stop, ownership } = await source({
    // Ordinary status reads it stopped (ADR 0052); its machine never answered.
    remoteChildren: () => ({ running: [], unconfirmed: ["reviewer"] }),
  });
  await expect(stop()).rejects.toMatchObject({ code: "remote_child_unconfirmed" });
  expect(ownership.get("t-1")).toBeUndefined();
});

it("waits for a child on another machine to confirm its stop", async () => {
  let checks = 0;
  const { stop, ownership } = await source({
    remoteChildren: () => ({ running: ++checks < 3 ? ["reviewer"] : [], unconfirmed: [] }),
  });
  await stop();
  expect(checks).toBeGreaterThanOrEqual(3);
  expect(ownership.get("t-1")?.state).toBe("stopping");
});
