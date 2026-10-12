import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { AgentControlOperation, SearchResults, ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { createConversationStarts } from "./conversations.ts";
import { repository } from "../thread-creation-test-support.ts";
import { setup, wakes } from "./test-support.ts";

const signal = () => new AbortController().signal;
function conversation(requestId: string, workspace: unknown = { kind: "project" }) {
  return AgentControlOperation.parse({
    op: "thread.start",
    requestId,
    title: "Conversation",
    text: "Build this",
    provider: "claude",
    model: "chosen-model",
    options: { effort: "high" },
    workspace,
  });
}

test("an ordinary conversation has durable owner authority without child status or completion wakeups", async () => {
  const h = setup();
  const parent = await h.parent();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    const context = { store: h.store, services: { workspaceActions: runtime }, signal: signal() };
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(context, h.service, h.service.conversations),
    });
    const request = conversation("ordinary");
    expect((await port.execute(parent, request, signal())).ok).toBe(true);
    const thread = h.store.listThreads().find((row) => row.id !== parent.threadId);
    if (!thread) throw new Error("Conversation missing");
    expect(await port.execute(parent, request, signal())).toMatchObject({
      ok: true,
      data: { threadId: thread.id },
    });
    expect(h.store.listThreads()).toHaveLength(2);
    await h.engine.flush();
    await h.complete(parent.threadId, "parent finished");
    expect(h.store.getThread(parent.threadId)?.status.state).toBe("done");
    expect(h.store.getThread(thread.id)?.status.state).toBe("working");
    expect(
      Object.values(h.store.snapshotThread(parent.threadId).agents).some(
        (agent) => agent.childThreadId === thread.id,
      ),
    ).toBe(false);
    expect(h.contexts.get(thread.id)).toMatchObject({
      permissionMode: "default",
      model: "chosen-model",
      options: { effort: "high" },
    });
    expect(
      await port.execute(
        parent,
        AgentControlOperation.parse({ op: "agent.result", threadId: thread.id }),
        signal(),
      ),
    ).toMatchObject({ ok: false, code: "forbidden" });
    await h.complete(thread.id, "conversation finished");
    h.clock.advance(1100);
    await h.engine.flush();
    expect(wakes(h.events, parent.threadId)).toHaveLength(0);
    expect(
      await port.execute(
        parent,
        AgentControlOperation.parse({
          op: "thread.message",
          threadId: thread.id,
          requestId: "continue",
          text: "Continue",
        }),
        signal(),
      ),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.inputs.get(thread.id)?.at(-1)).toBe("Continue");
    expect(
      await port.execute(
        parent,
        conversation("ordinary", { kind: "existing_worktree", path: h.home }),
        signal(),
      ),
    ).toMatchObject({ ok: false, code: "invalid" });
  } finally {
    await runtime.close();
  }
});

test("conversation ownership and launch deduplication survive reopening SQLite", async () => {
  const h = setup();
  const parent = await h.parent();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  const request = conversation("durable");
  const port = createAgentControlPort(h.store, h.service, {
    startConversation: createConversationStarts(
      { store: h.store, services: { workspaceActions: runtime }, signal: signal() },
      h.service,
      h.service.conversations,
    ),
  });
  const reply = await port.execute(parent, request, signal());
  await h.engine.flush();
  const thread = h.store.listThreads().find((row) => row.id !== parent.threadId);
  if (!thread) throw new Error("Conversation missing");
  await h.complete(thread.id, "saved");
  await h.complete(parent.threadId, "saved parent");
  await runtime.close();
  await h.close();
  const reopened = setup({}, h.dbPath);
  const secondRuntime = new WorkspaceRuntime(
    reopened.store,
    join(reopened.home, "owned"),
    reopened.clock.now,
  );
  try {
    const second = createAgentControlPort(reopened.store, reopened.service, {
      startConversation: createConversationStarts(
        { store: reopened.store, services: { workspaceActions: secondRuntime }, signal: signal() },
        reopened.service,
        reopened.service.conversations,
      ),
    });
    expect(await second.execute(reopened.caller(parent.threadId), request, signal())).toEqual(
      reply,
    );
    expect(
      await second.execute(
        reopened.caller(parent.threadId),
        AgentControlOperation.parse({
          op: "thread.message",
          threadId: thread.id,
          requestId: "after-restart",
          text: "New work",
        }),
        signal(),
      ),
    ).toMatchObject({ ok: true });
    await reopened.engine.flush();
    expect(reopened.inputs.get(thread.id)).toContain("New work");
    expect(reopened.store.listThreads()).toHaveLength(2);
  } finally {
    await secondRuntime.close();
  }
});

