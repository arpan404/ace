import { expect, it } from "vitest";
import { adoptedProcess, type AdoptedPorts } from "./adopted.ts";

/** A process table with one daemon, the home's lock, and a clock the test moves. */
function world(options: { windows?: boolean; stopAccepted?: boolean } = {}) {
  let now = 0;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const state = { alive: true, lockPid: 7 as number | undefined };
  const sent: string[] = [];
  const ports: AdoptedPorts = {
    alive: () => state.alive,
    owns: async (pid) => state.lockPid === pid,
    signal: (_pid, signal) => {
      sent.push(signal);
      state.alive = false;
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
  };
  return { ports, state, sent, advance };
}

it("an adopted daemon's exit is noticed once its pid is gone", async () => {
  const w = world();
  const exits: unknown[][] = [];
  adoptedProcess(7, w.ports).onExit((...exit) => exits.push(exit));
  await w.advance(5_000);
  expect(exits).toEqual([]);
  w.state.alive = false;
  await w.advance(1_000);
  expect(exits).toEqual([[null, null]]);
});

it("a pid that no longer holds the home's lock is never signalled", async () => {
  const w = world();
  const daemon = adoptedProcess(7, w.ports);
  w.state.lockPid = 9;
  daemon.kill("SIGTERM");
  await w.advance(0);
  expect(w.sent).toEqual([]);
  w.state.lockPid = 7;
  daemon.kill("SIGTERM");
  await w.advance(0);
  expect(w.sent).toEqual(["SIGTERM"]);
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
