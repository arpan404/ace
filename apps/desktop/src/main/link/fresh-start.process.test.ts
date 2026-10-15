import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDevThread } from "@ace/daemon";
import { HOME_FORMAT_FILE, prepareDaemonHome, resolveDaemonHome } from "@ace/service/home";
import { DaemonRuntime } from "../daemon/runtime.ts";
import { resolveTarget, type DaemonTarget } from "../daemon/target.ts";
import { freePort, inProcessDaemons } from "./daemon-test-support.ts";
import { DesktopLink } from "./desktop-link.ts";
import { LinkKeeper, runtimeLinkSource, type Endpoint } from "./link-keeper.ts";
import { notificationOutbox } from "./notification-outbox.ts";
import type { WorkSummary } from "./thread-watch.ts";

/*
 * A fresh start of the daemon home (ADR 0081) with the app's own data folder kept: the app's
 * runtime, link keeper and notification outbox, a real daemon in a temp HOME and a temp
 * userData. The app must open on the new daemon by itself; a remote daemon that changed is
 * still refused.
 */

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 20_000, interval: 25 });

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function machine() {
  const user = await realpath(await mkdtemp(join(tmpdir(), "ace-desktop-fresh-")));
  cleanups.push(() => rm(user, { recursive: true, force: true }));
  const { port, blocker } = await freePort();
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  return { user, home: join(user, ".ace"), userData: join(user, "userData"), port };
}

/** What the app does at launch (`desktopTarget`), on the temp HOME. */
function managedTarget(user: string, home: string): DaemonTarget {
  return resolveTarget(
    { ACE_HOME: home, ACE_DESKTOP_DAEMON: "managed" },
    {
      packaged: true,
      daemonEntry: join(user, "unused.mjs"),
      readToken: () => "",
      platform: process.platform,
      homedir: user,
      resolveHome: resolveDaemonHome,
      prepareHome(path) {
        const prepared = prepareDaemonHome(path);
        return prepared.state === "fresh"
          ? { backup: prepared.backup, previousFormat: prepared.previousFormat }
          : undefined;
      },
    },
  );
}

/**
 * One launch of the app: its runtime starts the daemon (in this process) for a managed target,
 * and the link keeper attaches the desktop link with the notification outbox in `userData`,
 * as `Background` does.
 */
function launch(options: {
  user: string;
  home: string;
  userData: string;
  port: number;
  target: DaemonTarget;
}) {
  const daemons = inProcessDaemons(options.home, options.port);
  const runtime = new DaemonRuntime({
    packaged: true,
    version: "0.0.0",
    resources: { entry: join(options.user, "unused.mjs") },
    env: { SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
    target: options.target,
    spawnDaemon: daemons.spawn,
    log: () => {},
  });
  const summaries: WorkSummary[] = [];
  const links: DesktopLink[] = [];
  const keeper = new LinkKeeper(
    runtimeLinkSource(runtime),
    (endpoint: Endpoint) => {
      const link = new DesktopLink({
        url: endpoint.url,
        token: endpoint.token,
        deviceId: "desktop-test",
        ...(endpoint.localHostId ? { localHostId: endpoint.localHostId } : {}),
        storage: notificationOutbox(options.userData, {
          url: endpoint.url,
          deviceId: "desktop-test",
          ...(endpoint.localHostId ? { localHostId: endpoint.localHostId } : {}),
        }),
        quietHours: () => null,
        onAlert: () => {},
        onSummary: (summary) => summaries.push(summary),
      });
      links.push(link);
      return link;
    },
    () => {},
  );
  keeper.start();
  void runtime.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await keeper.close();
    await runtime.stop();
    for (const daemon of daemons.started) await daemon.close().catch(() => {});
  };
  cleanups.push(stop);
  return { runtime, summaries, links, daemons, stop };
}

const read = (home: string, file: string) => readFile(join(home, file), "utf8");

/** A thread starts working in the daemon `owner` runs; a live link's badge counts it. */
function startWork(owner: ReturnType<typeof launch>, home: string) {
  const daemon = owner.daemons.started.at(-1);
  if (!daemon) throw new Error("no daemon");
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(home, "test"));
  daemon.store.appendEvents(
    thread.id,
    [{ type: "thread.updated", status: { state: "working", agents: 1 } }],
    Date.now(),
  );
}
const working = { needsYou: 0, working: 1 };

it("after a fresh start the desktop connects to its new local daemon without a manual token", async () => {
  const m = await machine();
  const before = launch({ ...m, target: managedTarget(m.user, m.home) });
  await eventually(() => expect(before.daemons.started).toHaveLength(1));
  startWork(before, m.home);
  // The link reached that daemon, so the app's notification outbox is pinned to it.
  await eventually(() => expect(before.summaries.at(-1)).toEqual(working));
  const oldHost = await read(m.home, "host-id");
  await before.stop();

  // A build with a newer home format: the next launch sets the old home aside.
  await rm(join(m.home, HOME_FORMAT_FILE));
  const target = managedTarget(m.user, m.home);
  expect(target).toMatchObject({ kind: "managed", fresh: { previousFormat: "ace-v0" } });
  const after = launch({ ...m, target });
  await eventually(() => expect(after.daemons.started).toHaveLength(1));

  const newHost = await read(m.home, "host-id");
  expect(newHost).not.toBe(oldHost);
  // The page gets the new home's token and identity, never the ones it saw before.
  expect(await after.runtime.connection()).toEqual({
    mode: "daemon",
    url: `ws://127.0.0.1:${m.port}/`,
    token: (await read(m.home, "daemon-token")).trim(),
    localHostId: newHost,
  });
  // The same app data folder, and the link works with the new daemon.
  startWork(after, m.home);
  await eventually(() => expect(after.summaries.at(-1)).toEqual(working));
  expect(after.links.some((link) => link.fatal())).toBe(false);
});

it("a remote daemon whose identity changed is still refused", async () => {
  const m = await machine();
  const url = `ws://127.0.0.1:${m.port}/`;
  const remote = (token: string): DaemonTarget => ({ kind: "remote", url, token });

  // The daemon at that address, reached as a remote one: the outbox is pinned to it.
  const first = launch({ ...m, target: managedTarget(m.user, m.home) });
  await eventually(() => expect(first.daemons.started).toHaveLength(1));
  const met = launch({ ...m, target: remote((await read(m.home, "daemon-token")).trim()) });
  startWork(first, m.home);
  await eventually(() => expect(met.summaries.at(-1)).toEqual(working));
  expect(await met.runtime.connection()).not.toHaveProperty("localHostId");
  await met.stop();
  await first.stop();

  // Another daemon answers at the same address, and its token is valid: a different machine.
  await rm(m.home, { recursive: true, force: true });
  const other = launch({ ...m, target: managedTarget(m.user, m.home) });
  await eventually(() => expect(other.daemons.started).toHaveLength(1));
  const changed = launch({ ...m, target: remote((await read(m.home, "daemon-token")).trim()) });
  await eventually(() => expect(changed.links.at(-1)?.fatal()).toBe(true));
  startWork(other, m.home);
  await eventually(() => expect(other.summaries.at(-1)).toEqual(working));
  expect(changed.summaries).not.toContainEqual(working);
});