test("thread discovery pages only the caller's project and rejects a cursor from another query", async () => {
  const h = setup();
  const parent = await h.parent();
  for (let index = 0; index < 3; index++)
    h.service.command(`thread-${index}`, {
      type: "thread.prepare",
      workspaceId:
        h.store.getThread(parent.threadId)?.workspaceId ??
        (() => {
          throw new Error("Workspace missing");
        })(),
      provider: "codex",
      threadId: ThreadId.parse(`topic-${index}`),
      title: `Catalog topic ${index}`,
    });
  const outside = h.store.createWorkspace(join(h.home, "outside"), "outside");
  await mkdir(join(h.home, "outside"));
  h.service.command("outside-topic", {
    type: "thread.prepare",
    workspaceId: outside,
    provider: "codex",
    threadId: ThreadId.parse("outside-topic"),
    title: "Catalog outside topic",
  });
  // Read-only project search must be scoped before ranking, not filtered afterward.
  const ownThread = h.store.listThreads().find((row) => row.id === parent.threadId);
  if (!ownThread) throw new Error("Parent missing");
  h.store.appendEvents(parent.threadId, [
    { type: "thread.updated", title: "Catalog topic parent" },
  ]);
  h.store.search.flush();
  const port = createAgentControlPort(h.store, h.service);
  const first = await port.execute(
    parent,
    AgentControlOperation.parse({ op: "threads.list", query: "Catalog", limit: 1 }),
    signal(),
  );
  const page = SearchResults.parse(first.data);
  expect(page.hits).toHaveLength(1);
  expect(page.hits[0]?.workspaceId).toBe(ownThread.workspaceId);
  expect(page.cursor).not.toBeNull();
  const next = SearchResults.parse(
    (
      await port.execute(
        parent,
        AgentControlOperation.parse({
          op: "threads.list",
          query: "Catalog",
          limit: 1,
          cursor: page.cursor,
        }),
        signal(),
      )
    ).data,
  );
  expect(next.hits[0]?.threadId).not.toBe(page.hits[0]?.threadId);
  expect(next.hits[0]?.workspaceId).toBe(ownThread.workspaceId);
  expect(
    await port.execute(
      parent,
      AgentControlOperation.parse({ op: "threads.list", workspaceId: outside }),
      signal(),
    ),
  ).toMatchObject({ ok: false, code: "forbidden" });
  await expect(
    port.execute(
      parent,
      AgentControlOperation.parse({ op: "threads.list", query: "unrelated", cursor: page.cursor }),
      signal(),
    ),
  ).rejects.toThrow("search_invalid_query");
});

test("an ordinary conversation can start in a registered worktree while an unrelated caller cannot control it", async () => {
  const h = setup();
  await repository(h.home);
  const parent = await h.parent();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    const path = join(h.home, "existing");
    await runtime.git.createWorktree({ repo: h.home, path, baseRef: "HEAD", branch: "existing" });
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(
        { store: h.store, services: { workspaceActions: runtime }, signal: signal() },
        h.service,
        h.service.conversations,
      ),
    });
    expect(
      (
        await port.execute(
          parent,
          conversation("existing", { kind: "existing_worktree", path }),
          signal(),
        )
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    const thread = h.store.listThreads().find((row) => row.id !== parent.threadId);
    if (!thread) throw new Error("Conversation missing");
    expect(h.contexts.get(thread.id)?.cwd).toBe(path);
    const sibling = h.delegate(parent, "unrelated");
    await h.engine.flush();
    expect(
      await port.execute(
        h.caller(sibling.childId),
        AgentControlOperation.parse({
          op: "thread.interrupt",
          threadId: thread.id,
          requestId: "stop",
        }),
        signal(),
      ),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await port.execute(
        parent,
        AgentControlOperation.parse({
          op: "thread.interrupt",
          threadId: thread.id,
          requestId: "stop",
        }),
        signal(),
      ),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.store.getThread(thread.id)?.status.state).toBe("done");
  } finally {
    await runtime.close();
  }
});

