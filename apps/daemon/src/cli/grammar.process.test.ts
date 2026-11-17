import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliCommandTree, CliError } from "@ace/protocol/cli-output";
import { afterEach, expect, test } from "vitest";

// The real CLI against an empty temp home with no daemon: what works with ace down (ADR 0092),
// what bare `ace` does off a terminal, and how a wrong command line exits.
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function emptyHome() {
  const root = await mkdtemp(join(tmpdir(), "ace-cli-grammar-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, env: { HOME: root, USERPROFILE: root, ACE_HOME: join(root, "ace") } };
}

function run(env: Record<string, string>, args: string[], command = process.execPath) {
  const child = spawn(command, command === process.execPath ? [cli, ...args] : args, {
    env: { ...process.env, ACE_THREAD_ID: undefined, ACE_NO_INPUT: undefined, ...env },
    // `script` needs a stdin it can read terminal settings from: /dev/null, not a socket.
    stdio: [command === process.execPath ? "pipe" : "ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (bytes: Buffer) => (stdout += bytes.toString()));
  child.stderr?.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
  child.stdin?.end();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("bare ace without a terminal prints the overview, exits 0 and starts nothing", async () => {
  const { root, env } = await emptyHome();
  const output = await run(env, []);
  expect(output.code, output.stderr).toBe(0);
  expect(output.stdout).toContain("ace help COMMAND for more.");
  expect(existsSync(join(root, "ace", "daemon-endpoint"))).toBe(false);
  expect(existsSync(join(root, "ace", "daemon.lock"))).toBe(false);
});

test("help, version, completion and doctor's help work with ace down", async () => {
  const { root, env } = await emptyHome();
  for (const args of [["help"], ["help", "thread", "send"], ["version"], ["completion", "zsh"]]) {
    const output = await run(env, args);
    expect(output.code, `${args.join(" ")}: ${output.stderr}`).toBe(0);
    expect(output.stdout.length).toBeGreaterThan(0);
  }
  const doctor = await run(env, ["doctor", "--help"]);
  expect(doctor.code).toBe(0);
  expect(doctor.stdout).toContain("ace doctor");
  const tree = await run(env, ["help", "--json"]);
  expect(CliCommandTree.parse(JSON.parse(tree.stdout)).commands.length).toBeGreaterThan(50);
  // None of them started or reached for a daemon.
  expect(await readdir(root)).not.toContain("daemon-endpoint");
});

test("a wrong command line exits 64 with the nearest command, as one CliError with --json", async () => {
  const { env } = await emptyHome();
  const typo = await run(env, ["thraed", "list"]);
  expect(typo.code).toBe(64);
  expect(typo.stderr).toBe("✕ ace has no command thraed.\n  Did you mean ace thread?\n");
  const json = await run(env, ["thread", "list", "--frob", "--json"]);
  expect(json.code).toBe(64);
  expect(CliError.parse(JSON.parse(json.stdout))).toMatchObject({
    status: "usage",
    code: "unknown_flag",
  });
});

test("a command that needs the daemon says ace isn't running, exit 4, never a file error", async () => {
  const { env } = await emptyHome();
  const output = await run(env, ["thread", "list"]);
  expect(output.code).toBe(4);
  expect(output.stderr).toBe("✕ ace isn't running.\n  Start it with ace start, or open the app.\n");
});

test("a missing argument is a usage error off a terminal, never a prompt", async () => {
  const { env } = await emptyHome();
  const output = await run(env, ["thread", "show"]);
  expect(output.code).toBe(64);
  expect(output.stderr).toContain("ace thread show needs THREAD.");
});

// `script` gives the CLI a real terminal on macOS and Linux.
test.skipIf(process.platform === "win32")(
  "an old spelling works with a one-line notice on a terminal, and none in a pipe",
  async () => {
    const { env } = await emptyHome();
    const line = [process.execPath, cli, "threads", "list"];
    const args =
      process.platform === "darwin"
        ? ["-q", "/dev/null", ...line]
        : ["-qec", line.map((word) => `'${word}'`).join(" "), "/dev/null"];
    const terminal = await run(env, args, "script");
    expect(terminal.stdout).toContain("ace threads list is now ace thread list.");
    // It still ran the command: here, the daemon is down.
    expect(terminal.stdout).toContain("ace isn't running.");
    const piped = await run(env, ["threads", "list"]);
    expect(piped.stderr).not.toContain("is now");
  },
);
