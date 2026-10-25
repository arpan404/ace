import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { expect, it } from "vitest";
import { WorkTally } from "../link/thread-watch.ts";
import { appLifetime, type LifetimeFacts } from "./lifetime.ts";

const idle = { needsYou: 0, working: 0 };

const closed: LifetimeFacts = {
  platform: "win32",
  background: false,
  window: false,
  browserPages: 0,
  work: idle,
};

const entry = (status: ThreadStatus) =>
  ThreadListEntry.parse({
    id: "a",
    workspaceId: "ace",
    title: "Thread a",
    provider: "codex",
    createdAt: 0,
    updatedAt: 1,
    status,
  });

it("on Windows and Linux the app quits when its last window closes with nothing running", () => {
  expect(appLifetime(closed)).toEqual({ quit: true, tray: false });
  expect(appLifetime({ ...closed, platform: "linux" }).quit).toBe(true);
});

it("a thread's browser page keeps the app running in the tray after its last window closes", () => {
  expect(appLifetime({ ...closed, browserPages: 1 })).toEqual({ quit: false, tray: true });
});

it("a working agent keeps the app running in the tray after its last window closes", () => {
  expect(appLifetime({ ...closed, platform: "linux", work: { ...idle, working: 2 } })).toEqual({
    quit: false,
    tray: true,
  });
});

it("a thread waiting on an approval keeps a windowless app running in the tray", () => {
  for (const platform of ["linux", "win32"] as const)
    expect(appLifetime({ ...closed, platform, work: { ...idle, needsYou: 1 } })).toEqual({
      quit: false,
      tray: true,
    });
});

it("once the last page closes and no agent works, a windowless app quits", () => {
  const busy = { ...closed, browserPages: 1, work: { ...idle, working: 1 } };
  expect(appLifetime(busy).quit).toBe(false);
  expect(appLifetime({ ...busy, browserPages: 0 }).quit).toBe(false);
  expect(appLifetime({ ...busy, browserPages: 0, work: idle }).quit).toBe(true);
});

it("the last working thread asking for approval keeps the app; answering and finishing quits it", () => {
  // The same path Background takes: thread updates tally into the summary it decides on.
  const tally = new WorkTally();
  const lifetime = () => appLifetime({ ...closed, platform: "linux", work: tally.summary() });
  tally.set("a", entry({ state: "working", agents: 1 }));
  expect(lifetime().quit).toBe(false);
  tally.set("a", entry({ state: "needs_you", interactions: 1 }));
  expect(lifetime()).toEqual({ quit: false, tray: true });
  tally.set("a", entry({ state: "working", agents: 1 }));
  expect(lifetime().quit).toBe(false);
  tally.set("a", entry({ state: "done" }));
  expect(lifetime()).toEqual({ quit: true, tray: false });
});

it("the background setting keeps the app and its tray whatever runs", () => {
  expect(appLifetime({ ...closed, background: true })).toEqual({ quit: false, tray: true });
  expect(appLifetime({ ...closed, window: true, background: true }).tray).toBe(true);
});

it("macOS keeps the app open without windows and shows the tray only by setting", () => {
  expect(appLifetime({ ...closed, platform: "darwin" })).toEqual({ quit: false, tray: false });
  expect(appLifetime({ ...closed, platform: "darwin", browserPages: 3 }).tray).toBe(false);
  expect(
    appLifetime({ ...closed, platform: "darwin", work: { needsYou: 2, working: 1 } }),
  ).toEqual({ quit: false, tray: false });
});

it("with a window open the app never quits on its own", () => {
  expect(appLifetime({ ...closed, window: true })).toEqual({ quit: false, tray: false });
});
