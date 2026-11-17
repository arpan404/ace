/**
 * The interactive home in a real pseudo-terminal (ADR 0176 §9, §Tests). A process test because
 * raw mode, the inline redraw and restoring the terminal after a signal only exist with a real
 * terminal on the other end; the views and reducers have their own unit tests.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadId } from "@ace/protocol";
import { spawnNativePty } from "@ace/terminal";
import { z } from "zod";
import { expect, test } from "vitest";
import { daemonFixture } from "../../agent-control/daemon-test-support.ts";

const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));

/** The person's terminal: the CLI's environment with nothing from this machine's own ace. */
function environment(home: string, empty: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    ACE_HOME: home,
    HOME: empty,
    TERM: "xterm-256color",
    NO_COLOR: "1",
    ACE_LOG_LEVEL: "silent",
  };
}

function openPty(home: string, empty: string, args: string[] = []) {
  const pty = spawnNativePty(process.execPath, [cli, ...args], {
    cwd: empty,
    cols: 100,
    rows: 30,
    env: environment(home, empty),
  });
  let output = "";
  const exited = new Promise<number | null>((resolve) => {
    pty.onExit((input) => {
      const code =
        typeof input === "object" && input !== null ? Reflect.get(input, "exitCode") : undefined;
      resolve(typeof code === "number" ? code : null);
    });
  });
  pty.onData((input) => {
    output +=
      typeof input === "string"
        ? input
        : input instanceof Uint8Array
          ? Buffer.from(input).toString("utf8")
          : "";
  });
  const waitFor = async (text: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!output.includes(text)) {
      if (Date.now() > deadline)
        throw new Error(
          `Never saw ${JSON.stringify(text)} in ${JSON.stringify(output.slice(-2000))}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { pty, exited, waitFor, output: () => output };
}

function invoke(home: string, empty: string, args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: environment(home, empty),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => (stdout += bytes.toString()));
  child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
  child.stdin.end();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the home in a terminal opens, attaches, answers an approval and gives the terminal back after SIGINT", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const empty = mkdtempSync(join(tmpdir(), "ace-home-pty-"));
  try {
    // The approval sits on a scripted Claude child, whose script takes a resolution as a real
    // provider does; the daemon then closes the request itself.
    const spawned = await invoke(home, empty, [
      "task",
      "spawn",
      "Synthetic approval",
      "--parent",
      f.caller.threadId,
      "--provider",
      "claude",
      "--role",
      "Synthetic approval",
      "--json",
    ]);
    expect(spawned.code, spawned.stderr).toBe(0);
    const child = ThreadId.parse(
      z.object({ data: z.object({ threadId: z.string() }) }).parse(JSON.parse(spawned.stdout)).data
        .threadId,
    );
    await f.daemon.engine?.flush();
    await f.h.emit(child, {
      type: "interaction.opened",
      agent: "root",
      interaction: "permission",
      blocking: true,
      request: {
        kind: "approval",
        title: "Synthetic permission",
        options: [
          { id: "yes", label: "Allow once", kind: "allow_once" },
          { id: "no", label: "Deny", kind: "deny" },
        ],
      },
    });
    await f.daemon.engine?.flush();
    const terminal = openPty(home, empty);
    // The home: the thread that needs the person carries the mark, with the keys under it.
    await terminal.waitFor("◆");
    await terminal.waitFor("q quit");
    // r walks the open requests; the strip offers the answers as keys.
    terminal.pty.write("r");
    await terminal.waitFor("y Allow once");
    terminal.pty.write("y");
    // The decision is claimed only once the request closed in the daemon.
    await terminal.waitFor("Allow once: Synthetic permission");
    const read = await invoke(home, empty, ["thread", "show", child, "--json"]);
    expect(read.code, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout).interactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "resolved",
          resolution: { kind: "approval", optionId: "yes" },
        }),
      ]),
    );
    // Back home, Enter attaches to the selected thread: its composer and keys draw.
    terminal.pty.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 200));
    terminal.pty.write("\r");
    await terminal.waitFor("esc home · /steer");
    // A signal from outside: the terminal comes back (paste mode off, cursor shown) with one
    // line saying where the person was, and the exit code says it was interrupted.
    process.kill(terminal.pty.pid, "SIGINT");
    expect(await terminal.exited).toBe(130);
    const output = terminal.output();
    expect(output.lastIndexOf("\x1b[?2004l")).toBeGreaterThan(output.lastIndexOf("\x1b[?2004h"));
    expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.lastIndexOf("\x1b[?25l"));
    expect(output).toMatch(/Detached from .+\. Back with ace chat \S+\./);
  } finally {
    await f.daemon.close();
    rmSync(empty, { recursive: true, force: true });
  }
});

test("without a terminal nothing prompts and no TUI draws: bare ace prints the overview and chat keeps its lines", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const empty = mkdtempSync(join(tmpdir(), "ace-home-pipe-"));
  try {
    const bare = await invoke(home, empty, []);
    expect(bare.code, bare.stderr).toBe(0);
    expect(bare.stdout).toContain("ace help");
    const chat = await invoke(home, empty, ["chat"]);
    expect(chat.code, chat.stderr).toBe(0);
    for (const run of [bare, chat]) {
      // No raw-mode region: no bracketed paste, no hidden cursor, no line clearing.
      expect(run.stdout).not.toContain("\x1b[?2004h");
      expect(run.stdout).not.toContain("\x1b[?25l");
      expect(run.stdout).not.toContain("\x1b[2K");
    }
    expect(chat.stdout).toContain("Chat closed.");
  } finally {
    await f.daemon.close();
    rmSync(empty, { recursive: true, force: true });
  }
});
