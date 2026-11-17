import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { AgentId, ThreadId } from "@ace/protocol";
import { CommandHost } from "./command-host.ts";
import type { GuestSession } from "./guest-sessions.ts";

type Entry = { command: string; status: string };

/**
 * A command host whose store, transcript, process and clock are under the test's control.
 * `thread()` is what the store reads of the session's thread (it may throw); `transcript` takes
 * each entry written, and `ended` each command ended as cancelled.
 */
function host(options: {
  origin?(): unknown;
  thread?(): { deletedAt?: number | undefined } | undefined;
  transcript(entry: Entry): void;
  ended?(key: string): void;
}) {
  const timers: { ms: number; run: () => void }[] = [];
  const logged: string[] = [];
  const commands = new CommandHost({
    store: {
      statement: () =>
        ({
          get: () => options.origin?.() ?? { origin_host: "laptop", origin_thread: "t" },
        }) as never,
      getThread: () => (options.thread ? options.thread() : {}) as never,
      atomic: (run) => run(undefined as never),
    },
    engine: () => ({
      guests: {
        command: (_thread, _key, entry) => options.transcript(entry),
        endCommands: (_thread, key) => {
          options.ended?.(key);
          return 1;
        },
      },
    }),
    guests: { ticket: () => 0, run: () => Promise.reject(new Error("unused")) },
    roots: () => ["/project"],
    folder: async (path) => path,
    shell: (command) => ({ command: "/bin/sh", args: ["-c", command] }),
    env: () => ({}),
    spawn: () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.end();
      stderr.end();
      return {
        stdin: new PassThrough(),
        stdout,
        stderr,
        exited: Promise.resolve({ code: 0, signal: null }),
        stop: async () => undefined,
      };
    },
    clock: {
      now: () => 0,
      schedule: (ms, run) => {
        const timer = { ms, run };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer), 1);
      },
    },
    newId: () => "1",
    log: (message) => logged.push(message),
  });
  /** Fires the one retry armed (the command's own timeout timer went with its exit). */
  const retry = () => {
    expect(timers).toHaveLength(1);
    const [timer] = timers.splice(0, 1);
    if (!timer) throw new Error("no retry armed");
    timer.run();
    return timer.ms;
  };
  return { commands, timers, logged, retry };
}

const session: GuestSession = {
  threadId: ThreadId.parse("thread-guest"),
  agentId: AgentId.parse("root"),
  deviceId: "device-1",
  owner: "owner",
  agent: AgentId.parse("remote:agent"),
};
const run = (commands: CommandHost) =>
  commands.call(
    session,
    "command_run",
    { project: "project", command: "true" },
    new AbortController().signal,
  );
const statuses = (entries: Entry[]) => entries.map((entry) => entry.status);
const locked = () => new Error("database is locked");

test("a command whose caller can't be read from the store still ends in the transcript", async () => {
  const transcript: Entry[] = [];
  const { commands, logged } = host({
    origin: () => {
      throw new Error("database disk image is malformed");
    },
    transcript: (entry) => transcript.push(entry),
  });
  await expect(run(commands)).resolves.toBeDefined();
  expect(statuses(transcript)).toEqual(["running", "succeeded"]);
  expect(logged).toContain("Command from another machine");
});

test("an end the transcript can't take yet is retried, backing off, until it lands", async () => {
  const transcript: Entry[] = [];
  let failing = 2;
  const { commands, timers, retry } = host({
    transcript: (entry) => {
      if (entry.status !== "running" && failing-- > 0) throw locked();
      transcript.push(entry);
    },
  });
  await run(commands);
  expect(statuses(transcript)).toEqual(["running"]);
  expect(retry()).toBe(1000);
  expect(retry()).toBe(2000);
  expect(statuses(transcript)).toEqual(["running", "succeeded"]);
  expect(timers).toEqual([]);
});

test("a session deleted while its end waits to be retried is never written to", async () => {
  const transcript: Entry[] = [];
  let deletedAt: number | undefined;
  let failing = true;
  const { commands, timers, retry } = host({
    thread: () => ({ deletedAt }),
    transcript: (entry) => {
      if (entry.status !== "running" && failing) throw locked();
      transcript.push(entry);
    },
  });
  await run(commands);
  // Soft-deleted meanwhile: its engine state stays, and the write itself would now succeed.
  deletedAt = 5;
  failing = false;
  retry();
  expect(statuses(transcript)).toEqual(["running"]);
  expect(timers).toEqual([]);
});

test("a session that can't be read is not written to, and is tried again", async () => {
  const transcript: Entry[] = [];
  let unreadable = false;
  const { commands, retry } = host({
    thread: () => {
      if (unreadable) throw locked();
      return {};
    },
    transcript: (entry) => transcript.push(entry),
  });
  // The start is recorded; the end's check then finds the store unreadable.
  const started = run(commands);
  unreadable = true;
  await started;
  expect(statuses(transcript)).toEqual(["running"]);
  unreadable = false;
  expect(retry()).toBe(1000);
  expect(statuses(transcript)).toEqual(["running", "succeeded"]);
});

test("an end that never lands is ended as cancelled after the fast retries, never left running", async () => {
  const ended: string[] = [];
  let endFails = 1;
  const { commands, retry } = host({
    transcript: (entry) => {
      if (entry.status !== "running") throw locked();
    },
    ended: (key) => {
      if (endFails-- > 0) throw locked();
      ended.push(key);
    },
  });
  await run(commands);
  const waits = [retry(), retry(), retry(), retry(), retry()];
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000]);
  // The sixth full write failed and so did the smaller one: the slow, steady pace follows.
  expect(ended).toEqual([]);
  expect(retry()).toBe(300_000);
  expect(ended).toHaveLength(1);
});
