import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentControlOperation, Command } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { repository, git } from "../thread-creation-test-support.ts";
import { shellQuote } from "../workspace-scripts.ts";
import { createWorkspaceDelegations } from "./workspaces.ts";
import { setup } from "./test-support.ts";
import {
  hostileWorkspace,
  partialCloneWorkspace,
  addLocalRemote,
} from "./workspace-security-test-support.ts";

test("a plan-mode delegation's selected ref cannot execute Git filters, LFS, hooks, fsmonitor or setup scripts, including after owner restart", async () => {
  const { h, markers, caller } = await hostileWorkspace();
  let runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    for (const marker of markers)
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
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
    expect(
      (
        await port.execute(
          caller,
          AgentControlOperation.parse({
            op: "delegate_task",
            requestId: "untrusted-ref",
            role: "Plan",
            task: "Inspect",
            provider: "claude",
            access: "read-only",
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

test("agent remote bases use local tracking refs and never execute a configured SSH transport", async () => {
  const h = setup();
  await repository(h.home);
  const marker = join(h.home, "ssh-executed");
  const script = join(h.home, "ssh.cjs");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  );
  await git("git", ["-C", h.home, "remote", "add", "origin", "ssh://example.invalid/hostile.git"]);
  await git("git", [
    "-C",
    h.home,
    "config",
    "core.sshCommand",
    `${shellQuote(process.execPath)} ${shellQuote(script)}`,
  ]);
  await git("git", ["-C", h.home, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  await h.catalog.refresh();
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
    const request = (ref: string) =>
      port.execute(
        caller,
        AgentControlOperation.parse({
          op: "delegate_task",
          requestId: ref,
          role: "Inspect",
          task: "Inspect cached remote",
          provider: "claude",
          workspace: { kind: "new_worktree", base: { ref, remote: "origin" } },
        }),
        new AbortController().signal,
      );
    expect((await request("main")).ok).toBe(true);
    await h.engine.flush();
    const child = h.store.listThreads().find((thread) => thread.id !== caller.threadId);
    const path = child && h.contexts.get(child.id)?.cwd;
    if (!path || path === h.home) throw new Error("Cached-ref checkout missing");
    expect(await readFile(join(path, "file.txt"), "utf8")).toBe(
      await readFile(join(h.home, "file.txt"), "utf8"),
    );
    await expect(request("not-fetched")).rejects.toThrow(/Fetch the branch first/);
    expect(h.store.listThreads()).toHaveLength(2);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runtime.close();
  }
});

test("plan-mode delegation from a cached partial-clone base fails on missing objects without executing its promisor transport", async () => {
  const { h, caller, marker } = await partialCloneWorkspace();
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
          requestId: "missing-blob",
          role: "Inspect",
          task: "Inspect locally",
          provider: "claude",
          access: "read-only",
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
    // Failed preparation must release admission as well as its physical worktree.
    const child = h.delegate(caller, "after-failure");
    await h.engine.flush();
    expect(h.inputs.get(child.childId)).toBeDefined();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runtime.close();
  }
});

test("a user can push a retained plan-mode child checkout without executing its hooks or filters", async () => {
  const { h, caller, markers } = await hostileWorkspace();
  const remote = await addLocalRemote(h.home);
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now, {
    git: { transportProtocols: ["file"] },
  });
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
    expect(
      (
        await port.execute(
          caller,
          AgentControlOperation.parse({
            op: "delegate_task",
            requestId: "push-child",
            provider: "claude",
            access: "read-only",
            role: "Inspect",
            task: "Inspect",
            workspace: { kind: "new_worktree", base: { ref: "main" } },
          }),
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    const child = h.store.listThreads().find((thread) => thread.id !== caller.threadId);
    if (!child?.details?.branch) throw new Error("Child checkout missing");
    expect(
      await runtime.execute(
        Command.parse({
          id: "user-push-child",
          deviceId: "desktop",
          payload: { type: "git.push", threadId: child.id, remote: "origin" },
        }),
      ),
    ).toMatchObject({ ok: true });
    const { stdout } = await git("git", [
      "-C",
      remote,
      "rev-parse",
      `refs/heads/${child.details.branch}`,
    ]);
    expect(stdout.trim()).toBe(
      await runtime.git.resolveCommit({ worktree: runtime.root(child.id), ref: "HEAD" }),
    );
    for (const marker of markers)
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runtime.close();
  }
});
