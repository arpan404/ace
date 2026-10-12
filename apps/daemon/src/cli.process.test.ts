import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
function invoke(home: string, args: string[], stdin = "") {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ACE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  child.stdin.end(stdin);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
const admission = z.object({ threadId: z.string(), commandId: z.string() });
test("piped prompts create one provider run when the public CLI retries an idempotency key", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const args = [
      "run",
      "--provider",
      "codex",
      "--project",
      f.workspace,
      "--idempotency-key",
      "cli-once",
      "--json",
    ];
    const first = await invoke(home, args, "Synthetic CLI prompt");
    expect(first.code, first.stderr).toBe(0);
    const created = admission.parse(JSON.parse(first.stdout));
    const second = await invoke(home, args, "Synthetic CLI prompt");
    expect(second.code, second.stderr).toBe(0);
    expect(admission.parse(JSON.parse(second.stdout)).threadId).toBe(created.threadId);
    await f.daemon.engine?.flush();
    expect(f.h.inputs.get(ThreadId.parse(created.threadId))).toEqual(["Synthetic CLI prompt"]);
    const read = await invoke(home, ["thread", "read", created.threadId, "--json"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      thread: { id: created.threadId },
      items: expect.any(Array),
    });
  } finally {
    await f.daemon.close();
  }
});
test("whole-tree CLI wait times out while a delegated child remains working", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const spawned = await invoke(home, [
      "task",
      "spawn",
      "Synthetic child",
      "--parent",
      f.caller.threadId,
      "--provider",
      "claude",
      "--idempotency-key",
      "child-once",
      "--json",
    ]);
    expect(spawned.code, spawned.stderr).toBe(0);
    const child = z
      .object({ data: z.object({ threadId: z.string() }) })
      .parse(JSON.parse(spawned.stdout));
    await f.daemon.engine?.flush();
    const waiting = await invoke(home, [
      "thread",
      "wait",
      f.caller.threadId,
      "--tree",
      "--timeout",
      "2s",
      "--stream",
      "jsonl",
      "--json",
    ]);
    expect(waiting.code, waiting.stderr).toBe(3);
    const records = waiting.stdout
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "status",
        status: { state: "working", agents: expect.any(Number) },
      }),
    );
    expect(records.at(-1)).toMatchObject({ status: "timeout" });
    const status = await invoke(home, ["task", "status", child.data.threadId, "--json"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: "working" });
    const retried = await invoke(home, [
      "task",
      "spawn",
      "Synthetic child",
      "--parent",
      f.caller.threadId,
      "--provider",
      "claude",
      "--idempotency-key",
      "child-once",
      "--json",
    ]);
    expect(JSON.parse(retried.stdout)).toMatchObject({ data: { threadId: child.data.threadId } });
  } finally {
    await f.daemon.close();
  }
});
test("machine-readable invalid invocations are refused without contacting a daemon", async () => {
  const output = await invoke("/unused-synthetic-home", ["unknown", "--json"]);
  expect(output.code).toBe(4);
  expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, status: "refused" });
});

test("CLI tree waits hand back control for a descendant approval instead of reporting completion", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const spawned = await invoke(home, [
      "task",
      "spawn",
      "Synthetic approval",
      "--parent",
      f.caller.threadId,
      "--provider",
      "claude",
      "--json",
    ]);
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
    const waiting = await invoke(home, ["thread", "wait", f.caller.threadId, "--tree", "--json"]);
    expect(waiting.code, waiting.stderr).toBe(2);
    expect(JSON.parse(waiting.stdout)).toMatchObject({ status: "needs-human" });
    const read = await invoke(home, ["thread", "read", child, "--json"]);
    const pending = z
      .object({ interactions: z.array(z.object({ id: z.string() })).min(1) })
      .parse(JSON.parse(read.stdout));
    const approved = await invoke(home, [
      "thread",
      "approve",
      child,
      "--interaction",
      pending.interactions[0]?.id ?? "missing",
      "--json",
    ]);
    expect(approved.code, approved.stderr).toBe(0);
  } finally {
    await f.daemon.close();
  }
});
