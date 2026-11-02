import { seedComputerUse } from "./fake-computer-use.ts";
import { seedFakeSkills } from "./fake-skills.ts";
import {
  FakeDaemon,
  ScenarioPlayer,
  buildServerChats,
  crossDevice,
  streamingReply,
  delegatedQuestion,
  devWorld,
  showcaseWorld,
  fakeTransport,
  hostFolders,
  refusedDelegation,
  seedInterruptedTurn,
  seedTurnEndings,
  seedLeftRunning,
  seedSettledHeld,
  seedPanels,
  seedRealCatalogs,
  seedRealThreadState,
  seedColdStartState,
  turnStatuses,
  rowStates,
  failedJustNow,
  oneTurnWork,
  workbenchServices,
  seedForgeBrowse,
  seedLongLists,
  withLongAutomations,
} from "@ace/fake-daemon";
import type { Client } from "@ace/client";
import type { MachinePool } from "@ace/client-worker/machines";
import { createBrowserClient, memoryStorage } from "./client.ts";
import { fakeMachinePool } from "./fake-machines.ts";
import { installFakeVideoDecoder } from "./fake-video.ts";
import { seedBuildServerUsage, seedLimitReadings } from "./fake-usage.ts";
import { fallback, type DaemonConnection } from "./connection.tsx";
import { withFakeMachineAccount } from "./fake-account.ts";

