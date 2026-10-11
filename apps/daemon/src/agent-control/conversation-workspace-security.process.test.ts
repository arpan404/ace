import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentControlOperation } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { shellQuote } from "../workspace-scripts.ts";
import { createConversationStarts } from "./conversations.ts";
import { hostileWorkspace } from "./workspace-security-test-support.ts";

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
