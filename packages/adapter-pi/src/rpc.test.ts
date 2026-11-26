import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { PiRpc, type Schedule } from "./rpc.ts";

function fakeRpc(schedule: Schedule) {
  return new PiRpc(
    {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exited: new Promise(() => {}),
      signal: new AbortController().signal,
      stop: async () => ({ code: 0, signal: null, reason: "stopped" }),
    },
    schedule,
    () => {},
    () => {},
    (line) => line,
  );
}

function timers() {
  const all: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: Schedule = (callback, ms) => {
    const timer = { callback, ms, cancelled: false };
    all.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return { all, schedule };
}

test("a resumed deadline keeps the request's own timeout, never a shorter default", () => {
  const { all, schedule } = timers();
  const rpc = fakeRpc(schedule);
  // A compaction may take minutes; a dialog opening and closing must not shorten it to 30 s.
  void rpc.request("compact", {}, 30 * 60_000).catch(() => {});
  expect(all.map((timer) => timer.ms)).toEqual([30 * 60_000]);
  rpc.pauseDeadlines();
  expect(all[0]?.cancelled).toBe(true);
  rpc.resumeDeadlines();
  expect(all.slice(1).map((timer) => timer.ms)).toEqual([30 * 60_000]);
});

test("a fired command arms no deadline, so a late reply can't poison the session", async () => {
  const { all, schedule } = timers();
  const rpc = fakeRpc(schedule);
  await rpc.fire("compact");
  expect(all).toEqual([]);
});