const timer = {
  set(delayMs: number, callback: () => void) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/**
 * `origin` remotes for This Mac's checkouts. The build server has its own copy of relay (under
 * another folder name) but not billing-api, so moving New thread there shows both outcomes.
 */
const origins: Record<string, string> = {
  "/Users/dev/relay": "git@github.com:acme/relay.git",
  "/Users/dev/billing-api": "https://github.com/acme/billing-api.git",
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
  // The fake browser's live view is video of SVG pictures: decode them as the real stream is.
  installFakeVideoDecoder();
  const daemon = new FakeDaemon({
    clock: () => Date.now(),
    // Its first start: the world it boots with is history, what happens after is news.
    seenBefore: Date.now(),
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
  // threads and no projects: the first run. `?fakeWorld=showcase` is the small, tidy world the
  // marketing screenshots are taken in. `?fakeWorld=thread-activity` adds threads caught
  // mid-work (watching a command, waiting on subagents, running tests, asking) to the world;
  // `?fakeWorld=row-states` adds one thread for each thread-row status.
  const world =
    (globalThis as { aceFakeWorld?: string }).aceFakeWorld ??
    new URLSearchParams(globalThis.location?.search ?? "").get("fakeWorld");
  const empty = world === "empty";
  if (world === "real-thread-state") seedRealThreadState(daemon);
  // `?fakeWorld=settled-held`: the dev world plus settled threads held at a usage limit or with
  // a command left running: they stay in Settled.
  if (world === "settled-held") seedSettledHeld(daemon, Date.now());
  if (world === "thread-activity")
    for (const scenario of turnStatuses())
      new ScenarioPlayer(daemon, scenario, { agoMs: 0 }).runUntilBlocked();
  // `?fakeWorld=row-states`: every thread-row status at once (waiting on three agents, a
  // background command, a test run, a fresh failure) beside the dev world's own.
  if (world === "row-states") {
    for (const scenario of rowStates())
      new ScenarioPlayer(daemon, scenario, { agoMs: 0 }).runUntilBlocked();
    // After the client's first launch, so the failure and the finished turn are news rather
    // than history.
    setTimeout(() => {
      for (const scenario of [failedJustNow(), oneTurnWork("thread-finished-now")])
        new ScenarioPlayer(daemon, scenario, { agoMs: 0 }).runUntilBlocked();
    }, 5_000);
  }
  // Every thread is stamped back by its age; live ones keep moving while the app is open.
  for (const thread of empty || ["real-thread-state", "cold-start-state"].includes(world ?? "")
    ? []
    : world === "showcase"
      ? showcaseWorld()
      : devWorld()) {
    const player = new ScenarioPlayer(daemon, thread.scenario, { agoMs: thread.agoMs });
    if (thread.through) player.runThrough(thread.through);
    else if (!thread.live) player.runUntilBlocked();
    if (thread.live) player.autoplay(timer, thread.live.speed);
  }
  // The folders the Add project dialog browses.
  const host = hostFolders(Date.now());
  for (const folder of host.folders) {
    const remote = origins[folder.path];
    if (remote) folder.remote = remote;
  }
  daemon.projects.seedFolders(host.home, host.folders);
  // The panels' terminals, browser and dev server, in the daemon's own services.
  if (!empty) seedPanels(daemon);
  // Automations, plugins and linked pull requests, served over the wire like a daemon's.
  // `?fakeLists=2000`: that many pull requests, issues, notifications, automations, skills and
  // settled threads (as many as the wire carries), for measuring the long lists.
  const longLists = Number(new URLSearchParams(globalThis.location?.search ?? "").get("fakeLists"));
  if (!empty) {
    const services = workbenchServices(
      Date.now(),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    daemon.seedServices(longLists > 0 ? withLongAutomations(services, longLists) : services);
    // The PR panel's three looks (ready, failing with changes requested, merged) and the
    // Pull requests view's lists.
    seedForgeBrowse(daemon, Date.now());
    seedFakeSkills(daemon, Date.now());
    if (longLists > 0) seedLongLists(daemon, Date.now(), longLists);
    // From the console, `acePushPullRequest(31)` pushes to a sample PR's branch: a new head
    // with its lines moved, for trying what survives a push.
    (globalThis as { acePushPullRequest?: (number: number) => boolean }).acePushPullRequest = (
      number,
    ) => daemon.workspace.pushPullRequest(number);
  }
  // `aceFakeWorld = "computer-use"` (or `?fakeWorld=computer-use`): agents using apps and the
  // browser on this Mac.
  if (world === "computer-use") seedComputerUse(daemon);
  if (world === "real-catalogs") seedRealCatalogs(daemon, Date.now());
  if (world === "cold-start-state") seedColdStartState(daemon);
  // `?fakeWorld=refused-delegation`: an OpenCode thread whose Claude delegations were refused.
  if (world === "refused-delegation")
    new ScenarioPlayer(daemon, refusedDelegation(), { agoMs: 0 }).runUntilBlocked();
  // `?fakeWorld=interrupted-turn`: an OpenCode turn a restart interrupted, held for Resume.
  if (world === "interrupted-turn") seedInterruptedTurn(daemon);
  // `?fakeWorld=turn-endings`: a turn a usage limit paused, and one the person stopped.
  if (world === "turn-endings") seedTurnEndings(daemon);
  // `?fakeWorld=left-running`: a done thread whose turn left a dev server running.
  if (world === "left-running") seedLeftRunning(daemon);
  // `?fakeWorld=child-question`: a Claude thread whose delegated Codex child asks the person.
  if (world === "child-question")
    for (const scenario of delegatedQuestion())
      new ScenarioPlayer(daemon, scenario, { agoMs: 0 }).runUntilBlocked();
  // `?fakeWorld=cross-device`: a thread working on another of the person's machines.
  if (world === "cross-device")
    new ScenarioPlayer(daemon, crossDevice(), { agoMs: 0 }).runUntilBlocked();
  // `?fakeWorld=streaming-reply`: a reply that streams under a finished subagent once
  // `aceStreamReply.play()` runs, or a chunk at a time with `aceStreamReply.step()`.
  if (world === "streaming-reply") {
    const search = new URLSearchParams(globalThis.location?.search ?? "");
    const history = Number(search.get("history")) || 0;
    const afterStep = search.has("afterStep");
    const player = new ScenarioPlayer(daemon, streamingReply({ history, afterStep }), {
      agoMs: 0,
    });
    player.runThrough("asked");
    Object.assign(globalThis, {
      aceStreamReply: {
        play: (speed = 1) => player.autoplay(timer, speed),
        step: () => player.step(),
      },
    });
  }
  // Playwright's screens stage failures and empty states before the app's first request.
  const setup = (globalThis as { aceFakeSetup?: (daemon: FakeDaemon) => void }).aceFakeSetup;
  setup?.(daemon);
  const client = createBrowserClient({
    deviceId: "web-fake-device",
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
  });
  // This device last read the five-day migration after checkpoint 20, so its transcript can
  // show the new-activity divider while preserving the per-device read cursor.
  if (!empty && !["real-thread-state", "cold-start-state"].includes(world ?? ""))
    daemon.markReadThrough("thread-multi-day", "answer-20", "web-fake-device");
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
    // This Mac's relay, cloned under another folder name: New thread finds it by its origin.
    { path: "/home/ci/src/relay-ci", git: true, remote: "https://github.com/acme/relay" },
    { path: "/home/ci/services/api", git: true },
    { path: "/home/ci/services/billing-worker", git: true },
    { path: "/home/ci/services/web-gateway", git: true },
    { path: "/home/ci/infra/terraform", git: true },
  ]);
  // One project there already, so New thread can start on the build server.
  if (!empty) {
    server.projects.command({ type: "workspace.add", path: "/home/ci/src/relay-ci" });
    const added = server.projects.command({ type: "workspace.add", path: "/home/ci/services/api" });
    // A thread there, so Continue on… runs from the build server too.
    if (added?.workspace)
      server.createThread({
        id: "thread-build-rate-limits",
        workspaceId: added.workspace.id,
        title: "Add rate limits to the api",
        provider: "claude",
        hasSentMessage: true,
        details: { workspace: added.workspace },
      });
    // Chats there too, so the Chats panel shows another machine's chats and its device filter.
    for (const chat of buildServerChats())
      new ScenarioPlayer(server, chat.scenario, { agoMs: chat.agoMs }).runUntilBlocked();
  }
  seedBuildServerUsage(server, Date.now());
  // This Mac and the build server are linked both ways, as Settings › Fleet's Link leaves them,
  // so Continue on… and Open on… can send work either way. This Mac is also linked to a studio
  // that is off, which the chooser shows as offline (ADR 0101).
  server.linkTo(daemon);
  daemon.linkTo(server);
  daemon.linkTo(
    new FakeDaemon({ clock: () => Date.now(), hostId: "studio", displayName: "Studio" }),
    {
      status: "offline",
    },
  );
  if (!empty) seedLimitReadings(daemon, Date.now());
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
      access: withFakeMachineAccount({
        origin: "http://127.0.0.1:4242/",
        fetch: daemon.access.fetch,
        token: async () => daemon.access.token,
      }),
      devices: () => daemon.appDevices.transport(),
      screen: () => daemon.screen.transport(),
    },
  };
}
