import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonConnection, DaemonStatus } from "../../shared/contract.ts";
import { createPageConnection } from "./page-connection.ts";
import { DaemonRuntime } from "./runtime.ts";

const real: DaemonConnection = {
  mode: "daemon",
  url: "ws://127.0.0.1:5151/",
  token: "ab".repeat(32),
  localHostId: "host-1",
};

/** An app whose daemon answers, or fails, when the test says. */
function app() {
  const listeners = new Set<(status: DaemonStatus) => void>();
  let answer = Promise.withResolvers<DaemonConnection>();
  let reloads = 0;
  const handoff = createPageConnection({
    connection: () => answer.promise,
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: () => reloads++,
  });
  return {
    handoff,
    reloads: () => reloads,
    fail() {
      answer.reject(new Error("The daemon could not start"));
      answer = Promise.withResolvers();
    },
    answer: () => answer.resolve(real),
    emit(state: DaemonStatus["state"]) {
      for (const listener of listeners)
        listener({ state, source: "app", restarts: 0, paused: false });
    },
  };
}

describe("the page's daemon hand-off", () => {
  it("a page refused on a failed start reloads once the daemon runs again", async () => {
    const a = app();
    const asked = a.handoff.connection();
    a.fail();
    await expect(asked).rejects.toThrow("could not start");
    expect(a.reloads()).toBe(0);
    a.emit("running");
    expect(a.reloads()).toBe(1);
    // Once: a later start of the same daemon is the reconnecting notice's to show.
    a.emit("running");
    expect(a.reloads()).toBe(1);
  });

  it("a page handed its daemon is never reloaded by the daemon's status", async () => {
    const a = app();
    const asked = a.handoff.connection();
    a.answer();
    expect(await asked).toEqual(real);
    a.emit("restarting");
    a.emit("running");
    expect(a.reloads()).toBe(0);
  });

  it("on a cold start the page is handed nothing until the daemon answers, even with a kept home", async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-cold-handoff-"));
    // A home from an earlier run: token and identity kept, no daemon running.
    await writeFile(join(home, "daemon-token"), "ab".repeat(32));
    await writeFile(join(home, "host-id"), "host-1");
    const runtime = new DaemonRuntime({
      target: { kind: "managed", home, entry: join(home, "unused.mjs") },
      packaged: false,
      version: "0.0.0",
      resources: { entry: join(home, "unused.mjs") },
      env: { SHELL: "/bin/sh", PATH: "/usr/bin:/bin", ACE_PORT: "5151" },
      // A daemon that starts but never answers; it exits when told to stop.
      spawnDaemon: () => {
        let exited: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
        return {
          kill: (signal: NodeJS.Signals) => exited?.(null, signal),
          onExit: (listener) => (exited = listener),
        };
      },
      log: () => {},
    });
    try {
      void runtime.start();
      let handed = false;
      const page = createPageConnection({
        connection: () => runtime.connection(),
        onStatus: (listener) => runtime.onStatus(listener),
        reload: () => {},
      });
      void page.connection().then(
        () => (handed = true),
        () => {},
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(handed).toBe(false);
      expect(runtime.current().state).toBe("starting");
    } finally {
      await runtime.stop();
      await rm(home, { recursive: true, force: true });
    }
  });
});
