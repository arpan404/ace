/**
 * Attach in a real pseudo-terminal (ADR 0176 §9): a "Worked for" line printed into the
 * terminal's scrollback unfolds its steps on Enter. A process test because the inline region,
 * what reaches the scrollback and the keys only exist with a real terminal on the other end;
 * the attach model and the unfolded lines have their own unit tests.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { expect, test } from "vitest";
import { daemonFixture } from "../../agent-control/daemon-test-support.ts";
import { end, start } from "../../engine/test-support.ts";
import { environment, openPty } from "../pty-test-support.ts";

const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));

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

/** A child thread of the fixture's caller, on the scripted Claude. */
async function spawnChild(
  f: Awaited<ReturnType<typeof daemonFixture>>,
  home: string,
  empty: string,
  role: string,
) {
  const spawned = await invoke(home, empty, [
    "task",
    "spawn",
    role,
    "--parent",
    f.caller.threadId,
    "--provider",
    "claude",
    "--role",
    role,
    "--json",
  ]);
  expect(spawned.code, spawned.stderr).toBe(0);
  const id = ThreadId.parse(
    z.object({ data: z.object({ threadId: z.string() }) }).parse(JSON.parse(spawned.stdout)).data
      .threadId,
  );
  await f.daemon.engine?.flush();
  return id;
}

test("attached, Enter on a Worked for line unfolds its steps in the terminal", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const empty = mkdtempSync(join(tmpdir(), "ace-attach-unfold-"));
  try {
    const child = await spawnChild(f, home, empty, "Lint the repo");
    await f.h.emit(
      child,
      start,
      {
        type: "item.upsert",
        agent: "root",
        item: "lint",
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            kind: "shell",
            title: "Lint",
            status: "succeeded",
            detail: { kind: "shell", command: "bun run lint --quiet" },
          },
        },
      },
      {
        type: "item.upsert",
        agent: "root",
        item: "answer",
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "Lint is clean." }],
          complete: true,
        },
      },
      end,
    );
    await f.daemon.engine?.flush();
    const terminal = openPty(home, empty, ["chat", child]);
    await terminal.waitFor("Lint is clean.");
    await terminal.waitFor("↑ work");
    // Folded, the step is not on screen; ↑ reaches the line and Enter opens it.
    expect(terminal.output()).not.toContain("bun run lint --quiet");
    terminal.pty.write("\x1b[A");
    await terminal.waitFor("↵ unfold its steps");
    terminal.pty.write("\r");
    await terminal.waitFor("▾ ");
    await terminal.waitFor("bun run lint --quiet");
    process.kill(terminal.pty.pid, "SIGINT");
    expect(await terminal.exited).toBe(130);
  } finally {
    await f.daemon.close();
    rmSync(empty, { recursive: true, force: true });
  }
});
