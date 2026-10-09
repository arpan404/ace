import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentId, ItemId, Thread, ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Store } from "./store.ts";

test("drafts retain their message fact across metadata changes and restarts", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-sent-message-"));
  const path = join(home, "store.sqlite");
  let store = new Store(path);
  try {
    const workspace = store.createWorkspace("/tmp/synthetic-project", "Project", 1);
    const thread = Thread.parse({
      id: "draft",
      workspaceId: workspace,
      title: "New thread",
      provider: "opencode",
      status: { state: "new" },
      hasSentMessage: false,
      createdAt: 1,
      updatedAt: 1,
    });
    store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
    store.appendEvents(thread.id, [{ type: "thread.updated", title: "Renamed draft" }], 2);
    expect(store.getThread(thread.id)?.hasSentMessage).toBe(false);
    store.appendEvents(
      thread.id,
      [
        {
          type: "item.created",
          item: {
            id: ItemId.parse("synthetic"),
            agentId: AgentId.parse("root"),
            type: "message",
            role: "user",
            synthetic: true,
            parts: [{ type: "text", text: "Background update" }],
            complete: true,
            raw: [],
            createdAt: 3,
          },
        },
      ],
      3,
    );
    expect(store.getThread(thread.id)?.hasSentMessage).toBe(false);
    store.appendEvents(
      thread.id,
      [
        {
          type: "item.created",
          item: {
            id: ItemId.parse("message"),
            agentId: AgentId.parse("root"),
            type: "message",
            role: "user",
            synthetic: false,
            parts: [{ type: "text", text: "Hello" }],
            complete: true,
            raw: [],
            createdAt: 4,
          },
        },
      ],
      4,
    );
    expect(store.getThread(thread.id)?.hasSentMessage).toBe(true);
    await store.close();
    store = new Store(path);
    expect(store.getThread(ThreadId.parse("draft"))?.hasSentMessage).toBe(true);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("old empty and synthetic-only threads stay drafts while retained history proves a real sent message", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-old-drafts-"));
  const path = join(home, "store.sqlite");
  let store = new Store(path);
  try {
    const workspace = store.createWorkspace("/tmp/synthetic-project", "Project", 1);
    for (const id of ["empty", "synthetic-only", "with-history"]) {
      const thread = Thread.parse({
        id,
        workspaceId: workspace,
        title: "New thread",
        provider: "opencode",
        status: { state: "new" },
        createdAt: 1,
        updatedAt: 1,
      });
      store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
      if (id === "empty") continue;
      store.appendEvents(
        thread.id,
        [
          {
            type: "item.created",
            item: {
              id: ItemId.parse(id + "-input"),
              agentId: AgentId.parse("root"),
              type: "message",
              role: "user",
              synthetic: id === "synthetic-only",
              parts: [{ type: "text", text: "Hello" }],
              complete: true,
              raw: [],
              createdAt: 2,
            },
          },
        ],
        2,
      );
    }
    await store.close();
    // A pre-upgrade database: no message marker, and the older sent message has left the hot window.
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec("DELETE FROM upgrade_cleanup WHERE id='sent-message-v1'");
      legacy.exec("UPDATE threads SET client=json_remove(client,'$.hasSentMessage')");
      legacy.exec("DELETE FROM items WHERE thread_id='with-history'");
    } finally {
      legacy.close();
    }
    store = new Store(path);
    expect(store.getThread(ThreadId.parse("empty"))?.hasSentMessage).toBe(false);
    expect(store.getThread(ThreadId.parse("synthetic-only"))?.hasSentMessage).toBe(false);
    expect(store.getThread(ThreadId.parse("with-history"))?.hasSentMessage).toBe(true);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
