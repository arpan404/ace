import { ThreadId } from "@ace/protocol";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
function cli(home: string, args: string[]) {
  const child = spawn(process.execPath, [new URL("./cli.ts", import.meta.url).pathname, ...args], {
    env: { ...process.env, ACE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
test("external read enrollment exposes scoped reads, hides mutations and loses authority immediately on revoke", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const client = new McpClient({ name: "synthetic-external", version: "1" });
  try {
    const output = await cli(home, [
      "mcp",
      "enroll",
      "--scope",
      "read",
      "--ttl",
      "1h",
      "--project",
      f.workspace,
      "--json",
    ]);
    expect(output.code, output.stderr).toBe(0);
    const lease = z
      .object({
        id: z.string(),
        url: z.url(),
        bearer: z.string(),
        claude: z.string(),
        codex: z.string(),
      })
      .parse(JSON.parse(output.stdout));
    await client.connect(
      new StreamableHTTPClientTransport(new URL(lease.url), {
        requestInit: { headers: { authorization: `Bearer ${lease.bearer}` } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("ace_thread_read");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("ace_thread_send");
    const own = await client.callTool({
      name: "ace_thread_read",
      arguments: { threadId: f.caller.threadId },
    });
    expect(own.isError).not.toBe(true);
    const otherWorkspace = f.daemon.store.createWorkspace(join(f.h.home, "other"), "other");
    const other = f.controls.delegations.command("other", {
      type: "thread.prepare",
      threadId: ThreadId.parse("other-thread"),
      workspaceId: otherWorkspace,
      title: "Other",
      provider: "codex",
    });
    if (!other.ok) throw new Error("Other workspace setup failed");
    const denied = await client.callTool({
      name: "ace_thread_read",
      arguments: { threadId: ThreadId.parse("other-thread") },
    });
    expect(denied.isError).toBe(true);
    const listed = await cli(home, ["mcp", "list", "--json"]);
    expect(listed.stdout).not.toContain(lease.bearer);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      enrollments: [expect.objectContaining({ id: lease.id, scope: "read" })],
    });
    const revoked = await cli(home, ["mcp", "revoke", lease.id, "--json"]);
    expect(revoked.code, revoked.stderr).toBe(0);
    await expect(client.listTools()).rejects.toThrow();
  } finally {
    await client.close();
    await f.daemon.close();
  }
});
test("kill-all closes selected provider sessions and a receipt retry cannot kill later work", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const spawned = await cli(home, [
      "task",
      "spawn",
      "Working child",
      "--parent",
      f.caller.threadId,
      "--provider",
      "claude",
      "--json",
    ]);
    expect(spawned.code, spawned.stderr).toBe(0);
    const child = z
      .object({ data: z.object({ threadId: z.string() }) })
      .parse(JSON.parse(spawned.stdout)).data.threadId;
    await f.daemon.engine?.flush();
    const stopped = await cli(home, [
      "kill-all",
      "--thread",
      child,
      "--idempotency-key",
      "stop-once",
      "--json",
    ]);
    expect(stopped.code, stopped.stderr).toBe(0);
    const wait = await cli(home, ["thread", "wait", child, "--tree", "--timeout", "2s", "--json"]);
    expect([0, 1]).toContain(wait.code);
    const followup = await cli(home, ["thread", "send", child, "A later generation", "--json"]);
    expect(followup.code, followup.stderr).toBe(0);
    await f.daemon.engine?.flush();
    const retry = await cli(home, [
      "kill-all",
      "--thread",
      child,
      "--idempotency-key",
      "stop-once",
      "--json",
    ]);
    expect(retry.code, retry.stderr).toBe(0);
    const status = await cli(home, ["task", "status", child, "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: "working" });
  } finally {
    await f.daemon.close();
  }
});
