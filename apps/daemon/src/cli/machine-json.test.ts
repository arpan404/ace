import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliOutputs } from "@ace/protocol/cli-outputs";
import { prepareDaemonHome } from "@ace/service";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { commandTable } from "./commands/table.ts";
import { main } from "./main.ts";
import { parseCommandLine } from "./parse.ts";

/*
 * Golden `--json` for This machine and Spade with the daemon down: each command line runs the
 * way `ace` runs it, against a temp home, and what it prints is checked against the schema its
 * table entry names (ADR 0176 §3).
 */

let home = "";
const previous = { home: process.env.ACE_HOME, exitCode: process.exitCode };
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "ace-cli-machine-json-"));
  process.env.ACE_HOME = home;
  // Settled first, as the daemon would, so the token below isn't set aside as an older home's.
  prepareDaemonHome(home);
  await writeFile(join(home, "daemon-token"), "a".repeat(64));
});
afterAll(async () => {
  if (previous.home === undefined) delete process.env.ACE_HOME;
  else process.env.ACE_HOME = previous.home;
  process.exitCode = previous.exitCode;
  await rm(home, { recursive: true, force: true });
});

const capture = (into: string[]) => (text: unknown, done?: unknown) => {
  into.push(String(text));
  if (typeof done === "function") done();
  return true;
};

/** Runs one command line; returns what reached stdout and stderr, and the exit code. */
async function run(line: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture(out));
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture(err));
  process.exitCode = 0;
  try {
    await main(line);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout: out.join(""), stderr: err.join(""), code };
}

function schemaFor(line: string[]) {
  const parsed = parseCommandLine(commandTable(), line);
  if (parsed.kind !== "command" || !parsed.command.output) throw new Error(`no output: ${line}`);
  const schema = cliOutputs[parsed.command.output as keyof typeof cliOutputs];
  if (!schema) throw new Error(`no schema ${parsed.command.output}`);
  return schema;
}

describe("--json prints one value that matches the command's schema", () => {
  test.each<[string[], (value: unknown) => void]>([
    [
      ["config", "list", "--json"],
      (value) =>
        expect(value).toContainEqual(
          expect.objectContaining({ key: "threads.useWorktree", source: "default", live: false }),
        ),
    ],
    [
      ["config", "set", "threads.useWorktree", "off", "--json"],
      (value) => expect(value).toMatchObject({ value: false, source: "saved" }),
    ],
    [
      ["config", "get", "threads.useWorktree", "--json"],
      (value) => expect(value).toMatchObject({ value: false, source: "saved" }),
    ],
    [
      ["config", "unset", "threads.useWorktree", "--json"],
      (value) => expect(value).toMatchObject({ value: true, source: "default" }),
    ],
    [
      ["config", "set", "log-cap", "512m", "--json"],
      (value) =>
        expect(value).toMatchObject({
          setting: "log-cap",
          key: "logs.maxBytes",
          value: 512 * 1024 ** 2,
        }),
    ],
    [
      ["feature", "on", "marketplace", "--json"],
      (value) => expect(value).toEqual({ marketplace: true, live: false }),
    ],
    [
      ["feature", "list", "--json"],
      (value) => expect(value).toEqual({ spade: false, marketplace: true }),
    ],
    [
      ["spade", "status", "--json"],
      (value) => expect(value).toEqual({ beta: false, enabled: false, live: false }),
    ],
    [["daemon", "status", "--json"], (value) => expect(value).toEqual({ running: false })],
    [["daemon", "token", "--json"], (value) => expect(value).toEqual({ token: "a".repeat(64) })],
  ])("%j", async (line, check) => {
    const result = await run(line);
    expect(result.code, result.stderr).toBe(0);
    const value: unknown = JSON.parse(result.stdout);
    expect(() => schemaFor(line).parse(value)).not.toThrow();
    check(value);
  });
});

describe("old spellings print the same JSON and nothing else on stdout", () => {
  test.each<[string[], string[]]>([
    [
      ["config", "get", "--json"],
      ["config", "list", "--json"],
    ],
    [
      ["features", "--json"],
      ["feature", "list", "--json"],
    ],
    [
      ["token", "--json"],
      ["daemon", "token", "--json"],
    ],
    [
      ["features", "on", "marketplace", "--json"],
      ["feature", "on", "marketplace", "--json"],
    ],
  ])("%j is %j", async (old, now) => {
    const before = await run(old);
    const after = await run(now);
    expect(before.code, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual(JSON.parse(after.stdout));
  });
});

test("a person reads words, never JSON; scripts with --quiet get only keys", async () => {
  const human = await run(["config", "get", "retention-days"]);
  expect(human.stdout).toBe(
    "retention-days (storage.retentionDays): 120 days (default)\nDays idle threads, unused attachments and logs are kept. Takes a whole number of days from 1 to 3650.\nThe daemon is not running; it applies saved values when it starts.\n",
  );
  const quiet = await run(["config", "list", "--quiet"]);
  expect(quiet.stdout.split("\n")).toContain("threads.useWorktree");
  expect(quiet.stdout).not.toContain(" ");
  expect((await run(["daemon", "status"])).stdout).toBe(
    "ace isn't running.\nStart it with ace start, or open the app.\n",
  );
});

test("off a terminal, spade on with Beta off is refused with the way forward, and nothing changes", async () => {
  const refused = await run(["spade", "on", "--json"]);
  expect(refused.code).toBe(4);
  expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, code: "turned_off" });
  expect(JSON.parse((await run(["spade", "status", "--json"])).stdout)).toMatchObject({
    beta: false,
    enabled: false,
  });
});

test("a bad config value is a usage error (64) naming the argument, and saves nothing", async () => {
  const bad = await run(["config", "set", "threads.sortBy", "random", "--json"]);
  expect(bad.code).toBe(64);
  expect(JSON.parse(bad.stdout)).toMatchObject({
    ok: false,
    code: "bad_argument",
    argument: "VALUE",
  });
  expect(
    JSON.parse((await run(["config", "get", "threads.sortBy", "--json"])).stdout),
  ).toMatchObject({ value: "activity" });
});
