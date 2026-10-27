import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  Command,
  Project,
  Thread,
  ThreadId,
  type CommandPayload,
  type WorkspaceChanged,
} from "@ace/protocol";
import { emptyChatGraceMs } from "./chat-projects.ts";
import { findProjects } from "./agent-control/projects.ts";
import { Projects } from "./projects.ts";
import { Store } from "./store.ts";

async function chatFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-chats-test-")));
  const chatsRoot = join(root, "data", "chats");
  let clock = 1000;
  let ids = 0;
  const store = new Store(join(root, "events.sqlite"), undefined, { now: () => clock });
  const projects = new Projects(store, () => clock, {
    home: root,
    roots: async () => [join(root, "home")],
    chatsRoot,
    chatId: () => `chat-${++ids}`,
  });
  let sequence = 0;
  const changes: WorkspaceChanged[] = [];
  const stop = projects.subscribe((change) => changes.push(change));
  return {
    root,
    chatsRoot,
    store,
    projects,
    changes,
    advance: (ms: number) => (clock += ms),
    command: (payload: CommandPayload) =>
      projects.execute(Command.parse({ id: `command-${++sequence}`, deviceId: "owner", payload })),
    async chat() {
      const result = await this.command({ type: "workspace.chat.create" });
      return Project.parse(result.workspace);
    },
    thread(id: string, project: Project) {
      const thread = Thread.parse({
        id,
        workspaceId: project.id,
        title: "Chat",
        provider: "codex",
        status: { state: "done" },
        details: { workspace: project },
        createdAt: clock,
        updatedAt: clock,
      });
      store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    },
    delete(id: string) {
      store.appendEvents(ThreadId.parse(id), [
        { type: "thread.client.updated", changes: { deletedAt: clock } },
      ]);
    },
    async close() {
      stop();
      await projects.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("starting a chat makes a fresh empty folder for it, hidden from project lists", async () => {
  const f = await chatFixture();
  try {
    const first = await f.chat();
    const second = await f.chat();
    expect(first).toMatchObject({ kind: "chat", path: join(f.chatsRoot, "chat-1") });
    expect(second.path).not.toBe(first.path);
    expect(dirname(second.path)).toBe(f.chatsRoot);
    expect(await readdir(first.path)).toEqual([]);
    // Clients learn of it, kind and all, so they can tell chats from projects.
    expect(f.changes).toMatchObject([
      { change: "added", workspace: { id: first.id, kind: "chat" } },
      { change: "added", workspace: { id: second.id, kind: "chat" } },
    ]);
    expect(f.projects.catalog.recent(100)).toEqual([]);
    expect(findProjects(f.store, "", 100)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("deleting a chat's last thread removes its folder and its hidden project", async () => {
  const f = await chatFixture();
  try {
    const chat = await f.chat();
    f.thread("thread-a", chat);
    f.thread("thread-b", chat);
    await writeFile(join(chat.path, "notes.md"), "agent wrote this");
    f.delete("thread-a");
    await f.projects.ready;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await exists(join(chat.path, "notes.md"))).toBe(true);
    f.delete("thread-b");
    await expect.poll(() => exists(chat.path)).toBe(false);
    expect(f.changes.at(-1)).toEqual({
      type: "workspace.changed",
      change: "removed",
      workspaceId: chat.id,
    });
  } finally {
    await f.close();
  }
});

test("a chat that has not started its thread yet survives the grace period only", async () => {
  const f = await chatFixture();
  try {
    const chat = await f.chat();
    await f.projects.ready;
    // Another chat's deletion triggers a sweep; the young empty one stays.
    const other = await f.chat();
    f.thread("other-thread", other);
    f.delete("other-thread");
    await expect.poll(() => exists(other.path)).toBe(false);
    expect(await exists(chat.path)).toBe(true);
    f.advance(emptyChatGraceMs);
    const later = await f.chat();
    f.thread("later-thread", later);
    f.delete("later-thread");
    await expect.poll(() => exists(chat.path)).toBe(false);
  } finally {
    await f.close();
  }
});

test("a chat's hidden project can't be renamed, edited or removed like a project", async () => {
  const f = await chatFixture();
  try {
    const chat = await f.chat();
    expect(
      await f.command({ type: "workspace.rename", workspaceId: chat.id, name: "Renamed" }),
    ).toMatchObject({ ok: false, error: "chat_project" });
    expect(
      await f.command({ type: "workspace.remove", workspaceId: chat.id, stopRunning: false }),
    ).toMatchObject({
      ok: false,
      error: "chat_project",
    });
    expect(await exists(chat.path)).toBe(true);
  } finally {
    await f.close();
  }
});
