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
    unconfirmedExits: () => [],
    holdTerminals: () => () => undefined,
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

it("fails before the hand-over when a provider never confirmed its close", async () => {
  let checks = 0;
  const { stop, ownership } = await source({
    // The Stop's close gives up waiting on the second look; status reads the tree stopped and
    // every shell ended (`unknown`), but the old process may still run.
    unconfirmedExits: () => (++checks >= 2 ? ["Write the tests"] : []),
    remoteChildren: () => ({ running: checks < 2 ? ["reviewer"] : [], unconfirmed: [] }),
  });
  await expect(stop()).rejects.toMatchObject({ code: "process_unconfirmed" });
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

/**
 * The tree's terminals as the workspace keeps them: an open is refused while the move holds
 * them (`holdOpens`; false is a restart that lost the hold), and stopping ends every open one.
 */
function terminalWorld(holdOpens = true) {
  const open: string[] = [];
  let held = false;
  return {
    open,
    tryOpen(name: string) {
      if (held) return "thread_moving";
      open.push(name);
      return "opened";
    },
    ports: {
      holdTerminals: () => {
        held = holdOpens;
        return () => {
          held = false;
        };
      },
      terminals: () => [...open],
      stopTerminals: async () => {
        open.length = 0;
      },
    } satisfies Partial<LiveSourcePorts>,
  };
}

it("refuses a terminal opened while the move waits on a child elsewhere", async () => {
  const world = terminalWorld();
  let checks = 0;
  let opened: string | undefined;
  const { stop, ownership } = await source({
    ...world.ports,
    remoteChildren: () => {
      // While the child there is still stopping, the person opens a terminal.
      if (++checks === 2) opened = world.tryOpen("dev server");
      return { running: checks < 4 ? ["reviewer"] : [], unconfirmed: [] };
    },
  });
  await stop();
  expect(opened).toBe("thread_moving");
  expect(world.open).toEqual([]);
  expect(ownership.get("t-1")?.state).toBe("stopping");
  // The hold on opens lifts with the stop: the ownership record holds the thread from here.
  expect(world.tryOpen("after")).toBe("opened");
});

it("stops a terminal still open at the safe point before it holds the thread", async () => {
  // After a restart, the stop runs again; a terminal opened meanwhile was never held.
  const world = terminalWorld(false);
  let checks = 0;
  let openAtHold: string[] | undefined;
  const { stop, ownership } = await source({
    ...world.ports,
    remoteChildren: () => {
      if (++checks === 2) world.tryOpen("dev server");
      return { running: checks < 3 ? ["reviewer"] : [], unconfirmed: [] };
    },
    // The final payload is packed after the hold: what was open then.
    archive: {
      packFolder: async () => {
        openAtHold = [...world.open];
        return { bytes: 1, sha256: "0".repeat(64), entries: 0, skipped: 0, files: 0 };
      },
    },
  });
  await stop();
  expect(ownership.get("t-1")?.state).toBe("stopping");
  expect(openAtHold).toEqual([]);
});
