import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { join } from "node:path";
import { GitService, spawnGitProcess } from "@ace/git";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { z } from "zod";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { invoke } from "../cli-test-support.ts";
const execute = promisify(execFile);

test("revoking an external enrollment during workspace preparation prevents its child admission", async () => {
  const entered = Promise.withResolvers<ReturnType<typeof spawnGitProcess>>();
  const git = new GitService({
    processRuntime: {
      spawn(command, args, options) {
        if (args.includes("worktree") && args.includes("list")) {
          const child = spawnGitProcess(
            process.execPath,
            [
              "-e",
              `process.stdin.once('data', () => { console.log('worktree ' + process.cwd() + '\\nHEAD ' + '1'.repeat(40) + '\\nbranch refs/heads/main\\n'); process.exit(0); });`,
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
              role: "delegate",
              provider: "claude",
              workspace: { kind: "existing_worktree", path: f.h.home },
            },
          },
        },
      })
      .catch(() => ({ isError: true }));
    child = await entered.promise;
    const exited = once(child, "close");
    const revoked = await invoke(join(f.h.home, "daemon"), ["mcp", "revoke", lease.id, "--json"]);
    expect(revoked.code, revoked.stderr).toBe(0);
    child.stdin.end("\n");
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
