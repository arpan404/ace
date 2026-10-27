import { ThreadId } from "@ace/protocol";
import { spawn } from "node:child_process";
import { mkdir, stat, readFile } from "node:fs/promises";
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
        setup: z.string(),
        credentialFile: z.string(),
      })
      .parse(JSON.parse(output.stdout));
    expect(lease.claude + lease.codex + lease.setup).not.toContain(lease.bearer);
    expect(lease.claude).toContain("${ACE_MCP_TOKEN}");
    expect(lease.codex).toContain('bearer_token_env_var = "ACE_MCP_TOKEN"');
    expect((await stat(lease.credentialFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(lease.credentialFile, "utf8")).toBe(lease.bearer);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(lease.url), {
        requestInit: { headers: { authorization: `Bearer ${lease.bearer}` } },
      }),
    );
    const tools = await client.listTools();
    // ace capabilities names what the endpoint really serves, every listed tool included.
    const capabilities = await cli(home, ["capabilities", "--json"]);
    expect(capabilities.code, capabilities.stderr).toBe(0);
    const declared = z
      .object({ tools: z.object({ data: z.object({ externalMcp: z.array(z.string()) }) }) })
      .parse(JSON.parse(capabilities.stdout)).tools.data.externalMcp;
    expect(declared).toEqual(expect.arrayContaining(tools.tools.map((tool) => tool.name)));
    expect(declared).toEqual(expect.arrayContaining(["context", "tools_find", "ace_thread_send"]));
    expect(declared).not.toContain("ace_status");
    expect(tools.tools.map((tool) => tool.name)).toContain("ace_thread_read");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("ace_thread_send");
    // Groups an external client never gets say so, rather than blaming the daemon.
    const context = await client.callTool({ name: "context", arguments: { topics: ["status"] } });
    const groups = z
      .object({
        status: z.object({
          groups: z.array(
            z.object({ name: z.string(), enabled: z.boolean(), reason: z.string().optional() }),
          ),
        }),
      })
      .parse(context.structuredContent).status.groups;
    expect(groups).toContainEqual({
      name: "browser",
      enabled: false,
      reason: "ace offers this tool group to agents in ace threads, not to external MCP clients.",
    });
    expect(groups).toContainEqual(
      expect.objectContaining({
        name: "thread_control",
        reason: expect.stringContaining("This enrollment is read-only"),
      }),
    );
    for (const group of groups) expect(group.reason).not.toMatch(/not running/);
    const own = await client.callTool({
      name: "ace_thread_read",
      arguments: { threadId: f.caller.threadId },
    });
    expect(own.isError).not.toBe(true);
    await mkdir(join(f.h.home, "other"));
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
    const revoked = await cli(home, ["mcp", "revoke", lease.id]);
    expect(revoked.code, revoked.stderr).toBe(0);
    expect(revoked.stdout).toBe(`Revoked MCP enrollment ${lease.id}\n`);
    await expect(stat(lease.credentialFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(client.listTools()).rejects.toThrow();
    // Revoking it again says there's nothing by that id, rather than claiming success.
    const again = await cli(home, ["mcp", "revoke", lease.id, "--json"]);
    expect(again.code).toBe(4);
    expect(again.stdout + again.stderr).toContain(`No MCP enrollment ${lease.id}`);
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
      "--role",
      "Working child",
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
    expect(wait.code, wait.stderr).toBe(1);
    expect(JSON.parse(wait.stdout)).toMatchObject({ status: "failed", cancelled: [child] });
    const cancelled = await cli(home, ["task", "status", child, "--json"]);
    expect(cancelled.code, cancelled.stderr).toBe(1);
    expect(JSON.parse(cancelled.stdout)).toMatchObject({
      state: "cancelled",
      outcome: { outcome: "cancelled" },
    });
    const id = ThreadId.parse(child);
    const queue = f.daemon.engine?.queue(id);
    if (!queue) throw new Error("Missing queue");
    expect(
      f.controls.delegations.command("resume-after-kill", {
        type: "queue.resume",
        threadId: id,
        expectedRevision: queue.revision,
      }).ok,
    ).toBe(true);
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
