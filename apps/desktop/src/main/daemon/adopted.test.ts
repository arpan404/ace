import { expect, it } from "vitest";
import { adoptedProcess, type AdoptedPorts } from "./adopted.ts";
import { sameRun, type LockOwner } from "./ownership.ts";

/** A process table, the home's lock, and a clock the test moves. The adopted run is pid 7, "run-a". */
function world(options: { windows?: boolean; stopAccepted?: boolean } = {}) {
  let now = 0;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const state: { pids: Set<number>; lock: LockOwner | undefined } = {
    pids: new Set([7]),
    lock: { pid: 7, id: "run-a" },
  };
  const sent: string[] = [];
  const ports: AdoptedPorts = {
    sameRun: async () => state.pids.has(7) && sameRun(state.lock, { pid: 7, lockId: "run-a" }),
    signal: (pid, signal) => {
      sent.push(signal);
      state.pids.delete(pid);
    },
    ...(options.windows
      ? {
          requestStop: async () => {
            sent.push("POST /v1/stop");
            return options.stopAccepted ?? true;
          },
        }
      : {}),
    pollMs: 1_000,
    timers: {
      set(delayMs, callback) {
        const timer = { at: now + delayMs, callback, cancelled: false };
        timers.push(timer);
        return () => (timer.cancelled = true);
      },
    },
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      const next = timers
        .filter((timer) => !timer.cancelled && timer.at <= until)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cancelled = true;
      now = next.at;
      next.callback();
    }
    now = until;
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ports, state, sent, advance };
}

it("an adopted daemon's exit is noticed once its pid is gone", async () => {
  const w = world();
  const exits: unknown[][] = [];
  adoptedProcess(7, w.ports).onExit((...exit) => exits.push(exit));
  await w.advance(5_000);
  expect(exits).toEqual([]);
  w.state.pids.delete(7);
  await w.advance(1_000);
  expect(exits).toEqual([[null, null]]);
});

it("a CLI daemon that took the adopted daemon's pid while the app slept counts as that daemon's exit, and is never signalled", async () => {
  const w = world();
  const daemon = adoptedProcess(7, w.ports);
  const exits: unknown[][] = [];
  daemon.onExit((...exit) => exits.push(exit));
  // The adopted daemon exited and a CLI daemon started on the reused pid before any look.
  w.state.lock = { pid: 7, id: "cli-run" };
  daemon.kill("SIGTERM");
  daemon.kill("SIGKILL");
  await w.advance(0);
  expect(w.sent).toEqual([]);
  expect(exits).toEqual([[null, null]]);
});

it("the adopted run, still holding the lock, is signalled", async () => {
  const w = world();
  adoptedProcess(7, w.ports).kill("SIGTERM");
  await w.advance(0);
  expect(w.sent).toEqual(["SIGTERM"]);
});

it("on Windows, a stop request that fails after the run changed hands sends no signal", async () => {
  const w = world({ windows: true });
  const answer = Promise.withResolvers<boolean>();
  w.ports.requestStop = () => answer.promise;
  const daemon = adoptedProcess(7, w.ports);
  daemon.kill("SIGTERM");
  await w.advance(0);
  // While the request waits, the adopted daemon exits and a CLI daemon takes its pid.
  w.state.lock = { pid: 7, id: "cli-run" };
  answer.resolve(false);
  await w.advance(0);
  expect(w.sent).toEqual([]);
});

it.each([
  [true, ["POST /v1/stop"]],
  [false, ["POST /v1/stop", "SIGTERM"]],
])("on Windows a graceful stop asks the daemon first (accepted: %s)", async (accepted, sent) => {
  const w = world({ windows: true, stopAccepted: accepted });
  adoptedProcess(7, w.ports).kill("SIGTERM");
  await w.advance(0);
  expect(w.sent).toEqual(sent);
});
