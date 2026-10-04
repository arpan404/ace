import { expect, test } from "vitest";
import type { TerminalEvent, TerminalSource } from "../sources.ts";
import type { Schedule } from "../schedule.ts";
import { TerminalSessions } from "./sessions.ts";

/** A daemon's PTYs as the sessions see them: open streams, and output pushed by the test. */
function daemon() {
  const streams = new Map<string, (event: TerminalEvent) => void>();
  let offset = 0;
  const source: TerminalSource = {
    link: "connected",
    version: 0,
    subscribe: () => () => {},
    list: () => [],
    listed: () => true,
    refresh: async () => {},
    open: async () => ({ id: "t1", threadId: "thread", name: "zsh", exited: false }),
    attach(id, _from, listener) {
      streams.set(id, listener);
      return () => streams.delete(id);
    },
    write: () => {},
    resize: () => {},
    close: async () => {},
  };
  return {
    source,
    streams,
    print(id: string, data: string) {
      const event = { type: "data", offset, endOffset: offset + data.length, data } as const;
      offset += data.length;
      streams.get(id)?.({ ...event, truncatedBefore: false });
    },
    exit(id: string) {
      streams.get(id)?.({ type: "exit", code: 0, nextOffset: offset });
    },
  };
}

/** Timers the test runs by hand. */
function clock() {
  let now = 0;
  const pending = new Set<{ at: number; run: () => void }>();
  const schedule: Schedule = (run, ms) => {
    const timer = { at: now + ms, run };
    pending.add(timer);
    return () => pending.delete(timer);
  };
  return {
    schedule,
    advance(ms: number) {
      now += ms;
      for (const timer of pending)
        if (timer.at <= now) {
          pending.delete(timer);
          timer.run();
        }
    },
  };
}

const sessionsOf = (source: TerminalSource, schedule: Schedule) =>
  new TerminalSessions(source, { schedule, idleMs: 60_000, frame: (flush) => flush() });

test("a terminal nobody watches is released after it exits", () => {
  const pty = daemon();
  const sessions = sessionsOf(pty.source, clock().schedule);
  const stop = sessions.watch("t1", () => {});
  pty.print("t1", "done\r\n");
  stop();
  expect(pty.streams.has("t1")).toBe(true);

  pty.exit("t1");
  expect(pty.streams.has("t1")).toBe(false);
  // Shown again, it attaches afresh rather than from memory.
  sessions.watch("t1", () => {});
  expect(pty.streams.has("t1")).toBe(true);
  expect(sessions.exitCode("t1")).toBeNull();
});

test("a running terminal nobody shows keeps streaming for a while, then gives its stream back", () => {
  const pty = daemon();
  const time = clock();
  const sessions = sessionsOf(pty.source, time.schedule);
  const stop = sessions.watch("t1", () => {});
  stop();

  time.advance(30_000);
  pty.print("t1", "listening on :5173\r\n");
  // Shown again within the idle limit, what it printed meanwhile is there.
  const replayed: string[] = [];
  const stopOutput = sessions.output("t1", (output) => {
    if (output.kind === "data") replayed.push(output.data);
  });
  expect(replayed.join("")).toContain("listening on :5173");
  stopOutput();

  time.advance(60_000);
  expect(pty.streams.has("t1")).toBe(false);
});

test("redraws of a streaming terminal reach its view once per frame", () => {
  const pty = daemon();
  const frames: (() => void)[] = [];
  const sessions = new TerminalSessions(pty.source, {
    schedule: clock().schedule,
    frame: (flush) => frames.push(flush),
  });
  let redraws = 0;
  sessions.watch("t1", () => redraws++);
  for (let n = 0; n < 50; n++) pty.print("t1", `line ${n}\r\n`);
  expect(redraws).toBe(0);
  frames.shift()?.();
  expect(redraws).toBe(1);
  expect(sessions.screen("t1").text()).toContain("line 49");
});

test("a tab asking twice for its terminal while it opens gets one shell; asking later opens another", async () => {
  const pty = daemon();
  let opened = 0;
  pty.source.open = async () => ({
    id: `t${++opened}`,
    threadId: "thread",
    name: "Terminal",
    exited: false,
  });
  const sessions = sessionsOf(pty.source, clock().schedule);
  const [first, again] = await Promise.all([
    sessions.openFor("terminal:pending-1", "thread"),
    sessions.openFor("terminal:pending-1", "thread"),
  ]);
  expect(again.id).toBe(first.id);
  expect((await sessions.openFor("terminal:pending-1", "thread")).id).not.toBe(first.id);
  expect(opened).toBe(2);
});

test("a closed tab's shell is ended once the daemon is reachable again", async () => {
  let link: "connected" | "disconnected" = "disconnected";
  const listeners = new Set<() => void>();
  const closed: string[] = [];
  const pty = daemon();
  const source: TerminalSource = {
    ...pty.source,
    get link() {
      return link;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async (id) => {
      if (link !== "connected") throw new Error("terminal_offline");
      closed.push(id);
    },
  };
  const sessions = sessionsOf(source, clock().schedule);
  sessions.end("thread", "t1");
  await Promise.resolve();
  expect(closed).toEqual([]);

  link = "connected";
  for (const listener of listeners) listener();
  await Promise.resolve();
  expect(closed).toEqual(["t1"]);
});
