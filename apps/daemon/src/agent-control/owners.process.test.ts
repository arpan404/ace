import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { readConfig, startDaemon } from "@ace/daemon";
import {
  AgentControlResult,
  ThreadId,
  WorkspaceId,
  type McpAttribution,
  type AgentControlOperation,
} from "@ace/protocol";
import { setup } from "./test-support.ts";

async function daemonFixture() {
  const h = setup();
  const daemon = await startDaemon({
    config: readConfig({
      ACE_HOME: join(h.home, "daemon"),
      ACE_PORT: "0",
      ACE_LOG_LEVEL: "silent",
    }),
    engine: { registry: h.registry, clock: h.clock },
    modelInstances: [],
  });
  const controls = daemon.agentControl;
  if (!controls || !daemon.engine) {
    await daemon.close();
    throw new Error("Agent control unavailable");
  }
  const workspace = daemon.store.createWorkspace(h.home, "project");
  const result = controls.delegations.command("create-parent", {
    type: "thread.create",
    workspaceId: workspace,
    provider: "codex",
    input: [{ type: "text", text: "plan" }],
  });
  await daemon.engine.flush();
  const thread = result.threadId ? daemon.store.getThread(result.threadId) : undefined;
  if (!thread?.rootAgentId) {
    await daemon.close();
    throw new Error("Parent unavailable");
  }
  const caller: McpAttribution = {
    sessionId: "test",
    threadId: thread.id,
    agentId: thread.rootAgentId,
  };
  return {
    h,
    daemon,
    controls,
    workspace,
    caller,
    call: (operation: AgentControlOperation) =>
      controls.port.execute(caller, operation, new AbortController().signal),
  };
}

