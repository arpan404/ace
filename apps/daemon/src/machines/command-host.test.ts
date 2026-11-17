import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { AgentId, ThreadId } from "@ace/protocol";
import { CommandHost } from "./command-host.ts";
import type { GuestSession } from "./guest-sessions.ts";

type Entry = { command: string; status: string };

/** A command host whose store, transcript, process and clock are under the test's control. */
function host(options: { origin(): unknown; transcript(entry: Entry): void }) {
  const timers: { ms: number; run: () => void }[] = [];
  const logged: string[] = [];
  const commands = new CommandHost({
    store: {
      statement: () => ({ get: () => options.origin() }) as never,
      getThread: () => ({ deletedAt: undefined }) as never,
    },
    engine: () => ({
      guests: { command: (_thread, _key, entry) => options.transcript(entry) },
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
  return { commands, timers, logged };
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

test("a command whose caller can't be read from the store still ends in the transcript", async () => {
  const transcript: Entry[] = [];
  const { commands, logged } = host({
    origin: () => {
      throw new Error("database disk image is malformed");
    },
    transcript: (entry) => transcript.push(entry),
  });
  await expect(run(commands)).resolves.toBeDefined();
  expect(transcript.map((entry) => entry.status)).toEqual(["running", "succeeded"]);
  expect(logged).toContain("Command from another machine");
});

test("an end the transcript can't take yet is retried, backing off, until it lands", async () => {
  const transcript: Entry[] = [];
  let failing = 2;
  const { commands, timers } = host({
    origin: () => ({ origin_host: "laptop", origin_thread: "t" }),
    transcript: (entry) => {
      if (entry.status !== "running" && failing-- > 0) throw new Error("database is locked");
      transcript.push(entry);
    },
  });
  await run(commands);
  expect(transcript.map((entry) => entry.status)).toEqual(["running"]);
  // The command's own timeout timer is gone with its exit; what is left is the retry.
  const retry = () => {
    const timer = timers.find((each) => each.ms <= 60_000);
    if (!timer) throw new Error("no retry armed");
    timers.splice(timers.indexOf(timer), 1);
    timer.run();
    return timer.ms;
  };
  expect(retry()).toBe(1000);
  expect(retry()).toBe(2000);
  expect(transcript.map((entry) => entry.status)).toEqual(["running", "succeeded"]);
  expect(timers.filter((each) => each.ms <= 60_000)).toEqual([]);
});
