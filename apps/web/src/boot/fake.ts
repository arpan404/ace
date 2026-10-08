import { seedComputerUse } from "./fake-computer-use.ts";
import {
  FakeDaemon,
  ScenarioPlayer,
  devWorld,
  fakeTransport,
  hostFolders,
  seedPanels,
  turnStatuses,
  workbenchServices,
} from "@ace/fake-daemon";
import type { Client } from "@ace/client";
import type { MachinePool } from "@ace/client-worker/machines";
import { createBrowserClient, memoryStorage } from "./client.ts";
import { fakeMachinePool } from "./fake-machines.ts";
import { fallback, type DaemonConnection } from "./connection.tsx";

const timer = {
  set(delayMs: number, callback: () => void) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/** `bun run --filter @ace/web dev:fake`: the whole app against scripted scenarios in-page. */
export function bootFake(): {
  client: Client;
  daemon: FakeDaemon;
  /** The fake daemon's access routes and devices, for the connection context. */
  connection: DaemonConnection;
  /** The name the design's account disc shows ("AB"), used when this device has none yet. */
  profileName: string;
  /** A second machine, a build server, in the window's machine pool. */
  machines: Promise<MachinePool>;
} {
  const daemon = new FakeDaemon({
    clock: () => Date.now(),
    hostId: "this-mac",
    threadCompletionSchedule: (callback) => void setTimeout(callback, 1200),
    displayName: "This Mac",
    snapshotItems: 40,
    // A clone takes a few seconds, so its progress and Cancel can be seen.
    projectScheduler: (callback) => void setTimeout(callback, 700),
    // `?fakeWorktree=slow` (or `aceFakeWorktree = "slow"`): a new worktree takes a step every
    // 1.5 s, so its card, details and actions can be seen.
    worktreeCreationSlow:
      (globalThis as { aceFakeWorktree?: string }).aceFakeWorktree === "slow" ||
      new URLSearchParams(globalThis.location?.search ?? "").get("fakeWorktree") === "slow",
  });
  // `aceFakeWorld = "empty"` (set before boot, as the screens do) starts on a daemon with no
  // threads and no projects: the first run. `?fakeWorld=thread-activity` adds threads caught
  // mid-work (watching a command, waiting on subagents, running tests, asking) to the world.
  const world =
    (globalThis as { aceFakeWorld?: string }).aceFakeWorld ??
    new URLSearchParams(globalThis.location?.search ?? "").get("fakeWorld");
  const empty = world === "empty";
  if (world === "thread-activity")
    for (const scenario of turnStatuses())
      new ScenarioPlayer(daemon, scenario, { agoMs: 0 }).runUntilBlocked();
  // Every thread is stamped back by its age; live ones keep moving while the app is open.
  for (const thread of empty ? [] : devWorld()) {
    const player = new ScenarioPlayer(daemon, thread.scenario, { agoMs: thread.agoMs });
    if (thread.through) player.runThrough(thread.through);
    else if (!thread.live) player.runUntilBlocked();
    if (thread.live) player.autoplay(timer, thread.live.speed);
  }
  // The folders the Add project dialog browses.
  const host = hostFolders(Date.now());
  daemon.projects.seedFolders(host.home, host.folders);
  // The panels' terminals, browser and dev server, in the daemon's own services.
  if (!empty) seedPanels(daemon);
  // Automations, plugins and linked pull requests, served over the wire like a daemon's.
  if (!empty)
    daemon.seedServices(
      workbenchServices(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone),
    );
  // `aceFakeWorld = "computer-use"` (or `?fakeWorld=computer-use`): agents using apps and the
  // browser on this Mac.
  if (world === "computer-use") seedComputerUse(daemon);
  // Playwright's screens stage failures and empty states before the app's first request.
  const setup = (globalThis as { aceFakeSetup?: (daemon: FakeDaemon) => void }).aceFakeSetup;
  setup?.(daemon);
  const client = createBrowserClient({
    deviceId: "web-fake-device",
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
  });
  // This device last read the five-day migration after checkpoint 20, so opening it shows
  // what happened since (the catch-up card).
  if (!empty) daemon.markReadThrough("thread-multi-day", "answer-20", "web-fake-device");
  // The hero thread was last read before reconnect-audit's finding arrived ("New activity").
  if (!empty && daemon.itemId("thread-dedupe", "relay"))
    daemon.markReadThrough("thread-dedupe", "relay", "web-fake-device");
  // Exposed for poking at fault injection from the console, e.g. ace.daemon.disconnectAll().
  // In Electron `window.ace` is the read-only desktop bridge, so use `aceFake` there.
  Object.assign(globalThis, { ["ace" in globalThis ? "aceFake" : "ace"]: { daemon, client } });
  // A build server with its own folders, so Add project offers a machine picker.
  const server = new FakeDaemon({
    clock: () => Date.now(),
    hostId: "build-server",
    displayName: "Build server",
    projectScheduler: (callback) => void setTimeout(callback, 700),
  });
  server.projects.seedFolders("/home/ci", [
    { path: "/home/ci/services/api", git: true },
    { path: "/home/ci/services/billing-worker", git: true },
    { path: "/home/ci/services/web-gateway", git: true },
    { path: "/home/ci/infra/terraform", git: true },
  ]);
  const machines = fakeMachinePool([server], (other) =>
    createBrowserClient({
      deviceId: "web-fake-device",
      transport: () => fakeTransport(other),
      credential: async () => other.token,
      storage: memoryStorage(),
    }),
  ).then((fake) => fake.pool);
  return {
    client,
    daemon,
    machines,
    connection: fakeConnection(daemon),
    profileName: "Arpan Bhandari",
  };
}

/** The connection dev:fake and tests run on: the fake daemon's access routes and devices. */
export function fakeConnection(daemon: FakeDaemon): DaemonConnection {
  return {
    ...fallback,
    endpoint: {
      kind: "fake",
      access: {
        origin: "http://127.0.0.1:4242/",
        fetch: daemon.access.fetch,
        token: async () => daemon.access.token,
      },
      devices: () => daemon.appDevices.transport(),
      screen: () => daemon.screen.transport(),
    },
  };
}
