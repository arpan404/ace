import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDevThread, startDaemon } from "@ace/daemon";
import { BrowserBackend } from "../browser/backend.ts";
import { BackendConnection } from "../browser/connection.ts";
import { readDesktopCredential } from "../browser/credential.ts";
import { fakeViews } from "../browser/test-support.ts";
import { DesktopLink } from "./desktop-link.ts";
import type { WorkSummary } from "./thread-watch.ts";

/** Real sockets and a real daemon: give them time, then fail with the last assertion. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 20 });

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

it("keeps notifications, badge and tray working when the daemon refuses the browser backend", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-desktop-link-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const daemon = await startDaemon({
    config: {
      dataDir: home,
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "silent",
    },
  });
  cleanups.push(() => daemon.close());
  const token = (await readFile(daemon.tokenPath, "utf8")).trim();
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(home, "test"));

  let saved: string | null = null;
  const summaries: WorkSummary[] = [];
  const link = new DesktopLink({
    url: daemon.url,
    token,
    deviceId: "desktop-test",
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    quietHours: () => null,
    onAlert: () => {},
    onSummary: (summary) => summaries.push(summary),
  });
  cleanups.push(() => link.close());
  await link.start();
  await eventually(() => expect(summaries.at(-1)).toEqual({ needsYou: 0, working: 0 }));

  // A credential in the daemon's home makes the desktop try to register. This daemon either
  // does not know `browser.backend.*` (an older daemon) or refuses this credential.
  await writeFile(
    join(home, "browser-desktop.json"),
    JSON.stringify({ device: { id: "desktop-browser" }, token: "c".repeat(64) }),
  );
  const connection = new BackendConnection(
    new BrowserBackend(fakeViews().host, { log: () => {} }),
    {
      daemon: async () => ({ url: daemon.url, token }),
      credential: () => readDesktopCredential(home),
      socket: (url) => new WebSocket(url),
      timers,
      id: randomUUID,
      log: () => {},
    },
  );
  cleanups.push(() => connection.close());
  connection.setAvailable(true);
  await eventually(() => expect(["unsupported", "rejected"]).toContain(connection.state()));

  // The link is still live: a thread that now needs the person reaches the badge and tray.
  daemon.store.appendEvents(
    thread.id,
    [{ type: "thread.updated", status: { state: "needs_you", interactions: 1 } }],
    Date.now(),
  );
  await eventually(() => expect(summaries.at(-1)).toEqual({ needsYou: 1, working: 0 }));
});