test("daemon service manages owned projects, PR metadata and manual automation definitions", async () => {
  const f = await daemonFixture();
  try {
    expect(
      (await f.call({ op: "project.rename", workspaceId: f.workspace, name: "renamed" })).ok,
    ).toBe(true);
    expect((await f.call({ op: "project.read", workspaceId: f.workspace })).data).toMatchObject({
      name: "renamed",
    });
    const foreign = f.daemon.store.createWorkspace(join(f.h.home, "foreign"), "foreign");
    expect(await f.call({ op: "project.rename", workspaceId: foreign, name: "forbidden" })).toEqual(
      { ok: false, code: "forbidden" },
    );
    expect(
      (
        await f.call({
          op: "thread.link_pr",
          threadId: f.caller.threadId,
          url: "https://github.com/arpan404/ace/pull/123",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await f.call({ op: "thread.read", threadId: f.caller.threadId, limit: 1 })).data,
    ).toMatchObject({ metadata: { pr_url: "https://github.com/arpan404/ace/pull/123" } });
    const automation = {
      id: "owned-job",
      title: "job",
      enabled: true,
      workspace: f.h.home,
      provider: "codex",
      prompt: "review",
      worktree: false,
      trigger: { kind: "manual" },
      missedRun: "skip",
      concurrency: 1,
      jitterMs: 0,
    } satisfies import("@ace/protocol").Automation;
    expect(
      (
        await f.call({
          op: "automation.manage",
          request: { type: "automation.put", requestId: "put", automation },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await f.call({
          op: "automation.manage",
          request: { type: "automation.list", requestId: "list" },
        })
      ).data,
    ).toEqual([automation]);
    expect(
      await f.call({
        op: "automation.manage",
        request: {
          type: "automation.put",
          requestId: "unsafe-path",
          automation: { ...automation, workspace: "/" },
        },
      }),
    ).toEqual({ ok: false, code: "unsupported" });
    await f.call({
      op: "automation.manage",
      request: { type: "automation.remove", requestId: "remove", id: automation.id },
    });
    expect(
      (
        await f.call({
          op: "automation.manage",
          request: { type: "automation.list", requestId: "empty" },
        })
      ).data,
    ).toEqual([]);
  } finally {
    await f.daemon.close();
  }
});

test("preview controls expose only thread-owned registrations and closing invokes their owner", async () => {
  const f = await daemonFixture();
  try {
    let stopped = false;
    f.controls.previews.register(
      "dev",
      f.caller.threadId,
      { port: 3000, name: "dev", source: "launch" },
      async () => {
        stopped = true;
      },
    );
    expect((await f.call({ op: "preview.list", threadId: f.caller.threadId })).data).toEqual([
      { id: "dev", descriptor: { port: 3000, name: "dev", source: "launch" } },
    ]);
    expect(
      await f.call({ op: "preview.close", threadId: f.caller.threadId, previewId: "unowned-port" }),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(stopped).toBe(false);
    expect(
      (await f.call({ op: "preview.close", threadId: f.caller.threadId, previewId: "dev" })).ok,
    ).toBe(true);
    expect(stopped).toBe(true);
    expect((await f.call({ op: "preview.list", threadId: f.caller.threadId })).data).toEqual([]);
  } finally {
    await f.daemon.close();
  }
});

test("worktree handoff starts a linked independent thread in a real Git worktree and retry reuses it", async () => {
  const f = await daemonFixture();
  try {
    const git = promisify(execFile);
    await git("git", ["init"], { cwd: f.h.home });
    await writeFile(join(f.h.home, "README.md"), "ace handoff fixture\n");
    await git("git", ["add", "README.md"], { cwd: f.h.home });
    await git(
      "git",
      [
        "-c",
        "user.name=ace-test",
        "-c",
        "user.email=ace@example.invalid",
        "commit",
        "-m",
        "initial",
      ],
      { cwd: f.h.home },
    );
    const request = {
      op: "thread.handoff",
      threadId: f.caller.threadId,
      requestId: "handoff",
      branch: "ace-handoff",
    } satisfies AgentControlOperation;
    const result = await f.call(request);
    expect(result.ok).toBe(true);
    const child = z.object({ threadId: ThreadId, workspaceId: WorkspaceId }).parse(result.data);
    await f.daemon.engine?.flush();
    const path = f.daemon.store.getWorkspacePath(child.workspaceId);
    expect(f.h.contexts.get(child.threadId)?.cwd).toBe(path);
    expect(
      Object.values(f.daemon.store.snapshotThread(f.caller.threadId).agents).some(
        (agent) => agent.childThreadId === child.threadId,
      ),
    ).toBe(true);
    expect((await git("git", ["status", "--porcelain"], { cwd: path })).stdout).toBe("");
    expect((await f.call(request)).data).toMatchObject({ threadId: child.threadId });
    expect(f.daemon.store.listThreads()).toHaveLength(2);
  } finally {
    await f.daemon.close();
  }
});

async function mcpCall(connection: { url: string; bearer: string }, name: string, args: unknown) {
  const response = await fetch(connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  const envelope = z
    .object({ result: z.object({ structuredContent: AgentControlResult }) })
    .parse(await response.json());
  return envelope.result.structuredContent;
}

test("native session MCP leases delegate across providers and deny a child's attempt to interrupt its parent", async () => {
  const f = await daemonFixture();
  try {
    const parentConnection = f.h.contexts.get(f.caller.threadId)?.aceMcp;
    if (!parentConnection) throw new Error("MCP connection missing");
    const accepted = await mcpCall(parentConnection, "delegate_task", {
      requestId: "mcp-child",
      provider: "claude",
      model: "chosen",
      task: "Implement",
      role: "implementer",
      wait: false,
    });
    expect(accepted.ok).toBe(true);
    const child = z.object({ threadId: ThreadId }).parse(accepted.data);
    await f.daemon.engine?.flush();
    expect(f.daemon.store.getThread(child.threadId)?.provider).toBe("claude");
    const connection = f.h.contexts.get(child.threadId)?.aceMcp;
    if (!connection) throw new Error("Child MCP connection missing");
    expect(
      await mcpCall(connection, "ace_thread_interrupt", {
        threadId: f.caller.threadId,
        requestId: "forbidden",
      }),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(
      (
        await mcpCall(parentConnection, "ace_thread_interrupt", {
          threadId: child.threadId,
          requestId: "cancel",
        })
      ).ok,
    ).toBe(true);
    await f.daemon.engine?.flush();
    expect(
      await f.controls.delegations.wait(f.caller, child.threadId, new AbortController().signal),
    ).toMatchObject({ outcome: "cancelled" });
  } finally {
    await f.daemon.close();
  }
});
