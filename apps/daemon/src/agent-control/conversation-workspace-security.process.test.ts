import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentControlOperation, Command } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { git } from "../thread-creation-test-support.ts";
import { shellQuote } from "../workspace-scripts.ts";
import { createConversationStarts } from "./conversations.ts";
import {
  hostileWorkspace,
  partialCloneWorkspace,
  addLocalRemote,
} from "./workspace-security-test-support.ts";

test("a plan-mode conversation's selected ref cannot execute Git filters, LFS, hooks, fsmonitor or setup scripts, including after owner restart", async () => {
  const { h, markers, caller } = await hostileWorkspace();
  let runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    for (const marker of markers)
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(
        {
          store: h.store,
          services: { workspaceActions: runtime },
          signal: new AbortController().signal,
        },
        h.service,
        h.service.conversations,
      ),
    });
    expect(
      (
        await port.execute(
          caller,
          AgentControlOperation.parse({
            op: "thread.start",
            requestId: "untrusted-ref",
            title: "Plan",
            text: "Inspect",
            provider: "claude",
            permissionMode: "plan",
            workspace: { kind: "new_worktree", base: { ref: "main" } },
          }),
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    const conversation = h.store.listThreads().find((thread) => thread.id !== caller.threadId);
    if (!conversation) throw new Error("Conversation missing");
    const path = h.contexts.get(conversation.id)?.cwd;
    if (!path || path === h.home) throw new Error("Selected checkout missing");
    expect(h.contexts.get(conversation.id)?.permissionMode).toBe("plan");
    expect(await readFile(join(path, "filtered.txt"), "utf8")).toBe("Raw selected-ref bytes\n");
    expect(await readFile(join(path, "lfs.txt"), "utf8")).toBe("Unexpanded LFS pointer\n");
    for (const marker of markers)
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.close();
    runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
    await writeFile(join(path, "file.txt"), "Changed after restart\n");
    expect((await runtime.git.status(path)).unstaged).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "file.txt" })]),
    );
    await expect(
      runtime.git.setupWorktree({
        worktree: path,
        command: `${shellQuote(process.execPath)} setup.cjs`,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    for (const marker of markers)
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runtime.close();
  }
});

test("plan-mode conversation preparation from a cached partial clone fails on missing objects without executing its promisor transport", async () => {
  const { h, caller, marker } = await partialCloneWorkspace();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(
        {
          store: h.store,
          services: { workspaceActions: runtime },
          signal: new AbortController().signal,
        },
        h.service,
        h.service.conversations,
      ),
    });
    await expect(
      port.execute(
        caller,
        AgentControlOperation.parse({
          op: "thread.start",
          requestId: "missing-blob",
          title: "Inspect",
          text: "Inspect locally",
          provider: "claude",
          permissionMode: "plan",
          workspace: { kind: "new_worktree", base: { ref: "main" } },
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/objects not available locally/i);
    await h.engine.flush();
    expect(h.store.listThreads()).toHaveLength(1);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await runtime.git.nonExecuting(() => runtime.git.listWorktrees(h.home))).map(
        (tree) => tree.path,
      ),
    ).toEqual([h.home]);
    expect(
      (
        await port.execute(
          caller,
          AgentControlOperation.parse({
            op: "thread.start",
            requestId: "after-failure",
            title: "Inspect",
            text: "Inspect locally",
            provider: "claude",
            permissionMode: "plan",
            workspace: { kind: "project" },
          }),
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    const conversation = h.store.listThreads().find((thread) => thread.id !== caller.threadId);
    if (!conversation) throw new Error("Conversation missing");
    expect(h.inputs.get(conversation.id)).toContain("Inspect locally");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runtime.close();
  }
});

test("a user can push a new-worktree conversation while its plan-mode Git execution guards remain active", async () => {
  const { h, caller, markers } = await hostileWorkspace();
  const remote = await addLocalRemote(h.home);
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now, {
    git: { transportProtocols: ["file"] },
  });
  try {
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(
        {
          store: h.store,
          services: { workspaceActions: runtime },
          signal: new AbortController().signal,
        },
        h.service,
        h.service.conversations,
      ),
    });
    expect(
      (
        await port.execute(
          caller,
          AgentControlOperation.parse({
            op: "thread.start",
            requestId: "push-conversation",
            provider: "claude",
            permissionMode: "plan",
            title: "Inspect",
            text: "Inspect",
            workspace: { kind: "new_worktree", base: { ref: "main" } },
          }),
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    const conversation = h.store.listThreads().find((thread) => thread.id !== caller.threadId);
    if (!conversation?.details?.branch) throw new Error("Conversation checkout missing");
    expect(
      await runtime.execute(
        Command.parse({
          id: "user-push-conversation",
          deviceId: "desktop",
          payload: { type: "git.push", threadId: conversation.id, remote: "origin" },
        }),
      ),
    ).toMatchObject({ ok: true });
    const { stdout } = await git("git", [
      "-C",
      remote,
      "rev-parse",
      `refs/heads/${conversation.details.branch}`,
    ]);
    expect(stdout.trim()).toBe(
      await runtime.git.resolveCommit({ worktree: runtime.root(conversation.id), ref: "HEAD" }),
    );
    for (const marker of markers)
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runtime.close();
  }
});
