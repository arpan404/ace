import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitService, spawnGitProcess } from "@ace/git";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { z } from "zod";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { invoke } from "../cli-test-support.ts";
import { MessageOrigin, ThreadId } from "@ace/protocol";
import { call, enroll, toolResult } from "./outside-test-support.ts";
const execute = promisify(execFile);
/** MessageOrigin's kinds before outside clients (09f641620), which older apps decode with. */
const PreviousOrigin = MessageOrigin.omit({ client: true }).extend({
  kind: z.enum([
    "person",
    "interaction_answer",
    "subagent_result",
    "handoff",
    "spawn",
    "parent_agent",
    "restart",
    "limit_resume",
    "queue",
    "steer",
    "automation",
    "schedule",
    "background_completion",
  ]),
});
/** Every `origin` object anywhere in a tool result. */
function originsIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(originsIn);
  if (typeof value !== "object" || value === null) return [];
  const own = Reflect.get(value, "origin");
  return [
    ...(typeof own === "object" && own !== null ? [own] : []),
    ...Object.entries(value).flatMap(([key, entry]) => (key === "origin" ? [] : originsIn(entry))),
  ];
}

test("revoking an external enrollment during workspace preparation prevents its child admission", async () => {
  const entered = Promise.withResolvers<ReturnType<typeof spawnGitProcess>>();
  let release = "";
  const git = new GitService({
    processRuntime: {
      spawn(command, args, options) {
        if (args.includes("worktree") && args.includes("list")) {
          // Holds workspace preparation open until the test releases it, then answers as Git.
          const child = spawnGitProcess(
            process.execPath,
            [
              "-e",
              `const [marker, git, ...args] = process.argv.slice(1);
              const fs = require("node:fs");
              const wait = setInterval(() => {
                if (!fs.existsSync(marker)) return;
                clearInterval(wait);
                const run = require("node:child_process").spawnSync(git, args, { stdio: "inherit" });
                process.exit(run.status ?? 1);
              }, 10);`,
              release,
              command,
              ...args,
            ],
            options,
          );
          entered.resolve(child);
          return child;
        }
        return spawnGitProcess(command, args, options);
      },
    },
  });
  const f = await daemonFixture(undefined, { workspaceActions: { gitService: git } });
  const client = new McpClient({ name: "synthetic-revoked-effect", version: "1" });
  let child: ReturnType<typeof spawnGitProcess> | undefined;
  try {
    await execute("git", ["init", f.h.home]);
    release = join(f.h.home, "daemon", "release-worktree-list");
    const output = await invoke(join(f.h.home, "daemon"), [
      "mcp",
      "enroll",
      "--scope",
      "operate",
      "--ttl",
      "1h",
      "--project",
      f.workspace,
      "--json",
    ]);
    const lease = z
      .object({ id: z.string(), url: z.url(), bearer: z.string() })
      .parse(JSON.parse(output.stdout));
    await client.connect(
      new StreamableHTTPClientTransport(new URL(lease.url), {
        requestInit: { headers: { authorization: `Bearer ${lease.bearer}` } },
      }),
    );
    const before = f.daemon.store.listThreads().map((thread) => thread.id);
    const effect = client
      .callTool({
        name: "ace_task_control",
        arguments: {
          operation: {
            op: "task.spawn",
            parentId: f.caller.threadId,
            request: {
              requestId: "revoked-effect",
              task: "synthetic",
              role: "revoked-enrollment-child",
              provider: "claude",
              // The project's own checkout: the one existing worktree a grant may name.
              workspace: { kind: "existing_worktree", path: f.h.home },
            },
          },
        },
      })
      .catch(() => ({ isError: true }));
    let settled = false;
    void effect.finally(() => (settled = true));
    child = await entered.promise;
    const exited = once(child, "close");
    // The spawn is still inside workspace preparation when the enrollment is revoked.
    expect(settled).toBe(false);
    const revoked = await invoke(join(f.h.home, "daemon"), ["mcp", "revoke", lease.id, "--json"]);
    expect(revoked.code, revoked.stderr).toBe(0);
    await writeFile(release, "");
    const result = await effect;
    expect(result.isError).toBe(true);
    await exited;
    await git.close();
    await f.daemon.engine?.flush();
    expect(f.daemon.store.listThreads().map((thread) => thread.id)).toEqual(before);
  } finally {
    child?.kill("SIGKILL");
    await client.close();
    await f.daemon.close();
  }
});

test("a grant, its token and an idempotent start survive a daemon restart", async () => {
  const f = await daemonFixture();
  let restarted: Awaited<ReturnType<typeof f.restart>> | undefined;
  try {
    const lease = await enroll(f, ["--scope", "operate", "--name", "Synthetic assistant"]);
    const start = {
      project: f.workspace,
      provider: "codex",
      text: "outside work",
      idempotencyKey: "restart-start",
    };
    const Started = z.object({ ok: z.literal(true), data: z.object({ threadId: ThreadId }) });
    const first = Started.parse(
      toolResult(await call(lease, "ace_thread_run", start)).structuredContent,
    );
    const threadId = first.data.threadId;
    await f.daemon.engine?.flush();
    // The thread and its first message name the client that sent them; neither carries a token.
    const read = await call(lease, "ace_thread_read", { threadId });
    expect(read.body).not.toContain(lease.bearer);
    const origins = originsIn(JSON.parse(read.body));
    expect(origins).toContainEqual(
      expect.objectContaining({
        kind: "person",
        client: { grantId: lease.id, name: "Synthetic assistant" },
      }),
    );
    // Apps from before outside clients read every origin, the client's included.
    for (const origin of origins) expect(PreviousOrigin.safeParse(origin).success).toBe(true);
    restarted = await f.restart();
    const client = { kind: "mcp_client", grantId: lease.id, name: "Synthetic assistant" };
    expect(restarted.store.getThread(threadId)?.startedByClient).toEqual(client);
    const listed = await invoke(join(f.h.home, "daemon"), ["mcp", "list", "--json"]);
    const list = z
      .object({
        url: z.url(),
        grants: z.array(z.object({ id: z.string(), started: z.array(z.string()) }).loose()),
      })
      .parse(JSON.parse(listed.stdout));
    expect(list.grants).toContainEqual(
      expect.objectContaining({ id: lease.id, started: [threadId] }),
    );
    // The same token works at the restarted endpoint, and the retried start runs once.
    const moved = { url: list.url, bearer: lease.bearer };
    const before = restarted.store.listThreads().length;
    const again = Started.parse(
      toolResult(await call(moved, "ace_thread_run", start)).structuredContent,
    );
    expect(again.data.threadId).toBe(threadId);
    expect(restarted.store.listThreads()).toHaveLength(before);
  } finally {
    await (restarted ?? f.daemon).close();
  }
});
