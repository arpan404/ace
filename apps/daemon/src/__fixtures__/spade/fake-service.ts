import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SpadeServiceControl } from "../../spade/service-control.ts";

const fakeSpade = resolve(import.meta.dirname, "fake-spade.ts");

/**
 * A stand-in for the OS service manager running Spade (launchd, systemd, Task Scheduler): it
 * runs `fake-spade.ts` as a real process with the service's environment while registered, and
 * starts it again when it exits (KeepAlive). It outlives daemon restarts, as a service does.
 *
 * `held`: registering doesn't start Spade until `release()`, as a slow first start would, so
 * its `server.json` appears only later.
 */
export function fakeSpadeService(home: () => string, options: { held?: boolean } = {}) {
  let registered = false;
  let held = options.held ?? false;
  let child: ChildProcess | undefined;
  const counts = { binaryInstalls: 0, registrations: 0, removals: 0 };
  const start = () => {
    if (!registered || held || child) return;
    const dataDir = join(home(), "spade");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const started = spawn(process.execPath, [fakeSpade], {
      env: {
        PATH: process.env.PATH,
        SPADE_DATA_DIR: dataDir,
        SPADE_ACE_HOME: home(),
        SPADE_LISTEN: "127.0.0.1:0",
        RUST_LOG: "info",
      },
      stdio: "ignore",
    });
    child = started;
    started.once("exit", () => {
      if (child === started) child = undefined;
      // KeepAlive: a Spade that exits while registered is started again.
      if (registered) setTimeout(start, 50).unref();
    });
  };
  const stop = async () => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null) return;
    const exited = once(running, "exit");
    running.kill("SIGTERM");
    await exited;
  };
  const control: SpadeServiceControl = {
    state: async () => (!registered ? "absent" : child || held ? "running" : "stopped"),
    installBinary: async () => {
      counts.binaryInstalls++;
    },
    register: async () => {
      counts.registrations++;
      registered = true;
      start();
    },
    remove: async () => {
      counts.removals++;
      registered = false;
      await stop();
    },
  };
  return {
    control,
    counts,
    registered: () => registered,
    pid: () => child?.pid,
    /** A held service starts Spade now. */
    release() {
      held = false;
      start();
    },
    /** Ends the test: Spade stops and nothing starts it again. */
    async close() {
      registered = false;
      await stop();
    },
  };
}
