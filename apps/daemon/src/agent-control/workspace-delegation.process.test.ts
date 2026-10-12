import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentControlOperation } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { createWorkspaceDelegations } from "./workspaces.ts";
import { repository } from "../thread-creation-test-support.ts";
import { setup } from "./test-support.ts";

test("new-worktree delegation retains project identity and deduplicates the accepted workspace and child", async () => {
  const h = setup();
  await repository(h.home);
  const caller = await h.parent();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    const port = createAgentControlPort(h.store, h.service, {
      delegateWorkspace: createWorkspaceDelegations(
        {
          store: h.store,
          services: { workspaceActions: runtime },
          signal: new AbortController().signal,
        },
        h.service,
      ),
    });
    const request = AgentControlOperation.parse({
      op: "delegate_task",
      requestId: "worktree",
      task: "inspect",
      role: "inspector",
      provider: "claude",
      workspace: { kind: "new_worktree", base: { ref: "main" } },
    });
    const first = await port.execute(caller, request, new AbortController().signal);
    expect(first.ok).toBe(true);
    expect(await port.execute(caller, request, new AbortController().signal)).toEqual(first);
    await h.engine.flush();
    const child = h.store.listThreads().find((thread) => thread.id !== caller.threadId);
    if (!child) throw new Error("Child missing");
    expect(child.workspaceId).toBe(h.store.getThread(caller.threadId)?.workspaceId);
    expect(h.contexts.get(child.id)?.cwd).not.toBe(h.home);
    expect((await runtime.git.listWorktrees(h.home)).map((tree) => tree.path)).toContain(
      h.contexts.get(child.id)?.cwd,
    );
    expect(h.store.listThreads()).toHaveLength(2);
  } finally {
    await runtime.close();
  }
});

test("an existing-worktree request cannot nominate an unrelated execution directory", async () => {
  const h = setup();
  await repository(h.home);
  const caller = await h.parent();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    const port = createAgentControlPort(h.store, h.service, {
      delegateWorkspace: createWorkspaceDelegations(
        {
          store: h.store,
          services: { workspaceActions: runtime },
          signal: new AbortController().signal,
        },
        h.service,
      ),
    });
    await expect(
      port.execute(
        caller,
        AgentControlOperation.parse({
          op: "delegate_task",
          requestId: "outside",
          task: "inspect",
          role: "reader",
          provider: "claude",
          workspace: { kind: "existing_worktree", path: join(h.home, "..") },
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("workspace_not_registered");
    expect(h.store.listThreads()).toHaveLength(1);
    expect(await runtime.git.listWorktrees(h.home)).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});