test("restart delivery is accepted once and model configuration retains provider/account and permission ancestry", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "restart");
  await h.engine.flush();
  const port = createAgentControlPort(h.store, h.service);
  const operation = AgentControlOperation.parse({
    op: "thread.message",
    threadId: child.childId,
    requestId: "replace",
    text: "Replacement",
    delivery: "restart",
  });
  expect((await port.execute(parent, operation, signal())).ok).toBe(true);
  expect((await port.execute(parent, operation, signal())).ok).toBe(true);
  await h.engine.flush();
  expect(h.inputs.get(child.childId)?.filter((text) => text === "Replacement")).toHaveLength(1);
  await h.complete(child.childId, "replacement done");
  const before = h.store.getThread(child.childId);
  expect(
    await port.execute(
      parent,
      AgentControlOperation.parse({
        op: "thread.configure",
        threadId: child.childId,
        requestId: "model",
        model: "chosen-model",
        options: { effort: "high" },
      }),
      signal(),
    ),
  ).toMatchObject({ ok: true });
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.execution).toMatchObject({
    provider: before?.provider,
    model: "chosen-model",
    options: { effort: "high" },
  });
  expect(h.store.getThread(child.childId)?.permission?.effective).toBe(
    before?.permission?.effective,
  );
  await expect(
    port.execute(
      parent,
      AgentControlOperation.parse({
        op: "thread.configure",
        threadId: child.childId,
        requestId: "invalid-model",
        model: "missing-model",
      }),
      signal(),
    ),
  ).rejects.toThrow();
});

test("conversation launches and reopened work compete with children for the same capacity", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(
        { store: h.store, services: { workspaceActions: runtime }, signal: signal() },
        h.service,
        h.service.conversations,
      ),
    });
    expect((await port.execute(parent, conversation("capacity"), signal())).ok).toBe(true);
    await h.engine.flush();
    const thread = h.store.listThreads().find((row) => row.id !== parent.threadId);
    if (!thread) throw new Error("Conversation missing");
    expect(() => h.delegate(parent, "too-many")).toThrow();
    await h.complete(thread.id, "finished");
    const child = h.delegate(parent, "now-admitted");
    await h.engine.flush();
    expect(
      await port.execute(
        parent,
        AgentControlOperation.parse({
          op: "thread.message",
          threadId: thread.id,
          requestId: "reopen",
          text: "More work",
        }),
        signal(),
      ),
    ).toMatchObject({ ok: false });
    await h.complete(child.childId, "finished child");
    expect(
      (
        await port.execute(
          parent,
          AgentControlOperation.parse({
            op: "thread.message",
            threadId: thread.id,
            requestId: "reopen-after-capacity",
            text: "More work",
          }),
          signal(),
        )
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.inputs.get(thread.id)?.at(-1)).toBe("More work");
  } finally {
    await runtime.close();
  }
});

test("a top-level conversation starts in its new worktree and retries preserve the same checkout", async () => {
  const h = setup();
  await repository(h.home);
  const parent = await h.parent();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    const port = createAgentControlPort(h.store, h.service, {
      startConversation: createConversationStarts(
        { store: h.store, services: { workspaceActions: runtime }, signal: signal() },
        h.service,
        h.service.conversations,
      ),
    });
    const request = conversation("new-checkout", { kind: "new_worktree", base: { ref: "main" } });
    const first = await port.execute(parent, request, signal());
    expect(first.ok).toBe(true);
    expect(await port.execute(parent, request, signal())).toEqual(first);
    await h.engine.flush();
    const thread = h.store.listThreads().find((row) => row.id !== parent.threadId);
    if (!thread) throw new Error("Conversation missing");
    expect(thread.workspaceId).toBe(h.store.getThread(parent.threadId)?.workspaceId);
    expect(h.contexts.get(thread.id)?.cwd).not.toBe(h.home);
    expect((await runtime.git.listWorktrees(h.home)).map((tree) => tree.path)).toContain(
      h.contexts.get(thread.id)?.cwd,
    );
    expect(h.inputs.get(thread.id)).toContain("Build this");
    expect(h.store.listThreads()).toHaveLength(2);
  } finally {
    await runtime.close();
  }
});
