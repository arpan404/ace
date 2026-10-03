import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDevThread, startDaemon } from "@ace/daemon";
import type { DaemonStatus } from "../../shared/contract.ts";
import { BrowserBackend } from "../browser/backend.ts";
import { BackendConnection } from "../browser/connection.ts";
import { readDesktopCredential } from "../browser/credential.ts";
import { fakeViews } from "../browser/test-support.ts";
import { DaemonRuntime } from "../daemon/runtime.ts";
import type { DaemonProcess } from "../daemon/supervisor.ts";
import type { Alert } from "../notifications/router.ts";
import { DesktopLink } from "./desktop-link.ts";
import { LinkKeeper, runtimeLinkSource } from "./link-keeper.ts";
import type { WorkSummary } from "./thread-watch.ts";

/**
 * The app's background composition without Electron: the daemon runtime and its supervisor
 * start a real daemon, and the same link keeper and source `Background` uses attach the
 * real desktop link. The daemon runs in this process, so the test can change its threads.
 */

/** Real sockets and a real daemon: give them time, then fail with the last assertion. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 20_000, interval: 25 });

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

type Daemon = Awaited<ReturnType<typeof startDaemon>>;

async function freePort(): Promise<{ port: number; blocker: Server }> {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return { port: address.port, blocker };
}

/** Starts the daemon in this process; a start that throws (port in use) exits with code 1. */
function inProcessDaemons(home: string, port: number) {
  const started: Daemon[] = [];
  const spawn = (): DaemonProcess => {
    let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let exited = false;
    let daemon: Daemon | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      exit?.(code, signal);
    };
    startDaemon({
      config: {
        dataDir: home,
        host: "127.0.0.1",
        port,
        listen: "local",
        remotePort: 0,
        logLevel: "silent",
      },
    }).then(
      (running) => {
        daemon = running;
        started.push(running);
      },
      () => finish(1, null),
    );
    return {
      kill(signal) {
        void (daemon?.close() ?? Promise.resolve()).then(() => finish(null, signal));
      },
      onExit(listener) {
        exit = listener;
      },
    };
  };
  return { spawn, started };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ace-desktop-composition-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "ace");
  const { port, blocker } = await freePort();
  cleanups.push(() => new Promise((resolve) => blocker.close(resolve)));
  const daemons = inProcessDaemons(home, port);
  const statuses: DaemonStatus[] = [];
  const runtime = new DaemonRuntime({
    packaged: false,
    version: "0.0.0",
    resources: { entry: join(root, "unused.mjs") },
    env: { ACE_HOME: home, ACE_DESKTOP_DAEMON: "managed", SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
    spawnDaemon: daemons.spawn,
    log: () => {},
  });
  runtime.onStatus((status) => statuses.push(status));
  cleanups.push(async () => {
    await runtime.stop();
    for (const daemon of daemons.started) await daemon.close().catch(() => {});
  });

  const alerts: Alert[] = [];
  const summaries: WorkSummary[] = [];
  let saved: string | null = null;
  const keeper = new LinkKeeper(
    runtimeLinkSource(runtime),
    (endpoint) =>
      new DesktopLink({
        url: endpoint.url,
        token: endpoint.token,
        deviceId: "desktop-test",
        storage: {
          load: async () => saved,
          save: async (value) => {
            saved = value;
          },
        },
        quietHours: () => null,
        onAlert: (alert) => alerts.push(alert),
        onSummary: (summary) => summaries.push(summary),
      }),
    () => {},
  );
  cleanups.push(() => keeper.close());
  return { home, runtime, statuses, blocker, daemons, keeper, alerts, summaries };
}

it("attaches notifications, badge and tray once a daemon is up, after the first start failed", async () => {
  const t = await setup();
  // As in the app: the background follows the daemon before the runtime starts it.
  t.keeper.start();
  // The daemon's port is taken, so the first start crashes.
  void t.runtime.start();
  await eventually(() =>
    expect(t.statuses.some((status) => status.state === "restarting")).toBe(true),
  );
  // The page's hand-off fails on that crash; the background must not give up with it.
  await expect(t.runtime.connection()).rejects.toThrow("The daemon exited");
  await new Promise<void>((resolve) => t.blocker.close(() => resolve()));

  // The crash restart brings the daemon up and the link attaches by itself.
  await eventually(() => expect(t.runtime.current().state).toBe("running"));
  await eventually(() => expect(t.summaries.at(-1)).toEqual({ needsYou: 0, working: 0 }));

  // A notification reaches the app: a thread that starts waiting on a usage limit.
  const daemon = t.daemons.started[0];
  if (!daemon) throw new Error("no daemon");
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(t.home, "test"));
  daemon.store.appendEvents(
    thread.id,
    [{ type: "thread.updated", status: { state: "working", agents: 1 } }],
    Date.now(),
  );
  await eventually(() => expect(t.summaries.at(-1)).toEqual({ needsYou: 0, working: 1 }));
  daemon.store.appendEvents(
    thread.id,
    [{ type: "thread.updated", status: { state: "waiting", on: "rate_limit" } }],
    Date.now(),
  );
  await eventually(() =>
    expect(t.alerts).toContainEqual(expect.objectContaining({ category: "limited" })),
  );
});

it("keeps notifications, badge and tray working when the daemon refuses the browser backend", async () => {
  const t = await setup();
  await new Promise<void>((resolve) => t.blocker.close(() => resolve()));
  t.keeper.start();
  void t.runtime.start();
  await eventually(() => expect(t.summaries.at(-1)).toEqual({ needsYou: 0, working: 0 }));
  const daemon = t.daemons.started[0];
  if (!daemon) throw new Error("no daemon");
  const token = (await readFile(daemon.tokenPath, "utf8")).trim();

  // A credential in the daemon's home makes the desktop try to register. This daemon either
  // does not know `browser.backend.*` (an older daemon) or refuses this credential.
  await writeFile(
    join(t.home, "browser-desktop.json"),
    JSON.stringify({ device: { id: "desktop-browser" }, token: "c".repeat(64) }),
  );
  const connection = new BackendConnection(
    new BrowserBackend(fakeViews().host, { log: () => {} }),
    {
      daemon: async () => ({ url: daemon.url, token }),
      credential: () => readDesktopCredential(t.home),
      socket: (url) => new WebSocket(url),
      timers: {
        set(delayMs, callback) {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      id: randomUUID,
      log: () => {},
    },
  );
  cleanups.push(() => connection.close());
  connection.setAvailable(true);
  await eventually(() => expect(["unsupported", "rejected"]).toContain(connection.state()));

  // The link is still live: a thread that now needs the person reaches the badge and tray.
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(t.home, "test"));
  daemon.store.appendEvents(
    thread.id,
    [{ type: "thread.updated", status: { state: "needs_you", interactions: 1 } }],
    Date.now(),
  );
  await eventually(() => expect(t.summaries.at(-1)).toEqual({ needsYou: 1, working: 0 }));
});
